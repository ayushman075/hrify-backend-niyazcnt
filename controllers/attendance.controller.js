/**
 * attendance.controller.js
 *
 * All date work is IST-first:
 * - "date" stored in MongoDB is always midnight IST (= prev-day 18:30 UTC)
 * - month / week strings are derived from IST wall-clock, never from server local time
 * - Every query that filters on `date` uses midnightIST() so it matches stored values
 */

import Attendance   from '../models/attendance.model.js';
import { asyncHandler }  from '../utils/AsyncHandler.js';
import { ApiResponse }   from '../utils/ApiResponse.js';
import { ShiftRoster }   from '../models/shiftRoster.model.js';
import { Employee }      from '../models/employee.model.js';
import { OvertimeConfig } from '../models/overtimeConfig.model.js'; 
import { Overtime }       from '../models/overtime.model.js';     
import { Holiday }        from '../models/holidays.model.js'; 
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

// ─── Cache keys ───────────────────────────────────────────────────────────────

const CACHE_KEY = {
  PREFIX:      'attendance_',
  LIST_PREFIX: 'attendance_list_',
};

// ─── IST date helpers (no external dependencies, no server-tz assumptions) ────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const toIST = (date = new Date()) =>
  new Date(date.getTime() + date.getTimezoneOffset() * 60_000 + IST_OFFSET_MS);

const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

const toISTDateString = (input) => {
  const ist = toIST(new Date(input));
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const toISTMonthString = (input) => {
  const ist = toIST(new Date(input));
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

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

const convertTo24Hour = (timeStr) => {
  if (!timeStr) return "00:00:00";
  const cleanStr = timeStr.trim();
  
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

// ─── CORE CALCULATION ENGINE ──────────────────────────────────────────────────

/**
 * Returns an object containing the Attendance Percentage AND raw Overtime metrics.
 */
const calculateAttendanceStats = (post, sessionDate, punchInTime, punchOutTime, scheduledShift, isExplicitHoliday) => {
  const defaultStats = { attendancePercentage: 0, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
  if (!punchInTime || !punchOutTime) return defaultStats;

  const workedMinutes = Math.round((new Date(punchOutTime) - new Date(punchInTime)) / 60_000);
  if (workedMinutes <= 0) return defaultStats;


  const isWeekOff = scheduledShift?.isWeekOff || false;
  // Evaluate if the employee's payroll structure grants them holiday benefits
  const hasHolidayBenefits = ['Monthly_With_Sunday_Holiday', 'Weekly_With_Sunday_Holiday'].includes(post?.payrollType);
  const isHolidayOT = !isWeekOff && hasHolidayBenefits && isExplicitHoliday;

  // 1. NON-WORKING DAY OT SCENARIOS (Week-Off or Holiday)
  if (isWeekOff || isHolidayOT) {
      const baseMinutes = (post?.workingHour || 8) * 60;
      const triggerType = isHolidayOT ? 'HOLIDAY' : 'WEEK_OFF';

      return {
          attendancePercentage: 100, // Fully present for their OT day
          overtimeHours: parseFloat((workedMinutes / 60).toFixed(2)),
          overtimePercentage: parseFloat(((workedMinutes / baseMinutes) * 100).toFixed(2)),
          otTrigger: triggerType
      };
  }

  // 2. STRICTLY USE SCHEDULED SHIFT ROSTER
  let scheduledMinutes = 0;
  if (scheduledShift?.shiftId?.startTime && scheduledShift?.shiftId?.endTime) {
    const dateStr    = toISTDateString(sessionDate);
    const tStart     = convertTo24Hour(scheduledShift.shiftId.startTime);
    const tEnd       = convertTo24Hour(scheduledShift.shiftId.endTime);
    
    const shiftStart = new Date(`${dateStr}T${tStart}+05:30`);
    const shiftEnd   = new Date(`${dateStr}T${tEnd}+05:30`);
    const raw        = (shiftEnd - shiftStart) / 60_000;

    scheduledMinutes = raw < 0 ? raw + 24 * 60 : raw; 
  } 
 else if (post?.workingHour > 0) {
      scheduledMinutes = post.workingHour * 60;
    }
  if (scheduledMinutes <= 0) return defaultStats;

  // ── STANDARD OVERTIME & FULL ATTENDANCE SCENARIO ──
  if (workedMinutes >= scheduledMinutes) {
    const otMins = workedMinutes - scheduledMinutes;
    return {
      attendancePercentage: 100, 
      overtimeHours: parseFloat((otMins / 60).toFixed(2)),
      overtimePercentage: parseFloat(((otMins / scheduledMinutes) * 100).toFixed(2)),
      otTrigger: 'STANDARD'
    };
  }

  // ── LATE / SHORTFALL SCENARIO ──
  const shortfall  = scheduledMinutes - workedMinutes;
  const thresholds = Array.isArray(post?.lateAttendanceMetrics) ? post.lateAttendanceMetrics : [];
  const proratedPercentage = Math.round((workedMinutes / scheduledMinutes) * 100);

  if (!thresholds.length) {
    return { attendancePercentage: proratedPercentage, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
  }

  const sorted = [...thresholds].sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const applicable = sorted.find((m) => shortfall > m.allowedMinutes);

  if (!applicable) {
    return { attendancePercentage: 100, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
  }

  const cap = 100 - applicable.attendanceDeductionPercent;
  const finalPercentage = Math.min(proratedPercentage, cap);

  return { attendancePercentage: Math.max(0, finalPercentage), overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
};

// ─── OVERTIME RECONCILIATION HELPER ──────────────────────────────────────────

const syncOvertimeRecord = async (attendance, stats, otConfig) => {
  if (!otConfig) return; 

  const existingOt = await Overtime.findOne({ attendanceId: attendance._id });

  // Prevent modifying an OT record that has already been finalized by HR
  if (existingOt && existingOt.status !== 'Pending') {
    return;
  }

  const { overtimeHours, overtimePercentage, otTrigger } = stats;

  if (overtimeHours <= 0 || overtimePercentage <= 0) {
    if (existingOt) await existingOt.deleteOne();
    return;
  }

  const t = otConfig.thresholds;
  let credit = 0;
  let label = null;
  let roundedPercentage = 0; 

  // Evaluate Tier logic & aggressively clamp the percentage
  if (otConfig.configType === 'TIER_4') {
    if (overtimePercentage >= t.fullDayPercentage) { credit = 1.0; label = 'Full Day'; roundedPercentage = 100; }
    else if (overtimePercentage >= t.threeQuarterDayPercentage) { credit = 0.75; label = '3/4 Day'; roundedPercentage = 75; }
    else if (overtimePercentage >= t.halfDayPercentage) { credit = 0.5; label = 'Half Day'; roundedPercentage = 50; }
    else if (overtimePercentage >= t.quarterDayPercentage) { credit = 0.25; label = '1/4 Day'; roundedPercentage = 25; }
  } else {
    // TIER_2
    if (overtimePercentage >= t.fullDayPercentage) { credit = 1.0; label = 'Full Day'; roundedPercentage = 100; }
    else if (overtimePercentage >= t.halfDayPercentage) { credit = 0.5; label = 'Half Day'; roundedPercentage = 50; }
  }

  if (credit > 0) {
    // Generate intelligent predefined note for HR context
    let defaultNote = "Standard Overtime.";
    if (otTrigger === 'WEEK_OFF') defaultNote = "Auto-generated against Week-Off punch.";
    if (otTrigger === 'HOLIDAY') defaultNote = "Overtime against holiday.";

    await Overtime.findOneAndUpdate(
      { attendanceId: attendance._id },
      {
        $set: {
          employeeId: attendance.employeeId,
          attendanceId: attendance._id,
          date: attendance.date,
          month: attendance.month,
          week: attendance.week,
          overtimeHours,
          overtimePercentage: roundedPercentage,
          earnedCredit: credit,
          earnedCreditLabel: label,
          redeemedNotes: defaultNote 
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true } 
    );
  } else if (existingOt) {
    await existingOt.deleteOne();
  }
};

// ─── Cache invalidation helper ────────────────────────────────────────────────

const invalidateAttendanceCaches = async (attendanceId) => {
  const tasks = [
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ];
  if (attendanceId) tasks.push(removeCache(`${CACHE_KEY.PREFIX}${attendanceId}`));
  await Promise.allSettled(tasks); 
};

// ─── Controllers ─────────────────────────────────────────────────────────────

const createAttendance = asyncHandler(async (req, res) => {
  let { employeeId, date, punchInTime, punchOutTime, isLeave = false, leaveId } = req.body;

  if (!employeeId || !date || !(punchInTime || isLeave)) {
    return res.status(400).json(new ApiResponse(400, null, 'Missing required fields.', false));
  }

  if (punchInTime && punchOutTime) {
    const inMs  = new Date(punchInTime).getTime();
    const outMs = new Date(punchOutTime).getTime();
    if (isNaN(inMs) || isNaN(outMs)) return res.status(400).json(new ApiResponse(400, null, 'Invalid format', false));
    if (outMs <= inMs) return res.status(400).json(new ApiResponse(400, null, 'punchOutTime must be after punchInTime.', false));
  }

  const employee = await Employee.findById(employeeId).populate('post');
  if (!employee) return res.status(404).json(new ApiResponse(404, null, 'Employee not found', false));

  const dateStr   = toISTDateString(date); 
  const dateForDB = midnightIST(dateStr);  

  const scheduledShift = await ShiftRoster.findOne({ employeeId, date: dateForDB }).populate('shiftId');
  const isExplicitHoliday = await Holiday.exists({ date: dateForDB, isActive: true });

  const stats = isLeave
    ? { attendancePercentage: 100, overtimeHours: 0, overtimePercentage: 0, otTrigger: null }
    : calculateAttendanceStats(employee.post, dateForDB, punchInTime, punchOutTime ?? null, scheduledShift, !!isExplicitHoliday);

  const payload = {
    employeeId,
    date:                 dateForDB,
    punchInTime:          punchInTime  ? new Date(punchInTime)  : null,
    punchOutTime:         punchOutTime ? new Date(punchOutTime) : null,
    isLeave,
    leaveId:              leaveId ?? null,
    isWeekOff:            scheduledShift?.isWeekOff || false, 
    month:                toISTMonthString(date),
    week:                 getWeekId(date),
    attendancePercentage: stats.attendancePercentage,
  };

  const attendance = await Attendance.findOneAndUpdate(
    { employeeId, date: dateForDB },
    payload,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const otConfig = await OvertimeConfig.findOne();
  await syncOvertimeRecord(attendance, stats, otConfig);
  await invalidateAttendanceCaches(attendance._id);

  const isNew = attendance.createdAt?.getTime() === attendance.updatedAt?.getTime();
  return res.status(isNew ? 201 : 200).json(
    new ApiResponse(isNew ? 201 : 200, attendance, isNew ? 'Attendance created' : 'Attendance updated', true)
  );
});

const getAttendanceById = asyncHandler(async (req, res) => {
  const { employeeId, date } = req.query;
  if (!employeeId || !date) return res.status(400).json(new ApiResponse(400, {}, 'Required fields missing', false));

  const dateStr  = toISTDateString(date);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}one_emp${employeeId}_date${dateStr}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Attendance fetched from cache', true));

  const attendance = await Attendance.findOne({ employeeId, date: midnightIST(dateStr) }).populate('employeeId');
  if (!attendance) return res.status(404).json(new ApiResponse(404, {}, 'Attendance not found', false));

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Attendance fetched successfully', true));
});

const getAttendanceByMonth = asyncHandler(async (req, res) => {
  const { employeeId, month } = req.query;
  if (!employeeId || !month) return res.status(400).json(new ApiResponse(400, {}, 'Required fields missing', false));

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}emp${employeeId}_mon${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'From cache', true));

  const attendance = await Attendance.find({ employeeId, month }).populate('employeeId');
  if (!attendance.length) return res.status(404).json(new ApiResponse(404, [], 'Not found', false));

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Fetched', true));
});

const getAllAttendanceForMonth = asyncHandler(async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json(new ApiResponse(400, {}, 'month is required', false));

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_mon${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'From cache', true));

  const attendance = await Attendance.find({ month }).populate('employeeId');

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Fetched', true));
});

const updateAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { punchInTime, punchOutTime, date, isLeave, leaveId } = req.body;

  const attendance = await Attendance.findById(id);
  if (!attendance) return res.status(404).json(new ApiResponse(404, {}, 'Not found', false));

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

  if (attendance.punchInTime && attendance.punchOutTime) {
    if (attendance.punchOutTime <= attendance.punchInTime) {
      return res.status(400).json(new ApiResponse(400, {}, 'punchOutTime must be after punchInTime', false));
    }
  }

  const scheduledShift = await ShiftRoster.findOne({ employeeId: attendance.employeeId, date: attendance.date }).populate('shiftId');
  attendance.isWeekOff = scheduledShift?.isWeekOff || false;

  const employee = await Employee.findById(attendance.employeeId).populate('post');
  const isExplicitHoliday = await Holiday.exists({ date: attendance.date, isActive: true });

  let stats = { attendancePercentage: 100, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };

  if (!attendance.isLeave && employee?.post) {
    stats = calculateAttendanceStats(employee.post, attendance.date, attendance.punchInTime, attendance.punchOutTime ?? null, scheduledShift, !!isExplicitHoliday);
    attendance.attendancePercentage = stats.attendancePercentage;
  }

  await attendance.save();

  const otConfig = await OvertimeConfig.findOne();
  await syncOvertimeRecord(attendance, stats, otConfig);
  await invalidateAttendanceCaches(id);

  return res.status(200).json(new ApiResponse(200, attendance, 'Updated', true));
});

const deleteAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const attendance = await Attendance.findByIdAndDelete(id);
  if (!attendance) return res.status(404).json(new ApiResponse(404, {}, 'Not found', false));

  const existingOt = await Overtime.findOne({ attendanceId: id });
  if (existingOt && existingOt.status === 'Pending') await existingOt.deleteOne();

  await invalidateAttendanceCaches(id);
  return res.status(200).json(new ApiResponse(200, {}, 'Deleted', true));
});

const getAttendanceByWeek = asyncHandler(async (req, res) => {
  const { week, employeeId } = req.query;
  if (!week || !/^\d{4}$/.test(week)) return res.status(400).json(new ApiResponse(400, {}, 'Invalid week', false));

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}week${week}_emp${employeeId || 'all'}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'From cache', true));

  const query = { week, ...(employeeId && { employeeId }) };
  const attendance = await Attendance.find(query).populate('employeeId');

  if (!attendance.length) return res.status(404).json(new ApiResponse(404, [], 'Not found', false));

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Fetched', true));
});

const getAllAttendanceForWeek = asyncHandler(async (req, res) => {
  const { week } = req.query;
  if (!week || !/^\d{4}$/.test(week)) return res.status(400).json(new ApiResponse(400, {}, 'Invalid week', false));

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_week${week}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'From cache', true));

  const attendance = await Attendance.find({ week }).populate('employeeId');

  await setCache(cacheKey, attendance, 3600);
  return res.status(200).json(new ApiResponse(200, attendance, 'Fetched', true));
});

const bulkCreateAttendance = asyncHandler(async (req, res) => {
  const attendanceData = req.body;
  if (!Array.isArray(attendanceData) || !attendanceData.length) return res.status(400).json(new ApiResponse(400, {}, 'Invalid data', false));

  const otConfig = await OvertimeConfig.findOne();

  const rawIds = [...new Set(attendanceData.map((r) => String(r.employeeId)).filter(Boolean))];
  const employees = await Employee.find({ employeeId: { $in: rawIds } }).populate('post');
  const employeeMap = new Map(employees.map((e) => [String(e.employeeId), e]));

  const shiftKeys = attendanceData
    .filter((r) => r.date)
    .map((r) => ({ employeeDbId: employeeMap.get(String(r.employeeId))?._id, dateStr: toISTDateString(r.date) }))
    .filter((k) => k.employeeDbId);

  const shiftDates     = [...new Set(shiftKeys.map((k) => k.dateStr))].map(midnightIST);
  const shiftEmployees = [...new Set(shiftKeys.map((k) => String(k.employeeDbId)))];

  const shifts = await ShiftRoster.find({ employeeId: { $in: shiftEmployees }, date: { $in: shiftDates } }).populate('shiftId');
  const shiftCache = new Map(shifts.map((s) => [`${s.employeeId}|${toISTDateString(s.date)}`, s]));

  const holidays = await Holiday.find({ date: { $in: shiftDates }, isActive: true });
  const holidayCache = new Set(holidays.map(h => toISTDateString(h.date)));

  const created = [];
  const updated = [];
  const failed  = [];

  for (const record of attendanceData) {
    const { employeeId, date, punchInTime, punchOutTime, isLeave = false, leaveId } = record;
    try {
      if (!employeeId || !date || !(punchInTime || isLeave)) throw new Error('Missing fields');

      const employee = employeeMap.get(String(employeeId));
      if (!employee) throw new Error(`Employee ${employeeId} not found`);

      if (punchInTime && punchOutTime) {
        const inMs  = new Date(punchInTime).getTime();
        const outMs = new Date(punchOutTime).getTime();
        if (isNaN(inMs) || isNaN(outMs)) throw new Error('Invalid format');
        if (outMs <= inMs) throw new Error('punchOutTime must be after punchInTime');
      }

      const dateStr    = toISTDateString(date);
      const dateForDB  = midnightIST(dateStr);
      const shift      = shiftCache.get(`${employee._id}|${dateStr}`) ?? null;
      const isExplicitHoliday  = holidayCache.has(dateStr);

      const stats = isLeave
        ? { attendancePercentage: 100, overtimeHours: 0, overtimePercentage: 0, otTrigger: null }
        : calculateAttendanceStats(employee.post, dateForDB, punchInTime, punchOutTime ?? null, shift, isExplicitHoliday);

      const payload = {
        employeeId:  employee._id,
        date:        dateForDB,
        punchInTime:  punchInTime  ? new Date(punchInTime)  : null,
        punchOutTime: punchOutTime ? new Date(punchOutTime) : null,
        isLeave,
        leaveId:     leaveId ?? null,
        isWeekOff:   shift?.isWeekOff || false, 
        month:       toISTMonthString(date),
        week:        getWeekId(date),
        attendancePercentage: stats.attendancePercentage,
      };

      const existing = await Attendance.findOneAndUpdate(
        { employeeId: employee._id, date: dateForDB },
        payload,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await syncOvertimeRecord(existing, stats, otConfig);

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

  return res.status(201).json(new ApiResponse(201, { created, updated, failed }, 'Bulk processed', true));
});

const getFilteredAttendance = asyncHandler(async (req, res) => {
  const { sort = 'date', order = 'desc', page = 1, limit = 10 } = req.query;

  let filters = {};
  if (req.query.filters) {
    try { filters = typeof req.query.filters === 'string' ? JSON.parse(req.query.filters) : req.query.filters; } 
    catch { return res.status(400).json(new ApiResponse(400, null, 'Invalid filters JSON', false)); }
  }

  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 10);
  const filterKey = JSON.stringify(filters);
  const cacheKey  = `${CACHE_KEY.LIST_PREFIX}filter_p${pageNum}_l${limitNum}_s${sort}_o${order}_f${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'From cache', true));

  const query = {};

  if (filters.site) {
    const siteEmployees = await Employee.find({ site: filters.site }).select('_id');
    const siteIds = siteEmployees.map((e) => e._id);
    if (filters.employeeId) {
      const inSite = siteIds.some((id) => id.toString() === filters.employeeId.toString());
      query.employeeId = inSite ? filters.employeeId : { $in: [] };
    } else { query.employeeId = { $in: siteIds }; }
  } else if (filters.employeeId) { query.employeeId = filters.employeeId; }

  if (filters.month)  query.month = filters.month;
  if (filters.week)   query.week  = filters.week;
  if (filters.isLeave !== undefined) query.isLeave = filters.isLeave === true || filters.isLeave === 'true';

  if (Array.isArray(filters.dateRange) && filters.dateRange.length === 2) {
    const [from, to] = filters.dateRange;
    const fromDate = midnightIST(toISTDateString(from));
    const toDate   = new Date(midnightIST(toISTDateString(to)).getTime() + 86_400_000 - 1);
    query.date = { $gte: fromDate, $lte: toDate };
  }

  const [attendance, total] = await Promise.all([
    Attendance.find(query)
      .populate({ path: 'employeeId', populate: { path: 'site', select: 'siteName' } })
      .sort({ [sort]: order === 'desc' ? -1 : 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Attendance.countDocuments(query),
  ]);

  const payload = { success: true, attendances: attendance, totalPages: Math.ceil(total / limitNum), currentPage: pageNum, totalCount: total };
  await setCache(cacheKey, payload, 3600);

  return res.status(200).json(new ApiResponse(200, payload, 'Fetched', true));
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