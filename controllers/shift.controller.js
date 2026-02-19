/**
 * shift.controller.js
 *
 * IST contract (consistent with attendance.controller.js and the cron):
 *   - All `date` fields stored in MongoDB as midnight IST = midnightIST("YYYY-MM-DD")
 *     which is 2025-07-08T18:30:00.000Z in UTC for "2025-07-09".
 *   - Every query/create that touches a `date` field must go through midnightIST().
 *   - `month` is always derived server-side from `date` — never trusted from the client.
 *   - `month` format is always "YYYY-MM" validated against /^\d{4}-\d{2}$/.
 */

import { Shift }         from '../models/shift.model.js';
import { ApiResponse }   from '../utils/ApiResponse.js';
import { asyncHandler }  from '../utils/AsyncHandler.js';
import { ShiftRoster }   from '../models/shiftRoster.model.js';
import { RosterControl } from '../models/shiftRosterControl.model.js';
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';

// ─── Cache keys ───────────────────────────────────────────────────────────────

const CACHE_KEY = {
  SHIFT_PREFIX:  'shift_',         // shift_{id}
  SHIFT_LIST:    'shift_list_',    // paginated shift queries
  ROSTER_ENTRY:  'roster_entry_',  // roster_{id}
  ROSTER_POST:   'roster_post_',   // roster_post_{postId}_{month}
  ROSTER_EMP:    'roster_emp_',    // roster_emp_{empId}_{month}
};

// ─── IST date helpers (zero external dependencies) ───────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Returns a Date whose UTC fields read as the IST wall-clock time of `date`. */
const toIST = (date = new Date()) =>
  new Date(date.getTime() + date.getTimezoneOffset() * 60_000 + IST_OFFSET_MS);

/**
 * Normalise any date input to "YYYY-MM-DD" in IST.
 * "2025-07-09" (UTC midnight) → "2025-07-09" even on a UTC server.
 */
const toISTDateString = (input) => {
  const ist = toIST(new Date(input));
  return [
    ist.getUTCFullYear(),
    String(ist.getUTCMonth() + 1).padStart(2, '0'),
    String(ist.getUTCDate()).padStart(2, '0'),
  ].join('-');
};

/**
 * Returns a Date representing 00:00:00 IST for `dateStr` ("YYYY-MM-DD").
 * Stored in MongoDB as 2025-07-08T18:30:00.000Z for "2025-07-09".
 * Must be used for every date stored/queried so values are consistent.
 */
const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

/** "YYYY-MM" from any date input, evaluated in IST. */
const toISTMonthString = (input) => {
  const ist = toIST(new Date(input));
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ─── Input helpers ────────────────────────────────────────────────────────────

const MONTH_REGEX = /^\d{4}-\d{2}$/;

/** Returns null if month is valid "YYYY-MM", or an error message string. */
const validateMonth = (month) =>
  MONTH_REGEX.test(month) ? null : 'month must be in "YYYY-MM" format (e.g. "2025-07")';

/** Safely parse JSON; returns [parsed, null] or [null, errorMessage]. */
const tryParseJSON = (str) => {
  if (typeof str !== 'string') return [str, null]; // already an object (body parsers)
  try { return [JSON.parse(str), null]; }
  catch { return [null, 'Invalid JSON in filters parameter']; }
};

/** Safely parseInt with a required fallback. */
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

/**
 * POST /shifts
 */
export const createShift = asyncHandler(async (req, res) => {
  const { name, startTime, endTime, post } = req.body;

  if (!name || !startTime || !endTime || !post) {
    return res.status(400).json(new ApiResponse(400, {}, 'All fields are required: name, startTime, endTime, post', false));
  }

  const shift = await Shift.create({ name, startTime, endTime, post });
  await removeCachePattern(`${CACHE_KEY.SHIFT_LIST}*`);

  return res.status(201).json(new ApiResponse(201, shift, 'Shift created successfully', true));
});

/**
 * GET /shifts
 */
export const getAllShifts = asyncHandler(async (req, res) => {
  const { sort = 'createdAt', order = 'desc' } = req.query;

  // Parse page/limit safely — never trust raw query string arithmetic
  const page  = safeInt(req.query.page,  1);
  const limit = safeInt(req.query.limit, 10);

  // filters arrives as a JSON string from query params
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

/**
 * GET /shifts/:shiftId
 */
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

/**
 * DELETE /shifts/:shiftId
 * Refuses if the shift is assigned to any active roster entry.
 */
export const deleteShift = asyncHandler(async (req, res) => {
  const { shiftId } = req.params;

  if (!shiftId) {
    return res.status(400).json(new ApiResponse(400, {}, 'Shift ID is required', false));
  }

  // Check assignment BEFORE deleting — guard against race condition by doing the
  // actual delete only if no roster exists, using a single findOne check.
  // Fully atomic protection would require a DB transaction; this is an acceptable
  // trade-off for a low-frequency admin operation.
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
// ROSTER CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /roster
 *
 * Key decisions:
 *   - `date` is stored as midnightIST() so it matches every other date in the system.
 *   - `month` is derived server-side from `date` — client value is ignored.
 *   - findOneAndUpdate with upsert avoids the race condition of findOne + create.
 */
export const createShiftRoster = asyncHandler(async (req, res) => {
  const { employeeId, shiftId, date, post } = req.body;

  if (!employeeId || !shiftId || !date || !post) {
    return res.status(400).json(
      new ApiResponse(400, {}, 'All fields are required: employeeId, shiftId, date, post', false)
    );
  }

  // Validate date parses correctly
  if (isNaN(new Date(date).getTime())) {
    return res.status(400).json(new ApiResponse(400, {}, 'Invalid date format', false));
  }

  const dateStr   = toISTDateString(date);   // canonical "YYYY-MM-DD" in IST
  const dateForDB = midnightIST(dateStr);    // consistent storage value
  const month     = toISTMonthString(date);   // always derived, never trusted from client

  // Atomic upsert via Mongoose (Handles ObjectIds and timestamps safely)
  // `new: false` is the default. It returns the "before" state.
  const existing = await ShiftRoster.findOneAndUpdate(
    { employeeId, date: dateForDB },
    {
      $setOnInsert: { shiftId, post, month }, // Mongoose auto-merges `employeeId` and `date` from the filter
    },
    { upsert: true }
  );

  // If `existing` is truthy, the document was already there (Conflict)
  if (existing) {
    return res.status(409).json(
      new ApiResponse(409, {}, 'Employee already has a shift on this date', false)
    );
  }

  // Fetch the newly created document for the response (will work now!)
  const rosterEntry = await ShiftRoster.findOne({ employeeId, date: dateForDB });

  await invalidateRosterCaches(employeeId, post, month, null);
  await invalidateRosterCaches(null, post, month, null);

  return res.status(201).json(new ApiResponse(201, rosterEntry, 'Shift roster created successfully', true));
});

/**
 * GET /roster/:rosterId
 */
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

/**
 * DELETE /roster
 * Query params: employeeId, shiftId, date
 *
 * Uses midnightIST() so the date query matches stored values.
 * Invalidates all three relevant caches including the single-entry cache.
 */
export const deleteShiftRoster = asyncHandler(async (req, res) => {
  const { employeeId, shiftId, date } = req.query;

  if (!employeeId || !shiftId || !date) {
    return res.status(400).json(
      new ApiResponse(400, {}, 'employeeId, shiftId, and date are required', false)
    );
  }

  if (isNaN(new Date(date).getTime())) {
    return res.status(400).json(new ApiResponse(400, {}, 'Invalid date format', false));
  }

  const dateForDB = midnightIST(toISTDateString(date));

  // findOneAndDelete is atomic — find + delete in a single round-trip
  const deleted = await ShiftRoster.findOneAndDelete({ employeeId, shiftId, date: dateForDB });

  if (!deleted) {
    return res.status(404).json(new ApiResponse(404, {}, 'Shift roster entry not found', false));
  }

  // Invalidate all relevant caches — we now have the _id so we can also clear the entry cache
  await invalidateRosterCaches(employeeId, deleted.post, deleted.month, deleted._id);

  return res.status(200).json(new ApiResponse(200, {}, 'Shift roster entry deleted successfully', true));
});

/**
 * GET /roster/post?post=&month=YYYY-MM
 */
export const getPostShiftRoster = asyncHandler(async (req, res) => {
  const { post, month } = req.query;
console.log("request recived")
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

/**
 * GET /roster/employee?employeeId=&month=YYYY-MM
 */
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

/**
 * POST /roster/finalize
 * Toggle finalized state for a month's roster.
 */
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

  // The roster data itself didn't change, only the control flag —
  // no need to bust roster data caches. If your UI gates writes based on
  // isFinalized, the next write attempt will re-read this from DB.

  return res.status(200).json(
    new ApiResponse(200, rosterControl, `Roster ${isFinalized ? 'finalized' : 'unlocked'} successfully`, true)
  );
});