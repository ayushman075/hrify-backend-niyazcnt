

import { LeaveConfig } from "../models/leaveConfig.model.js";
import { User } from "../models/user.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";


export const createLeaveConfig = asyncHandler(async (req, res) => {
  const {
    leaveType,
    totalLeaves,
    eligibilityDays,
    carryForwardAllowed,
    carryForwardLimit,
    encashmentAllowed,
    encashmentLimit,
    validityDays,
    isPaidLeave,
    posts
  } = req.body;

  if (!leaveType || !totalLeaves || !posts) {
    return res.status(400).json(
      new ApiResponse(
        400,
        {},
        "Required fields are missing",
        false
      )
    );
  }

  const userId = req.auth.userId;
  if (!userId) {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({userId});
  if (!user) {
    return res.status(403).json(
      new ApiResponse(
        403,
        {},
        "Only Admin and HR Manager can create leave configurations.",
        false
      )
    );
  }

  const existingConfig = await LeaveConfig.findOne({ leaveType,posts });
  if (existingConfig) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "Leave type already exists", false));
  }


  const leaveConfig = new LeaveConfig({
    leaveType,
    totalLeaves,
    eligibilityDays,
    carryForwardAllowed,
    carryForwardLimit,
    encashmentAllowed,
    encashmentLimit,
    validityDays,
    isPaidLeave,
    posts,
    user:user._id
  });

  await leaveConfig.save();

  return res
    .status(201)
    .json(new ApiResponse(201, leaveConfig, "Leave configuration created successfully", true));
});



 export const getAllLeaveConfigs = asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 10,
      sort = "createdAt",
      order = "desc",
      filters = {},
    } = req.query;
  
    const query = {};
  
    if (filters.leaveType) {
      query.leaveType = { $regex: filters.leaveType, $options: "i" };
    }
   
    if (filters.post) {
      query.posts = filters.post;
    }
  
    const leaveConfigs = await LeaveConfig.find(query)
      .populate("posts", "title")
      .populate("user")
      .sort({ [sort]: order === "desc" ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
  
    const totalConfigs = await LeaveConfig.countDocuments(query);
  
    return res.status(200).json(new ApiResponse(200, {
      success: true,
      totalConfigs,
      totalPages: Math.ceil(totalConfigs / limit),
      currentPage: page,
      leaveConfigs,
    }, "Leave configurations retrieved successfully", true));
  });
  



export const getLeaveConfigById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const leaveConfig = await LeaveConfig.findById(id).populate("posts");

  if (!leaveConfig) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Leave configuration not found", false));
  }

  return res
    .status(200)
    .json(new ApiResponse(200, leaveConfig, "Leave configuration retrieved successfully", true));
});


export const updateLeaveConfig = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    leaveType,
    totalLeaves,
    eligibilityDays,
    carryForwardAllowed,
    carryForwardLimit,
    encashmentAllowed,
    encashmentLimit,
    validityDays,
    isPaidLeave,
    posts
  } = req.body;

  const userId = req.auth.userId;
  if (!userId) {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({userId});
  if (!user || (user.role !== "Admin" && user.role !== "HR Manager")) {
    return res.status(403).json(
      new ApiResponse(
        403,
        {},
        "Only Admin and HR Manager can update leave configurations.",
        false
      )
    );
  }

  const leaveConfig = await LeaveConfig.findById(id);
  if (!leaveConfig) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Leave configuration not found", false));
  }

  leaveConfig.leaveType = leaveType || leaveConfig.leaveType;
  leaveConfig.totalLeaves = totalLeaves || leaveConfig.totalLeaves;
  leaveConfig.eligibilityDays = eligibilityDays || leaveConfig.eligibilityDays;
  leaveConfig.carryForwardAllowed = carryForwardAllowed ;
  leaveConfig.carryForwardLimit = carryForwardLimit || leaveConfig.carryForwardLimit;
  leaveConfig.encashmentAllowed = encashmentAllowed ;
  leaveConfig.encashmentLimit = encashmentLimit || leaveConfig.encashmentLimit;
  leaveConfig.validityDays = validityDays || leaveConfig.validityDays;
  leaveConfig.isPaidLeave = isPaidLeave;
  leaveConfig.posts = posts || leaveConfig.posts;
  

  await leaveConfig.save();

  return res
    .status(200)
    .json(new ApiResponse(200, leaveConfig, "Leave configuration updated successfully", true));
});


export const deleteLeaveConfig = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const userId = req.auth.userId;
  if (!userId) {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({userId});
  if (!user ) {
    return res.status(403).json(
      new ApiResponse(
        403,
        {},
        "Only Admin and HR Manager can delete leave configurations.",
        false
      )
    );
  }

  const leaveConfig = await LeaveConfig.findById(id);
  if (!leaveConfig) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Leave configuration not found", false));
  }

  await leaveConfig.deleteOne();

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Leave configuration deleted successfully", true));
});


