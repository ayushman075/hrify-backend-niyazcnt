
import { User } from "../models/user.model.js";
import { LeaveConfig } from "../models/leaveConfig.model.js";
import LeaveLimit from "../models/leaveLimit.model.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Employee } from "../models/employee.model.js";

export const initializeLeaveLimit = asyncHandler(async (req, res) => {
  const { employeeId  } = req.body;

  if (!employeeId) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Required fields are missing: employeeId, postId, joinDate", false));
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
    leaveType: config.leaveType._id, // Make sure this is an ObjectId, not a string
    maxLeaves: config.maxLeavesPerYear,
    usedLeaves: 0,
    remainingLeaves: config.maxLeavesPerYear, // This ensures remainingLeaves is set
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

  return res
    .status(201)
    .json(new ApiResponse(201, leaveLimit, "Leave limit initialized successfully", true));
});



export const getLeaveLimit = asyncHandler(async (req, res) => {
    const { employeeId } = req.query;

    if (!employeeId) {
      return res.status(400).json(new ApiResponse(400, {}, "Employee ID and month are required", false));
    }
  
    let leaveLimit = await LeaveLimit.findOne({ employeeId:employeeId }).populate("postId", "name description");
  
   if(!leaveLimit){
    
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
    leaveType: config._id, // Make sure this is an ObjectId, not a string
  maxLeaves: config.maxLeavesPerYear,
  usedLeaves: 0,
  remainingLeaves: config.totalLeaves, // This ensures remainingLeaves is set
  eligibilityDays: config.eligibilityDays || 0,
  carryForward: config.carryForwardAllowed,
  encashable: config.encashmentAllowed,
  }));

  const leaveLimit = new LeaveLimit({
    employeeId,
    postId,
    joinDate: new Date(joinDate),
    leaveDetails,
    lastRefreshed: new Date(joinDate),
  });

  await leaveLimit.save();
   } else{
    const currentDate = new Date();
    const employees = await LeaveLimit.find({employeeId}).populate("leaveDetails.leaveType");
    const updatedEmployees = [];
  
    for (const employee of employees) {
      const { joinDate, leaveDetails, lastRefreshed } = employee;
  
      const yearsOfService = Math.floor((currentDate - new Date(joinDate)) / ( 24 * 60 * 60 * 1000));
      const lastRefreshYear = new Date(lastRefreshed).getFullYear();
  
     
        leaveDetails.forEach((detail) => {
          if (yearsOfService % detail.leaveType.validityDays==0 ) {
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
        updatedEmployees.push(employee);
     
    }

  
   }

   leaveLimit = await LeaveLimit.findOne({ employeeId:employeeId })
   .populate("postId", "name description")
   .populate("leaveDetails.leaveType", "leaveType totalLeaves"); 

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
  
    return res
      .status(200)
      .json(new ApiResponse(200, updatedEmployees, "Leave limits refreshed successfully", true));
  });

  

  export const getLeaveLimits = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, sortBy = 'joinDate', sortOrder = 'desc', ...filters } = req.query;
  
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
  
    const sortOrderValue = sortOrder === 'desc' ? -1 : 1;
  
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
  
    return res.status(200).json(
      new ApiResponse(200, {
        data: leaveLimits,
        pagination: {
          totalPages,
          currentPage: pageNumber,
          totalDocuments,
          perPage: pageLimit,
        }
      }, 'Leave limits retrieved successfully', true)
    );
  });
  