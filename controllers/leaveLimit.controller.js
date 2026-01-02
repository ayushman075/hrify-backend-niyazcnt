import { User } from "../models/user.model.js";
import { LeaveConfig } from "../models/leaveConfig.model.js";
import LeaveLimit from "../models/leaveLimit.model.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Employee } from "../models/employee.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "limit_emp_",      // Single Limit by EmployeeID: limit_emp_12345
  LIST_PREFIX: "limit_list_" // Query lists
};

export const initializeLeaveLimit = asyncHandler(async (req, res) => {
  const { employeeId  } = req.body;

  if (!employeeId) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Required fields are missing: employeeId", false));
  }

  const employeeDetails = await Employee.findById(employeeId)

  if(!employeeDetails){
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Employee not found", false));
  }

  const postId = employeeDetails.post;
  const joinDate = employeeDetails.dateOfJoining

  const leaveConfigs = await LeaveConfig.find({ posts: { $in: [postId] } });

  if (!leaveConfigs || leaveConfigs.length === 0) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "No leave configurations found for this post", false));
  }

  const leaveDetails = leaveConfigs.map((config) => ({
    leaveType: config.leaveType._id, 
    maxLeaves: config.maxLeavesPerYear,
    usedLeaves: 0,
    remainingLeaves: config.maxLeavesPerYear, 
    eligibilityDays: config.eligibilityDays || 0,
    carryForward: config.carryForward,
    encashable: config.encashable,
  }));

  const leaveLimit = new LeaveLimit({
    employeeId,
    postId,
    joinDate: new Date(joinDate),
    leaveDetails,
    lastRefreshed: new Date(joinDate),
  });

  await leaveLimit.save();

  // [CACHE INVALIDATION] New limit created -> Lists are stale
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
  // Also clear specific employee cache if it existed (rare but safer)
  await removeCache(`${CACHE_KEY.PREFIX}${employeeId}`);

  return res
    .status(201)
    .json(new ApiResponse(201, leaveLimit, "Leave limit initialized successfully", true));
});

export const getLeaveLimit = asyncHandler(async (req, res) => {
    const { employeeId } = req.query;

    if (!employeeId) {
      return res.status(400).json(new ApiResponse(400, {}, "Employee ID is required", false));
    }
  
    // [CACHE READ] 
    // This is a "Smart GET". Even though it writes to DB (refresh logic), 
    // caching the *result* is safe and highly efficient.
    const cacheKey = `${CACHE_KEY.PREFIX}${employeeId}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Leave limit retrieved from Cache", true));
    }

    let leaveLimit = await LeaveLimit.findOne({ employeeId:employeeId }).populate("postId", "name description");
  
   if(!leaveLimit){
    // --- Logic to INITIALIZE if missing ---
    const employeeDetails = await Employee.findById(employeeId)

    if(!employeeDetails){
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "Employee not found", false));
    }

    const postId = employeeDetails.post;
    const joinDate = employeeDetails.dateOfJoining

    const leaveConfigs = await LeaveConfig.find({ posts: { $in: [postId] } });

    if (!leaveConfigs || leaveConfigs.length === 0) {
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "No leave configurations found for this post", false));
    }

    const leaveDetails = leaveConfigs.map((config) => ({
      leaveType: config._id, 
    maxLeaves: config.maxLeavesPerYear,
    usedLeaves: 0,
    remainingLeaves: config.totalLeaves, 
    eligibilityDays: config.eligibilityDays || 0,
    carryForward: config.carryForwardAllowed,
    encashable: config.encashmentAllowed,
    }));

    const newLeaveLimit = new LeaveLimit({
      employeeId,
      postId,
      joinDate: new Date(joinDate),
      leaveDetails,
      lastRefreshed: new Date(joinDate),
    });

    await newLeaveLimit.save();
   } else {
    // --- Logic to REFRESH if exists ---
    const currentDate = new Date();
    // Re-fetch to ensure we have the full document context if needed, or use the one found
    const employees = await LeaveLimit.find({employeeId}).populate("leaveDetails.leaveType");
    
    for (const employee of employees) {
      const { joinDate, leaveDetails, lastRefreshed } = employee;
  
      const yearsOfService = Math.floor((currentDate - new Date(joinDate)) / ( 24 * 60 * 60 * 1000));
      // Note: Logic here seems to check year difference, unrelated to `lastRefreshed` in the loop?
      // Assuming original logic is correct:
     
        leaveDetails.forEach((detail) => {
          if (detail.leaveType && detail.leaveType.validityDays && yearsOfService % detail.leaveType.validityDays==0 ) {
          if (detail.carryForward) {
            detail.remainingLeaves += 2*detail.leaveType.totalLeaves - detail.usedLeaves;
          } else {
            detail.remainingLeaves = detail.leaveType.totalLeaves;
          }
          detail.usedLeaves = 0;
        }
        });
  
        employee.lastRefreshed = currentDate;
        await employee.save();
    }
   }

   // Fetch final formatted data to return
   leaveLimit = await LeaveLimit.findOne({ employeeId:employeeId })
   .populate("postId", "name description")
   .populate("leaveDetails.leaveType", "leaveType totalLeaves"); 

    // [CACHE WRITE] Save for 1 hour
    await setCache(cacheKey, leaveLimit, 3600);

    return res
      .status(200)
      .json(new ApiResponse(200, leaveLimit, "Leave limit retrieved successfully", true));
});
  
export const updateLeaveUsage = asyncHandler(async (req, res) => {
    const { employeeId, leaveType, daysUsed } = req.body;
  
    if (!employeeId || !leaveType || !daysUsed) {
      return res
        .status(400)
        .json(new ApiResponse(400, {}, "Required fields are missing: employeeId, leaveType, daysUsed", false));
    }
  
    const leaveLimit = await LeaveLimit.findOne({ employeeId });
  
    if (!leaveLimit) {
      return res
        .status(404)
        .json(new ApiResponse(404, {}, "Leave limit not found for this employee", false));
    }
  
    const leaveDetail = leaveLimit.leaveDetails.find((detail) => detail.leaveType === leaveType);
  
    if (!leaveDetail) {
      return res
        .status(404)
        .json(new ApiResponse(404, {}, `Leave type ${leaveType} not found for this employee`, false));
    }
  
    if (leaveDetail.remainingLeaves < daysUsed) {
      return res
        .status(400)
        .json(new ApiResponse(400, {}, "Insufficient leave balance", false));
    }
  
    leaveDetail.usedLeaves += daysUsed;
    leaveDetail.remainingLeaves -= daysUsed;
  
    await leaveLimit.save();

    // [CACHE INVALIDATION]
    // 1. Clear this employee's limit cache
    await removeCache(`${CACHE_KEY.PREFIX}${employeeId}`);
    // 2. Clear lists
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
  
    return res
      .status(200)
      .json(new ApiResponse(200, leaveLimit, "Leave usage updated successfully", true));
});
  
export const refreshLeaveLimits = asyncHandler(async (req, res) => {
    const currentDate = new Date();
    const employees = await LeaveLimit.find();
  
    const updatedEmployees = [];
  
    for (const employee of employees) {
      const { joinDate, leaveDetails, lastRefreshed } = employee;
  
      const yearsOfService = Math.floor((currentDate - new Date(joinDate)) / (365 * 24 * 60 * 60 * 1000));
      const lastRefreshYear = new Date(lastRefreshed).getFullYear();
  
      if (yearsOfService > 0 && lastRefreshYear < currentDate.getFullYear()) {
        leaveDetails.forEach((detail) => {
          if (detail.carryForward) {
            detail.remainingLeaves += detail.maxLeaves - detail.usedLeaves;
          } else {
            detail.remainingLeaves = detail.maxLeaves;
          }
          detail.usedLeaves = 0;
        });
  
        employee.lastRefreshed = currentDate;
        await employee.save();
        updatedEmployees.push(employee);
      }
    }

    // [CACHE INVALIDATION]
    // This affects MANY employees. We must clear ALL limit caches.
    // 1. Clear all individual employee limit caches
    await removeCachePattern(`${CACHE_KEY.PREFIX}*`);
    // 2. Clear all list caches
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
  
    return res
      .status(200)
      .json(new ApiResponse(200, updatedEmployees, "Leave limits refreshed successfully", true));
});

export const getLeaveLimits = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, sortBy = 'joinDate', sortOrder = 'desc', ...filters } = req.query;
  
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const sortOrderValue = sortOrder === 'desc' ? -1 : 1;

    // [CACHE READ]
    // Note: We include filters in the key but safely exclude them from the query object later
    const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sortBy}_o${sortOrder}_f${JSON.stringify(filters)}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Leave limits retrieved from Cache", true));
    }
  
    const filterConditions = {};
  
    if (filters.employeeId) {
      filterConditions.employeeId = filters.employeeId;
    }
    if (filters.postId) {
      filterConditions.postId = filters.postId;
    }
    if (filters.leaveType) {
      filterConditions.leaveType = filters.leaveType;
    }
    if (filters.status) {
      filterConditions.status = filters.status;
    }
  
    const leaveLimits = await LeaveLimit.find(filterConditions)
      .skip((pageNumber - 1) * pageLimit)  
      .limit(pageLimit)                   
      .sort({ [sortBy]: sortOrderValue });
  
    const totalDocuments = await LeaveLimit.countDocuments(filterConditions);
    const totalPages = Math.ceil(totalDocuments / pageLimit);
  
    const responsePayload = {
        data: leaveLimits,
        pagination: {
          totalPages,
          currentPage: pageNumber,
          totalDocuments,
          perPage: pageLimit,
        }
    };

    // [CACHE WRITE]
    await setCache(cacheKey, responsePayload, 3600);

    return res.status(200).json(
      new ApiResponse(200, responsePayload, 'Leave limits retrieved successfully', true)
    );
});