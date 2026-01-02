import { Shift } from "../models/shift.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import { ShiftRoster } from "../models/shiftRoster.model.js";
import { RosterControl } from "../models/shiftRosterControl.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  SHIFT_PREFIX: "shift_",             // Single shift: shift_123
  SHIFT_LIST: "shift_list_",          // Shift Query lists
  ROSTER_ENTRY: "roster_entry_",      // Single roster entry
  ROSTER_POST: "roster_post_",        // Roster by Post: roster_post_postId_month
  ROSTER_EMP: "roster_emp_"           // Roster by Employee: roster_emp_empId_month
};

export const createShift = asyncHandler(async (req, res) => {
  const { name, startTime, endTime, post } = req.body;

  if (!name || !startTime || !endTime || !post) {
    return res.status(400).json(new ApiResponse(400, {}, "All fields are required", false));
  }

  const shift = await Shift.create({ name, startTime, endTime, post });

  // [CACHE INVALIDATION] New shift added -> Clear shift lists
  await removeCachePattern(`${CACHE_KEY.SHIFT_LIST}*`);

  return res.status(201).json(new ApiResponse(201, shift, "Shift created successfully", true));
});

export const getAllShifts = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  // [CACHE READ] Unique key based on query params
  const filterKey = JSON.stringify(filters);
  const cacheKey = `${CACHE_KEY.SHIFT_LIST}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
  
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Shifts retrieved from Cache", true));
  }

  const query = {};

  // Apply filters based on shift schema
  if (filters.name) {
    query.name = { $regex: filters.name, $options: "i" };
  }
  if (filters.startTime) {
    query.startTime = { $regex: filters.startTime, $options: "i" };
  }
  if (filters.endTime) {
    query.endTime = { $regex: filters.endTime, $options: "i" };
  }
  if (filters.post) {
    query.post = filters.post; 
  }

  // Fetch shifts with pagination and sorting
  const shifts = await Shift.find(query)
    .populate("post", "title") 
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  // Get total count for pagination
  const totalShifts = await Shift.countDocuments(query);

  const responsePayload = {
      success: true,
      totalShifts,
      totalPages: Math.ceil(totalShifts / limit),
      currentPage: parseInt(page),
      shifts,
  };

  // [CACHE WRITE]
  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(
    new ApiResponse(200, responsePayload, "Shifts retrieved successfully", true)
  );
});

export const getShiftById = asyncHandler(async (req, res) => {
    const { shiftId } = req.params;
  
    if (!shiftId) {
      return res.status(400).json(new ApiResponse(400, {}, "Shift ID is required", false));
    }

    // [CACHE READ]
    const cacheKey = `${CACHE_KEY.SHIFT_PREFIX}${shiftId}`;
    const cachedShift = await getCache(cacheKey);
    if (cachedShift) {
        return res.status(200).json(new ApiResponse(200, cachedShift, "Shift retrieved from Cache", true));
    }
  
    const shift = await Shift.findById(shiftId);
  
    if (!shift) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift not found", false));
    }

    // [CACHE WRITE]
    await setCache(cacheKey, shift, 3600);
  
    return res.status(200).json(new ApiResponse(200, shift, "Shift retrieved successfully", true));
});
  
export const deleteShift = asyncHandler(async (req, res) => {
    const { shiftId } = req.params;
  
    if (!shiftId) {
      return res.status(400).json(new ApiResponse(400, {}, "Shift ID is required", false));
    }
  
    const isAssigned = await ShiftRoster.findOne({ shiftId });
    if (isAssigned) {
      return res.status(409).json(
        new ApiResponse(409, {}, "Shift cannot be deleted as it is assigned to one or more rosters", false)
      );
    }
  
    const deletedShift = await Shift.findByIdAndDelete(shiftId);
  
    if (!deletedShift) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift not found", false));
    }

    // [CACHE INVALIDATION]
    await removeCache(`${CACHE_KEY.SHIFT_PREFIX}${shiftId}`);
    await removeCachePattern(`${CACHE_KEY.SHIFT_LIST}*`);
  
    return res.status(200).json(new ApiResponse(200, deletedShift, "Shift deleted successfully", true));
});

// ================= ROSTER CONTROLLERS =================

export const createShiftRoster = asyncHandler(async (req, res) => {
  const { employeeId, shiftId, date, post, month } = req.body;

  if (!employeeId || !shiftId || !date || !post || !month) {
    return res.status(400).json(new ApiResponse(400, {}, "All fields are required", false));
  }

  const existingShift = await ShiftRoster.findOne({ employeeId, date });
  if (existingShift) {
    return res.status(409).json(new ApiResponse(409, {}, "Employee already has a shift on this date", false));
  }

  const rosterEntry = await ShiftRoster.create({ employeeId, shiftId, date, post, month });

  // [CACHE INVALIDATION]
  // 1. Invalidate the Roster for this specific Post & Month
  await removeCache(`${CACHE_KEY.ROSTER_POST}${post}_${month}`);
  // 2. Invalidate the Roster for this specific Employee & Month
  await removeCache(`${CACHE_KEY.ROSTER_EMP}${employeeId}_${month}`);

  return res.status(201).json(new ApiResponse(201, rosterEntry, "Shift roster created successfully", true));
});

export const getRoasterById = asyncHandler(async (req, res) => {
    const { rosterId } = req.params;
  
    if (!rosterId) {
      return res.status(400).json(new ApiResponse(400, {}, "Shift ID is required", false));
    }

    // [CACHE READ]
    const cacheKey = `${CACHE_KEY.ROSTER_ENTRY}${rosterId}`;
    const cachedRoster = await getCache(cacheKey);
    if (cachedRoster) {
        return res.status(200).json(new ApiResponse(200, cachedRoster, "Shift retrieved from Cache", true));
    }
  
    const shiftRoaster = await ShiftRoster.findById(rosterId);
  
    if (!shiftRoaster) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift not found", false));
    }

    // [CACHE WRITE]
    await setCache(cacheKey, shiftRoaster, 3600);
  
    return res.status(200).json(new ApiResponse(200, shiftRoaster, "Shift retrieved successfully", true));
});
  
export const deleteShiftRoster = asyncHandler(async (req, res) => {
    const { employeeId, shiftId, date } = req.query;
  
    // We need to find it first to get the 'post' and 'month' for cache invalidation
    // Note: If 'post' or 'month' isn't in query, we assume we rely on the DB result
    const rosterEntry = await ShiftRoster.findOne({employeeId, shiftId, date});
    
    if (!rosterEntry) {
      return res.status(404).json(new ApiResponse(404, {}, "Shift roster entry not found", false));
    }
  
    await ShiftRoster.findOneAndDelete({employeeId, shiftId, date});

    // [CACHE INVALIDATION]
    // 1. Invalidate specific entry cache (if we had the ID, but here we don't, so we skip exact ID cache)
    // 2. Invalidate Post-based list
    if (rosterEntry.post && rosterEntry.month) {
        await removeCache(`${CACHE_KEY.ROSTER_POST}${rosterEntry.post}_${rosterEntry.month}`);
    }
    // 3. Invalidate Employee-based list
    if (rosterEntry.month) {
        await removeCache(`${CACHE_KEY.ROSTER_EMP}${employeeId}_${rosterEntry.month}`);
    }

    return res.status(200).json(new ApiResponse(200, {}, "Shift roster entry deleted successfully", true));
});

export const getPostShiftRoster = asyncHandler(async (req, res) => {
    const { post, month } = req.query;
  
    if (!post || !month) {
      return res.status(400).json(new ApiResponse(400, {}, "Post and month are required", false));
    }

    // [CACHE READ] Key includes post ID and Month
    const cacheKey = `${CACHE_KEY.ROSTER_POST}${post}_${month}`;
    const cachedRoster = await getCache(cacheKey);
    if (cachedRoster) {
        return res.status(200).json(new ApiResponse(200, cachedRoster, "Shift roster retrieved from Cache", true));
    }
  
    const rosters = await ShiftRoster.find({ post, month }).populate("shiftId").populate("employeeId").populate("post");
  
    // [CACHE WRITE]
    await setCache(cacheKey, rosters, 3600);

    return res.status(200).json(new ApiResponse(200, rosters, "Shift roster retrieved successfully", true));
});

export const getEmployeeShiftRoster = asyncHandler(async (req, res) => {
    const { employeeId, month } = req.query;
  
    if (!employeeId || !month) {
      return res.status(400).json(new ApiResponse(400, {}, "Employee ID and month are required", false));
    }

    // [CACHE READ] Key includes Employee ID and Month
    const cacheKey = `${CACHE_KEY.ROSTER_EMP}${employeeId}_${month}`;
    const cachedRoster = await getCache(cacheKey);
    if (cachedRoster) {
        return res.status(200).json(new ApiResponse(200, cachedRoster, "Employee shift roster retrieved from Cache", true));
    }
  
    const rosters = await ShiftRoster.find({ employeeId, month }).populate("shiftId");

    // [CACHE WRITE]
    await setCache(cacheKey, rosters, 3600);
  
    return res.status(200).json(new ApiResponse(200, rosters, "Employee shift roster retrieved successfully", true));
});
  
export const finalizeRoster = asyncHandler(async (req, res) => {
  const { month, isFinalized } = req.body;

  if (!month || typeof isFinalized !== "boolean") {
    return res.status(400).json(new ApiResponse(400, {}, "Month and isFinalized flag are required", false));
  }

  const rosterControl = await RosterControl.findOneAndUpdate(
    { month },
    { isFinalized },
    { upsert: true, new: true }
  );

  // Note: We generally don't cache RosterControl specifically as it's a lightweight toggle, 
  // but changing status might affect how data is displayed. 
  // If your frontend logic changes based on this, you might want to invalidate roster caches here too.
  // For now, we leave data caches intact as the *data* hasn't changed, only the *status*.

  return res.status(200).json(
    new ApiResponse(200, rosterControl, `Roster ${isFinalized ? "finalized" : "unlocked"} successfully`, true)
  );
});