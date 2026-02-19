/**
 * attendance.controller.js
 *
 * All date work is IST-first:
 * - "date" stored in MongoDB is always midnight IST (= prev-day 18:30 UTC)
 * - month / week strings are derived from IST wall-clock, never from server local time
 * - Every query that filters on `date` uses midnightIST() so it matches stored values
 */

import Attendance   from '../models/attendance.model.js';
import Matrices     from '../models/attendanceMatrices.model.js';
import { asyncHandler }  from '../utils/AsyncHandler.js';
import { ApiResponse }   from '../utils/ApiResponse.js';
import { ShiftRoster }   from '../models/shiftRoster.model.js';
import { Employee }      from '../models/employee.model.js';
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

// ─── Cache keys ───────────────────────────────────────────────────────────────

const CACHE_KEY = {
  PREFIX:      'attendance_',
  LIST_PREFIX: 'attendance_list_',
};

// ─── IST date helpers (no external dependencies, no server-tz assumptions) ────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Returns a Date whose UTC fields read as the IST wall-clock time of `date`. */
const toIST = (date = new Date()) =>
  new Date(date.getTime() + date.getTimezoneOffset() * 60_000 + IST_OFFSET_MS);

/**
 * Returns a Date representing 00:00:00 IST for `dateStr` ("YYYY-MM-DD").
 * Stored in MongoDB this appears as the previous evening at 18:30 UTC, which is
 * correct and consistent throughout the codebase.
 */
const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

/**
 * Accepts anything Date() can parse and returns "YYYY-MM-DD" evaluated in IST.
 * Safe for strings like "2025-07-09" (UTC midnight) and actual Date objects.
 */
const toISTDateString = (input) => {
  const ist = toIST(new Date(input));
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** "YYYY-MM" evaluated in IST. */
const toISTMonthString = (input) => {
  const ist = toIST(new Date(input));
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * ISO week number as "WWYY" (e.g. week 2 of 2025 → "0225"), IST-aware.
 * Exported so other modules (worker, cron) can share the same implementation.
 */
export const getWeekId = (input) => {
  const ist = toIST(new Date(input));
  const thursday = new Date(ist);
  thursday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  const yy = String(thursday.getUTCFullYear()).slice(-2);
  return String(weekNo).padStart(2, '0') + yy;
};

// ─── Time Parsing Helper ──────────────────────────────────────────────────────

/**
 * Converts "08:00 AM" or "05:00 PM" to standard 24-hour "08:00:00" / "17:00:00".
 * Prevents "Invalid Date" errors when passed into JavaScript's Date constructor.
 */
const convertTo24Hour = (timeStr) => {
  if (!timeStr) return "00:00:00";
  const cleanStr = timeStr.trim();
  
  // If it's already 24-hour format (no AM/PM), just ensure seconds exist
  if (!cleanStr.toLowerCase().includes('m')) {
    return cleanStr.length === 5 ? `${cleanStr}:00` : cleanStr;
  }

  const [time, modifier] = cleanStr.split(' ');
  let [hours, minutes] = time.split(':');
  hours = parseInt(hours, 10);

  if (modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
  if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;

  return `${String(hours).padStart(2, '0')}:${minutes}:00`;
};

// ─── Attendance percentage ────────────────────────────────────────────────────

/**
 * Returns 0–100 (capped at 100; overtime does not bonus beyond full marks).
 */
const calculateAttendancePercentage = (post, sessionDate, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchInTime || !punchOutTime) return 0;

  // ── Scheduled minutes ────────────────────────────────────────────────────
  let scheduledMinutes = 0;

  if (scheduledShift?.shiftId?.startTime && scheduledShift?.shiftId?.endTime) {
    const dateStr    = toISTDateString(sessionDate);
    
    // Parse the DB's AM/PM strings into 24-hour format BEFORE creating the Date
    const tStart     = convertTo24Hour(scheduledShift.shiftId.startTime);
    const tEnd       = convertTo24Hour(scheduledShift.shiftId.endTime);
    
    const shiftStart = new Date(`${dateStr}T${tStart}+05:30`);
    const shiftEnd   = new Date(`${dateStr}T${tEnd}+05:30`);
    const raw        = (shiftEnd - shiftStart) / 60_000;

    console.log(shiftStart)
    console.log(shiftEnd)
    
    // Handle overnight shift definitions (e.g. 20:00 → 08:00 → raw < 0)
    scheduledMinutes = raw < 0 ? raw + 24 * 60 : raw;
    console.log(scheduledMinutes)
  } else if (post?.workingHour > 0) {
    scheduledMinutes = post.workingHour * 60;
    console.log(scheduledMinutes+"wh")
  }

  if (scheduledMinutes <= 0) return 0;

  // ── Worked minutes ───────────────────────────────────────────────────────
  const workedMinutes = Math.round((new Date(punchOutTime) - new Date(punchInTime)) / 60_000);
  if (workedMinutes <= 0) return 0;

  // ── Score ────────────────────────────────────────────────────────────────
  if (workedMinutes >= scheduledMinutes) {
    return Math.max(100, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  const shortfall   = scheduledMinutes - workedMinutes;
  const thresholds  = Array.isArray(post?.lateAttendanceMetrics) ? post.lateAttendanceMetrics : [];

  if (!thresholds.length) {
    return Math.max(0, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  const sorted     = [...thresholds].sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const applicable = sorted.find((m) => shortfall > m.allowedMinutes);

  if (!applicable) return 100; // within most lenient threshold → full marks

  return Math.max(0, Math.round(100 - applicable.attendanceDeductionPercent));
};

// ─── Cache invalidation helper ────────────────────────────────────────────────

const invalidateAttendanceCaches = async (attendanceId) => {
  const tasks = [
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ];
  if (attendanceId) tasks.push(removeCache(`${CACHE_KEY.PREFIX}${attendanceId}`));
  await Promise.allSettled(tasks); // never let cache errors bubble up
};

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /attendance
 * Create or update a single attendance record.
 * Uses upsert to avoid race conditions on concurrent requests.
 */
const createAttendance = asyncHandler(async (req, res) => {
  let { employeeId, date, punchInTime, punchOutTime, isLeave = false, leaveId } = req.body;

  if (!employeeId || !date || !(punchInTime || isLeave)) {
    return res.status(400).json(new ApiResponse(400, null, 'Missing required fields: employeeId, date, and punchInTime (or isLeave)', false));
  }

  // Validate punch times — overnight shift: punchOut may be next calendar day,
  // but it must always be AFTER punchIn. Reject bad data with a clear message.
  if (punchInTime && punchOutTime) {
    const inMs  = new Date(punchInTime).getTime();
    const outMs = new Date(punchOutTime).getTime();
    if (isNaN(inMs) || isNaN(outMs)) {
      return res.status(400).json(new ApiResponse(400, null, 'Invalid punchInTime or punchOutTime format', false));
    }
    if (outMs <= inMs) {
      return res.status(400).json(
        new ApiResponse(400, null, 'punchOutTime must be after punchInTime. For overnight shifts supply the actual next-day timestamp.', false)
      );
    }
  }

  const employee = await Employee.findById(employeeId).populate('post');
  if (!employee) {
    return res.status(404).json(new ApiResponse(404, null, 'Employee not found', false));
  }

  // All date derivations go through IST helpers
  const dateStr   = toISTDateString(date);   // canonical "YYYY-MM-DD" in IST
  const dateForDB = midnightIST(dateStr);     // consistent storage value

  const scheduledShift = await ShiftRoster.findOne({
    employeeId,
    date: midnightIST(dateStr),              // must match how shifts are stored
  }).populate('shiftId');

  const attendancePercentage = isLeave
    ? 100
    : calculateAttendancePercentage(employee.post, dateForDB, punchInTime, punchOutTime ?? null, scheduledShift);

  const payload = {
    employeeId,
    date:                 dateForDB,
    punchInTime:          punchInTime  ? new Date(punchInTime)  : null,
    punchOutTime:         punchOutTime ? new Date(punchOutTime) : null,
    isLeave,
    leaveId:              leaveId ?? null,
    month:                toISTMonthString(date),
    week:                 getWeekId(date),
    attendancePercentage,
  };

  // Upsert on (employeeId, date) — atomic, no race condition
  const attendance = await Attendance.findOneAndUpdate(
    { employeeId, date: dateForDB },
    payload,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await invalidateAttendanceCaches(attendance._id);

  const isNew = attendance.createdAt?.getTime() === attendance.updatedAt?.getTime();
  return res.status(isNew ? 201 : 200).json(
    new ApiResponse(isNew ? 201 : 200, attendance, isNew ? 'Attendance created successfully' : 'Attendance updated successfully', true)
  );
});

/**
 * GET /attendance?employeeId=&date=
 */
const getAttendanceById = asyncHandler(async (req, res) => {
  const { employeeId, date } = req.query;

  if (!employeeId || !date) {
    return res.status(400).json(new ApiResponse(400, {}, 'employeeId and date are required', false));
  }

  const dateStr  = toISTDateString(date);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}one_emp${employeeId}_date${dateStr}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Attendance fetched from cache', true));

  // Query uses midnightIST() to match the stored value exactly
  const attendance = await Attendance.findOne({ employeeId, date: midnightIST(dateStr) })
    .populate('employeeId');

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, 'Attendance not found', false));
  }

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance fetched successfully', true));
});

/**
 * GET /attendance/month?employeeId=&month=YYYY-MM
 */
const getAttendanceByMonth = asyncHandler(async (req, res) => {
  const { employeeId, month } = req.query;

  if (!employeeId || !month) {
    return res.status(400).json(new ApiResponse(400, {}, 'employeeId and month are required', false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}emp${employeeId}_mon${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Attendance records from cache', true));

  const attendance = await Attendance.find({ employeeId, month }).populate('employeeId');

  // Attendance.find() returns [] not null — check length
  if (!attendance.length) {
    return res.status(404).json(new ApiResponse(404, [], 'No attendance records found for this employee in the given month', false));
  }

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance records fetched successfully', true));
});

/**
 * GET /attendance/all-month?month=YYYY-MM
 */
const getAllAttendanceForMonth = asyncHandler(async (req, res) => {
  const { month } = req.query;

  if (!month) {
    return res.status(400).json(new ApiResponse(400, {}, 'month is required', false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_mon${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Attendance records from cache', true));

  const attendance = await Attendance.find({ month }).populate('employeeId');

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance records for the month fetched successfully', true));
});

/**
 * PATCH /attendance/:id
 * Partial update — recalculates month, week, and attendancePercentage when date changes.
 */
const updateAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { punchInTime, punchOutTime, date, isLeave, leaveId } = req.body;

  const attendance = await Attendance.findById(id);
  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, 'Attendance not found', false));
  }

  if (punchInTime)              attendance.punchInTime  = new Date(punchInTime);
  if (punchOutTime)             attendance.punchOutTime = new Date(punchOutTime);
  if (isLeave !== undefined)    attendance.isLeave      = isLeave;
  if (leaveId)                  attendance.leaveId      = leaveId;

  if (date) {
    const dateStr       = toISTDateString(date);
    attendance.date     = midnightIST(dateStr);
    attendance.week     = getWeekId(date);
    attendance.month    = toISTMonthString(date); 
  }

  // Validate punch order after applying updates
  if (attendance.punchInTime && attendance.punchOutTime) {
    if (attendance.punchOutTime <= attendance.punchInTime) {
      return res.status(400).json(
        new ApiResponse(400, {}, 'punchOutTime must be after punchInTime', false)
      );
    }
  }

  const scheduledShift = await ShiftRoster.findOne({
    employeeId: attendance.employeeId,
    date:       attendance.date,             // already midnightIST after update above
  }).populate('shiftId');

  const employee = await Employee.findById(attendance.employeeId).populate('post');

  if (!attendance.isLeave && employee?.post) {
    attendance.attendancePercentage = calculateAttendancePercentage(
      employee.post,
      attendance.date,
      attendance.punchInTime,
      attendance.punchOutTime ?? null,
      scheduledShift,
    );
  }

  await attendance.save();
  await invalidateAttendanceCaches(id);

  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance updated successfully', true));
});

/**
 * DELETE /attendance/:id
 */
const deleteAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const attendance = await Attendance.findByIdAndDelete(id);
  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, 'Attendance not found', false));
  }

  await invalidateAttendanceCaches(id);
  return res.status(200).json(new ApiResponse(200, {}, 'Attendance deleted successfully', true));
});

/**
 * GET /attendance/week?week=WWYY&employeeId= (optional)
 */
const getAttendanceByWeek = asyncHandler(async (req, res) => {
  const { week, employeeId } = req.query;

  if (!week || !/^\d{4}$/.test(week)) {
    return res.status(400).json(new ApiResponse(400, {}, 'Valid week identifier (WWYY) is required, e.g. "0225"', false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}week${week}_emp${employeeId || 'all'}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Attendance records from cache', true));

  const query = { week, ...(employeeId && { employeeId }) };
  const attendance = await Attendance.find(query).populate('employeeId');

  if (!attendance.length) {
    return res.status(404).json(new ApiResponse(404, [], 'No attendance records found for this week', false));
  }

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance records for the week fetched successfully', true));
});

/**
 * GET /attendance/all-week?week=WWYY
 */
const getAllAttendanceForWeek = asyncHandler(async (req, res) => {
  const { week } = req.query;

  if (!week || !/^\d{4}$/.test(week)) {
    return res.status(400).json(new ApiResponse(400, {}, 'Valid week identifier (WWYY) is required, e.g. "0225"', false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_week${week}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Attendance records from cache', true));

  const attendance = await Attendance.find({ week }).populate('employeeId');

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance records for the week fetched successfully', true));
});

/**
 * POST /attendance/bulk
 */
const bulkCreateAttendance = asyncHandler(async (req, res) => {
  const attendanceData = req.body;

  if (!Array.isArray(attendanceData) || !attendanceData.length) {
    return res.status(400).json(new ApiResponse(400, {}, 'Invalid or empty attendance data', false));
  }

  // ── Pre-fetch employees in one query ─────────────────────────────────────
  const rawIds = [...new Set(attendanceData.map((r) => String(r.employeeId)).filter(Boolean))];
  const employees = await Employee.find({ employeeId: { $in: rawIds } }).populate('post');
  const employeeMap = new Map(employees.map((e) => [String(e.employeeId), e]));

  // ── Pre-fetch all required shifts in one query ────────────────────────────
  const shiftKeys = attendanceData
    .filter((r) => r.date)
    .map((r) => ({ employeeDbId: employeeMap.get(String(r.employeeId))?._id, dateStr: toISTDateString(r.date) }))
    .filter((k) => k.employeeDbId);

  const shiftDates     = [...new Set(shiftKeys.map((k) => k.dateStr))].map(midnightIST);
  const shiftEmployees = [...new Set(shiftKeys.map((k) => String(k.employeeDbId)))];

  const shifts = await ShiftRoster.find({
    employeeId: { $in: shiftEmployees },
    date:       { $in: shiftDates },
  }).populate('shiftId');

  // shiftCache keyed by "employeeDbId|dateStr"
  const shiftCache = new Map(shifts.map((s) => [`${s.employeeId}|${toISTDateString(s.date)}`, s]));

  // ── Process records ───────────────────────────────────────────────────────
  const created = [];
  const updated = [];
  const failed  = [];

  for (const record of attendanceData) {
    const { employeeId, date, punchInTime, punchOutTime, isLeave = false, leaveId } = record;
    try {
      if (!employeeId || !date || !(punchInTime || isLeave)) {
        throw new Error('Missing required fields: employeeId, date, and punchInTime (or isLeave)');
      }

      const employee = employeeMap.get(String(employeeId));
      if (!employee) throw new Error(`Employee ${employeeId} not found`);

      // Validate punch order — punchOut on next calendar day IS valid for overnight
      if (punchInTime && punchOutTime) {
        const inMs  = new Date(punchInTime).getTime();
        const outMs = new Date(punchOutTime).getTime();
        if (isNaN(inMs) || isNaN(outMs)) throw new Error('Invalid punchInTime or punchOutTime format');
        if (outMs <= inMs) throw new Error('punchOutTime must be after punchInTime (supply actual next-day timestamp for overnight shifts)');
      }

      const dateStr    = toISTDateString(date);
      const dateForDB  = midnightIST(dateStr);
      const shift      = shiftCache.get(`${employee._id}|${dateStr}`) ?? null;

      const attendancePercentage = isLeave
        ? 100
        : calculateAttendancePercentage(
            employee.post,
            dateForDB,
            punchInTime  ? new Date(punchInTime)  : null,
            punchOutTime ? new Date(punchOutTime) : null,
            shift,
          );

      const payload = {
        employeeId:  employee._id,
        date:        dateForDB,
        punchInTime:  punchInTime  ? new Date(punchInTime)  : null,
        punchOutTime: punchOutTime ? new Date(punchOutTime) : null,
        isLeave,
        leaveId:     leaveId ?? null,
        month:       toISTMonthString(date),
        week:        getWeekId(date),
        attendancePercentage,
      };

      const existing = await Attendance.findOneAndUpdate(
        { employeeId: employee._id, date: dateForDB },
        payload,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const wasNew = existing.createdAt?.getTime() === existing.updatedAt?.getTime();
      (wasNew ? created : updated).push(existing);

      await removeCache(`${CACHE_KEY.PREFIX}${existing._id}`);

    } catch (err) {
      failed.push({ record, error: err.message });
    }
  }

  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(201).json(
    new ApiResponse(201, { created, updated, failed }, 'Bulk attendance processing completed', true)
  );
});

/**
 * GET /attendance/filter
 */
const getFilteredAttendance = asyncHandler(async (req, res) => {
  const {
    sort   = 'date',
    order  = 'desc',
    page   = 1,
    limit  = 10,
  } = req.query;

  let filters = {};
  if (req.query.filters) {
    try {
      filters = typeof req.query.filters === 'string'
        ? JSON.parse(req.query.filters)
        : req.query.filters;
    } catch {
      return res.status(400).json(new ApiResponse(400, null, 'Invalid filters JSON', false));
    }
  }

  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 10);

  const filterKey = JSON.stringify(filters);
  const cacheKey  = `${CACHE_KEY.LIST_PREFIX}filter_p${pageNum}_l${limitNum}_s${sort}_o${order}_f${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json(new ApiResponse(200, cached, 'Attendance retrieved from cache', true));
  }

  const query = {};

  if (filters.site) {
    const siteEmployees = await Employee.find({ site: filters.site }).select('_id');
    const siteIds = siteEmployees.map((e) => e._id);

    if (filters.employeeId) {
      const inSite = siteIds.some((id) => id.toString() === filters.employeeId.toString());
      query.employeeId = inSite ? filters.employeeId : { $in: [] };
    } else {
      query.employeeId = { $in: siteIds };
    }
  } else if (filters.employeeId) {
    query.employeeId = filters.employeeId;
  }

  if (filters.month)  query.month = filters.month;
  if (filters.week)   query.week  = filters.week;

  if (filters.isLeave !== undefined) {
    query.isLeave = filters.isLeave === true || filters.isLeave === 'true';
  }

  if (Array.isArray(filters.dateRange) && filters.dateRange.length === 2) {
    const [from, to] = filters.dateRange;
    const fromDate = midnightIST(toISTDateString(from));
    const toDate   = new Date(midnightIST(toISTDateString(to)).getTime() + 86_400_000 - 1);
    query.date = { $gte: fromDate, $lte: toDate };
  }

  const [attendance, total] = await Promise.all([
    Attendance.find(query)
      .populate({
        path:     'employeeId',
        populate: { path: 'site', select: 'siteName' },
      })
      .sort({ [sort]: order === 'desc' ? -1 : 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Attendance.countDocuments(query),
  ]);

  const payload = {
    success:     true,
    attendances: attendance,
    totalPages:  Math.ceil(total / limitNum),
    currentPage: pageNum,
    totalCount:  total,
  };

  await setCache(cacheKey, payload, 3600);

  return res.status(200).json(new ApiResponse(200, payload, 'Attendance retrieved successfully', true));
});

export {
  createAttendance,
  getAttendanceById,
  getAttendanceByMonth,
  getAllAttendanceForMonth,
  updateAttendance,
  deleteAttendance,
  bulkCreateAttendance,
  getFilteredAttendance,
  getAttendanceByWeek,
  getAllAttendanceForWeek,
};