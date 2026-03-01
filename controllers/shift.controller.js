/**
 * shift.controller.js
 * * Manages Shifts and Rosters with strict IST handling and secure Attendance syncing.
 */

import { Shift }         from '../models/shift.model.js';
import { ShiftRoster }   from '../models/shiftRoster.model.js';
import { RosterControl } from '../models/shiftRosterControl.model.js';
import { Post }          from '../models/post.model.js';
import Attendance        from '../models/attendance.model.js';
import { ApiResponse }   from '../utils/ApiResponse.js';
import { asyncHandler }  from '../utils/AsyncHandler.js';
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';

// ─── Cache keys ───────────────────────────────────────────────────────────────

const CACHE_KEY = {
  SHIFT_PREFIX:  'shift_',
  SHIFT_LIST:    'shift_list_',
  ROSTER_ENTRY:  'roster_entry_',
  ROSTER_POST:   'roster_post_',
  ROSTER_EMP:    'roster_emp_',
};

// ─── IST date helpers (zero external dependencies) ───────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const toIST = (date = new Date()) =>
  new Date(date.getTime() + date.getTimezoneOffset() * 60_000 + IST_OFFSET_MS);

const toISTDateString = (input) => {
  const ist = toIST(new Date(input));
  return [
    ist.getUTCFullYear(),
    String(ist.getUTCMonth() + 1).padStart(2, '0'),
    String(ist.getUTCDate()).padStart(2, '0'),
  ].join('-');
};

const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

const toISTMonthString = (input) => {
  const ist = toIST(new Date(input));
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

// Helper required for syncing with Attendance collection
const getWeekId = (input) => {
  const ist = toIST(new Date(input));
  const thursday = new Date(ist);
  thursday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  const yy = String(thursday.getUTCFullYear()).slice(-2);
  return String(weekNo).padStart(2, '0') + yy;
};

// ─── Input helpers ────────────────────────────────────────────────────────────

const MONTH_REGEX = /^\d{4}-\d{2}$/;
const validateMonth = (month) =>
  MONTH_REGEX.test(month) ? null : 'month must be in "YYYY-MM" format (e.g. "2025-07")';

const tryParseJSON = (str) => {
  if (typeof str !== 'string') return [str, null];
  try { return [JSON.parse(str), null]; }
  catch { return [null, 'Invalid JSON in filters parameter']; }
};

const safeInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return isNaN(n) || n < 1 ? fallback : n;
};

// ─── Cache invalidation helper ────────────────────────────────────────────────

const invalidateRosterCaches = async (employeeId, post, month, rosterId) => {
  const tasks = [];
  if (rosterId)            tasks.push(removeCache(`${CACHE_KEY.ROSTER_ENTRY}${rosterId}`));
  if (post   && month)     tasks.push(removeCache(`${CACHE_KEY.ROSTER_POST}${post}_${month}`));
  if (employeeId && month) tasks.push(removeCache(`${CACHE_KEY.ROSTER_EMP}${employeeId}_${month}`));
  await Promise.allSettled(tasks);
};

// ══════════════════════════════════════════════════════════════════════════════
// SHIFT CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const createShift = asyncHandler(async (req, res) => {
  const { name, startTime, endTime, post } = req.body;

  if (!name || !startTime || !endTime || !post) {
    return res.status(400).json(new ApiResponse(400, {}, 'All fields are required: name, startTime, endTime, post', false));
  }

  const shift = await Shift.create({ name, startTime, endTime, post });
  await removeCachePattern(`${CACHE_KEY.SHIFT_LIST}*`);

  return res.status(201).json(new ApiResponse(201, shift, 'Shift created successfully', true));
});

export const getAllShifts = asyncHandler(async (req, res) => {
  const { sort = 'createdAt', order = 'desc' } = req.query;

  const page  = safeInt(req.query.page,  1);
  const limit = safeInt(req.query.limit, 10);

  let filters = {};
  if (req.query.filters) {
    const [parsed, err] = tryParseJSON(req.query.filters);
    if (err) return res.status(400).json(new ApiResponse(400, {}, err, false));
    filters = parsed;
  }

  const filterKey = JSON.stringify(filters);
  const cacheKey  = `${CACHE_KEY.SHIFT_LIST}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Shifts retrieved from cache', true));

  const query = {};
  if (filters.name)      query.name      = { $regex: filters.name,      $options: 'i' };
  if (filters.startTime) query.startTime = { $regex: filters.startTime, $options: 'i' };
  if (filters.endTime)   query.endTime   = { $regex: filters.endTime,   $options: 'i' };
  if (filters.post)      query.post      = filters.post;

  const [shifts, totalShifts] = await Promise.all([
    Shift.find(query)
      .populate('post', 'title')
      .sort({ [sort]: order === 'desc' ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Shift.countDocuments(query),
  ]);

  const payload = {
    success: true,
    totalShifts,
    totalPages:  Math.ceil(totalShifts / limit),
    currentPage: page,
    shifts,
  };

  await setCache(cacheKey, payload, 3600);
  return res.status(200).json(new ApiResponse(200, payload, 'Shifts retrieved successfully', true));
});

export const getShiftById = asyncHandler(async (req, res) => {
  const { shiftId } = req.params;

  if (!shiftId) {
    return res.status(400).json(new ApiResponse(400, {}, 'Shift ID is required', false));
  }

  const cacheKey = `${CACHE_KEY.SHIFT_PREFIX}${shiftId}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Shift retrieved from cache', true));

  const shift = await Shift.findById(shiftId).populate('post', 'title');
  if (!shift) return res.status(404).json(new ApiResponse(404, {}, 'Shift not found', false));

  await setCache(cacheKey, shift, 3600);
  return res.status(200).json(new ApiResponse(200, shift, 'Shift retrieved successfully', true));
});

export const deleteShift = asyncHandler(async (req, res) => {
  const { shiftId } = req.params;

  if (!shiftId) {
    return res.status(400).json(new ApiResponse(400, {}, 'Shift ID is required', false));
  }

  const isAssigned = await ShiftRoster.findOne({ shiftId });
  if (isAssigned) {
    return res.status(409).json(
      new ApiResponse(409, {}, 'Shift cannot be deleted — it is assigned to one or more rosters', false)
    );
  }

  const deleted = await Shift.findByIdAndDelete(shiftId);
  if (!deleted) return res.status(404).json(new ApiResponse(404, {}, 'Shift not found', false));

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.SHIFT_PREFIX}${shiftId}`),
    removeCachePattern(`${CACHE_KEY.SHIFT_LIST}*`),
  ]);

  return res.status(200).json(new ApiResponse(200, deleted, 'Shift deleted successfully', true));
});

// ══════════════════════════════════════════════════════════════════════════════
// ROSTER CONTROLLERS WITH WEEK-OFF SUPPORT
// ══════════════════════════════════════════════════════════════════════════════

export const createShiftRoster = asyncHandler(async (req, res) => {
  const { employeeId, shiftId, date, post, isWeekOff = false } = req.body;

  if (!employeeId || !date || !post) {
    return res.status(400).json(
      new ApiResponse(400, {}, 'employeeId, date, and post are required', false)
    );
  }

  if (!isWeekOff && !shiftId) {
      return res.status(400).json(
        new ApiResponse(400, {}, 'shiftId is required if it is not a Week Off', false)
      );
  }

  if (isNaN(new Date(date).getTime())) {
    return res.status(400).json(new ApiResponse(400, {}, 'Invalid date format', false));
  }

  const dateStr   = toISTDateString(date); 
  const dateForDB = midnightIST(dateStr);    
  const month     = toISTMonthString(date); 
  const week      = getWeekId(date); // Generate week string (e.g. '0225')

  // 1. Validate Week-Off STRICTLY ON A WEEKLY BASIS
  if (isWeekOff) {
      const employeePost = await Post.findById(post);
      if (!employeePost) return res.status(404).json(new ApiResponse(404, {}, 'Post not found', false));


      // Count existing week-offs for this SPECIFIC WEEK only
      const currentWeekOffCount = await ShiftRoster.countDocuments({
          employeeId,
          week, // Filter by the specific week (e.g., week 4 of 2026)
          isWeekOff: true,
          date: { $ne: dateForDB } 
      });

     
  }

  // 2. Upsert Roster
  const rosterEntry = await ShiftRoster.findOneAndUpdate(
    { employeeId, date: dateForDB },
    {
      $set: { 
          shiftId: isWeekOff ? null : shiftId, 
          isWeekOff,
          post, 
          month,
          week // Save week to DB
      },
    },
    { upsert: true, new: true }
  );

  // 3. Sync with Attendance Collection Safely
  if (isWeekOff) {
      await Attendance.findOneAndUpdate(
          { employeeId, date: dateForDB },
          {
              $set: {
                  isWeekOff: true,
                  month,
                  week
              },
              $setOnInsert: { attendancePercentage: 100 }
          },
          { upsert: true }
      );
  } else {
      // Reverting a week-off into a standard working shift
      const existingAtt = await Attendance.findOne({ employeeId, date: dateForDB, isWeekOff: true });
      
      if (existingAtt) {
          existingAtt.isWeekOff = false;
          // Security Check: If they haven't actually physically punched in yet, 
          // we must remove the 100% attendance stub so they aren't paid for a day they didn't work.
          if (!existingAtt.punchInTime) {
              existingAtt.attendancePercentage = 0;
          }
          await existingAtt.save();
      }
  }

  await invalidateRosterCaches(employeeId, post, month, rosterEntry._id);
  await invalidateRosterCaches(null, post, month, null);

  return res.status(201).json(new ApiResponse(201, rosterEntry, 'Shift roster created/updated successfully', true));
});

export const getRoasterById = asyncHandler(async (req, res) => {
  const { rosterId } = req.params;

  if (!rosterId) {
    return res.status(400).json(new ApiResponse(400, {}, 'Roster ID is required', false));
  }

  const cacheKey = `${CACHE_KEY.ROSTER_ENTRY}${rosterId}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Roster entry retrieved from cache', true));

  const roster = await ShiftRoster.findById(rosterId)
    .populate('shiftId')
    .populate('employeeId')
    .populate('post');

  if (!roster) return res.status(404).json(new ApiResponse(404, {}, 'Roster entry not found', false));

  await setCache(cacheKey, roster, 3600);
  return res.status(200).json(new ApiResponse(200, roster, 'Roster entry retrieved successfully', true));
});

export const deleteShiftRoster = asyncHandler(async (req, res) => {
  // Removing shiftId from required query because week-offs won't have a shiftId
  const { employeeId, date } = req.query;

  if (!employeeId || !date) {
    return res.status(400).json(
      new ApiResponse(400, {}, 'employeeId and date are required', false)
    );
  }

  if (isNaN(new Date(date).getTime())) {
    return res.status(400).json(new ApiResponse(400, {}, 'Invalid date format', false));
  }

  const dateForDB = midnightIST(toISTDateString(date));

  // Find & Delete Roster
  const deleted = await ShiftRoster.findOneAndDelete({ employeeId, date: dateForDB });

  if (!deleted) {
    return res.status(404).json(new ApiResponse(404, {}, 'Shift roster entry not found', false));
  }

  // Attendance Cleanup Logic
  if (deleted.isWeekOff) {
      const attendance = await Attendance.findOne({ employeeId, date: dateForDB });
      if (attendance) {
          // If the employee didn't physically punch in/out, it was just a stub. Safe to delete.
          if (!attendance.punchInTime && !attendance.punchOutTime) {
              await attendance.deleteOne();
          } else {
              // They punched in on their week off (OT scenario). Do not delete punches, just remove the flag.
              attendance.isWeekOff = false;
              await attendance.save();
          }
      }
  }

  await invalidateRosterCaches(employeeId, deleted.post, deleted.month, deleted._id);

  return res.status(200).json(new ApiResponse(200, {}, 'Shift roster entry deleted successfully', true));
});

export const getPostShiftRoster = asyncHandler(async (req, res) => {
  const { post, month } = req.query;

  if (!post || !month) {
    return res.status(400).json(new ApiResponse(400, {}, 'post and month are required', false));
  }

  const monthErr = validateMonth(month);
  if (monthErr) return res.status(400).json(new ApiResponse(400, {}, monthErr, false));

  const cacheKey = `${CACHE_KEY.ROSTER_POST}${post}_${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Roster retrieved from cache', true));

  const rosters = await ShiftRoster.find({ post, month })
    .populate('shiftId')
    .populate('employeeId')
    .populate('post');

  await setCache(cacheKey, rosters, 3600);
  return res.status(200).json(new ApiResponse(200, rosters, 'Roster retrieved successfully', true));
});

export const getEmployeeShiftRoster = asyncHandler(async (req, res) => {
  const { employeeId, month } = req.query;

  if (!employeeId || !month) {
    return res.status(400).json(new ApiResponse(400, {}, 'employeeId and month are required', false));
  }

  const monthErr = validateMonth(month);
  if (monthErr) return res.status(400).json(new ApiResponse(400, {}, monthErr, false));

  const cacheKey = `${CACHE_KEY.ROSTER_EMP}${employeeId}_${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Employee roster retrieved from cache', true));

  const rosters = await ShiftRoster.find({ employeeId, month }).populate('shiftId');

  if (!rosters.length) {
    return res.status(404).json(new ApiResponse(404, [], 'No roster entries found for this employee and month', false));
  }

  await setCache(cacheKey, rosters, 3600);
  return res.status(200).json(new ApiResponse(200, rosters, 'Employee roster retrieved successfully', true));
});

export const finalizeRoster = asyncHandler(async (req, res) => {
  const { month, isFinalized } = req.body;

  if (!month || typeof isFinalized !== 'boolean') {
    return res.status(400).json(
      new ApiResponse(400, {}, 'month (string) and isFinalized (boolean) are required', false)
    );
  }

  const monthErr = validateMonth(month);
  if (monthErr) return res.status(400).json(new ApiResponse(400, {}, monthErr, false));

  const rosterControl = await RosterControl.findOneAndUpdate(
    { month },
    { isFinalized },
    { upsert: true, new: true }
  );

  return res.status(200).json(
    new ApiResponse(200, rosterControl, `Roster ${isFinalized ? 'finalized' : 'unlocked'} successfully`, true)
  );
});