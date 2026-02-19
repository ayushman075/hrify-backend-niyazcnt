import mongoose from "mongoose";
import { LeaveConfig } from "../models/leaveConfig.model.js";
import { User } from "../models/user.model.js";
import { Employee } from "../models/employee.model.js";
import LeaveLimit from "../models/leaveLimit.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// ─── Cache Keys Configuration ─────────────────────────────────────────────────
const CACHE_KEY = {
  PREFIX: "leave_conf_",           // Single ID: leave_conf_12345
  LIST_PREFIX: "leave_conf_list_"  // Query lists
};

// ─── Production Grade Sync Helper ─────────────────────────────────────────────
/**
 * Synchronizes LeaveLimit records for all active employees assigned to a Post
 * using high-performance MongoDB bulk operations.
 */
const syncLeaveLimitsForConfig = async (config, session) => {
  // 1. Fetch all eligible employees for this post
  const employees = await Employee.find({
    post: config.posts,
    status: { $in: ["Active", "Probation", "Contractual"] },
  })
    .select("_id joiningDate")
    .session(session);

  if (!employees.length) return;

  const employeeIds = employees.map((emp) => emp._id);

  // 2. Fetch existing limits for these employees to calculate remaining leaves accurately
  const existingLimits = await LeaveLimit.find({
    employeeId: { $in: employeeIds },
  }).session(session);

  const existingLimitsMap = new Map(
    existingLimits.map((limit) => [limit.employeeId.toString(), limit])
  );

  // 3. Prepare bulk operations
  const bulkOps = [];

  for (const emp of employees) {
    const existingLimit = existingLimitsMap.get(emp._id.toString());

    if (!existingLimit) {
      // Scenario A: Employee has no LeaveLimit document at all
      bulkOps.push({
        insertOne: {
          document: {
            employeeId: emp._id,
            postId: config.posts,
            joinDate: emp.joiningDate || new Date(),
            lastRefreshed: new Date(),
            leaveDetails: [
              {
                leaveType: config._id,
                usedLeaves: 0,
                remainingLeaves: config.totalLeaves,
              },
            ],
          },
        },
      });
    } else {
      // Scenario B & C: Employee has a LeaveLimit document
      const detailIndex = existingLimit.leaveDetails.findIndex(
        (d) => d.leaveType.toString() === config._id.toString()
      );

      if (detailIndex > -1) {
        // Scenario B: Policy updated -> Recalculate remaining leaves
        const used = existingLimit.leaveDetails[detailIndex].usedLeaves || 0;
        const newRemainingLeaves = config.totalLeaves - used;

        bulkOps.push({
          updateOne: {
            filter: {
              employeeId: emp._id,
              "leaveDetails.leaveType": config._id,
            },
            update: {
              $set: {
                "leaveDetails.$.remainingLeaves": newRemainingLeaves,
                lastRefreshed: new Date(),
              },
            },
          },
        });
      } else {
        // Scenario C: New policy added -> Push to existing leaveDetails array
        bulkOps.push({
          updateOne: {
            filter: { employeeId: emp._id },
            update: {
              $push: {
                leaveDetails: {
                  leaveType: config._id,
                  usedLeaves: 0,
                  remainingLeaves: config.totalLeaves,
                },
              },
              $set: { lastRefreshed: new Date() },
            },
          },
        });
      }
    }
  }

  // 4. Execute bulk write
  if (bulkOps.length > 0) {
    await LeaveLimit.bulkWrite(bulkOps, { session });
  }
};

// ─── Controllers ──────────────────────────────────────────────────────────────

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
    posts,
  } = req.body;

  if (!leaveType || !totalLeaves || !posts) {
    return res.status(400).json(new ApiResponse(400, {}, "Required fields are missing", false));
  }

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || (user.role !== "Admin" && user.role !== "HR Manager")) {
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin and HR Manager can create leave configurations.", false));
  }

  const existingConfig = await LeaveConfig.findOne({ leaveType, posts });
  if (existingConfig) {
    return res.status(409).json(new ApiResponse(409, {}, "Leave type already exists for this post", false));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
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
      user: user._id,
    });

    await leaveConfig.save({ session });

    // Sync limits for all affected employees automatically
    await syncLeaveLimitsForConfig(leaveConfig, session);

    await session.commitTransaction();

    // Cache Invalidation
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

    return res.status(201).json(new ApiResponse(201, leaveConfig, "Leave configuration created and employee limits synced successfully", true));
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

export const getAllLeaveConfigs = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  const filterKey = JSON.stringify(filters);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;

  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Leave configurations retrieved from Cache", true));
  }

  const query = {};

  if (filters.leaveType) {
    query.leaveType = { $regex: filters.leaveType, $options: "i" };
  }

  if (filters.post) {
    query.posts = filters.post;
  }

  const leaveConfigs = await LeaveConfig.find(query)
    .populate("posts", "title")
    .populate("user", "firstName lastName email") // Added essential user fields
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalConfigs = await LeaveConfig.countDocuments(query);

  const responsePayload = {
    success: true,
    totalConfigs,
    totalPages: Math.ceil(totalConfigs / limit),
    currentPage: parseInt(page),
    leaveConfigs,
  };

  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(new ApiResponse(200, responsePayload, "Leave configurations retrieved successfully", true));
});

export const getLeaveConfigById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

  const cachedConfig = await getCache(cacheKey);
  if (cachedConfig) {
    return res.status(200).json(new ApiResponse(200, cachedConfig, "Leave configuration retrieved from Cache", true));
  }

  const leaveConfig = await LeaveConfig.findById(id).populate("posts");

  if (!leaveConfig) {
    return res.status(404).json(new ApiResponse(404, {}, "Leave configuration not found", false));
  }

  await setCache(cacheKey, leaveConfig, 3600);

  return res.status(200).json(new ApiResponse(200, leaveConfig, "Leave configuration retrieved successfully", true));
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
    posts,
  } = req.body;

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || (user.role !== "Admin" && user.role !== "HR Manager")) {
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin and HR Manager can update leave configurations.", false));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const leaveConfig = await LeaveConfig.findById(id).session(session);
    if (!leaveConfig) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json(new ApiResponse(404, {}, "Leave configuration not found", false));
    }

    // Assign updates
    leaveConfig.leaveType = leaveType || leaveConfig.leaveType;
    leaveConfig.totalLeaves = totalLeaves !== undefined ? totalLeaves : leaveConfig.totalLeaves;
    leaveConfig.eligibilityDays = eligibilityDays !== undefined ? eligibilityDays : leaveConfig.eligibilityDays;
    leaveConfig.carryForwardAllowed = carryForwardAllowed !== undefined ? carryForwardAllowed : leaveConfig.carryForwardAllowed;
    leaveConfig.carryForwardLimit = carryForwardLimit !== undefined ? carryForwardLimit : leaveConfig.carryForwardLimit;
    leaveConfig.encashmentAllowed = encashmentAllowed !== undefined ? encashmentAllowed : leaveConfig.encashmentAllowed;
    leaveConfig.encashmentLimit = encashmentLimit !== undefined ? encashmentLimit : leaveConfig.encashmentLimit;
    leaveConfig.validityDays = validityDays !== undefined ? validityDays : leaveConfig.validityDays;
    leaveConfig.isPaidLeave = isPaidLeave !== undefined ? isPaidLeave : leaveConfig.isPaidLeave;
    leaveConfig.posts = posts || leaveConfig.posts;

    await leaveConfig.save({ session });

    // Sync updates to active employee balances
    await syncLeaveLimitsForConfig(leaveConfig, session);

    await session.commitTransaction();

    // Cache Invalidation
    await removeCache(`${CACHE_KEY.PREFIX}${id}`);
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

    return res.status(200).json(new ApiResponse(200, leaveConfig, "Leave configuration updated and limits synced successfully", true));
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

export const deleteLeaveConfig = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || (user.role !== "Admin" && user.role !== "HR Manager")) {
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin and HR Manager can delete leave configurations.", false));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const leaveConfig = await LeaveConfig.findById(id).session(session);
    if (!leaveConfig) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json(new ApiResponse(404, {}, "Leave configuration not found", false));
    }

    await leaveConfig.deleteOne({ session });

    // Remove this leave policy from all employee leave limits
    await LeaveLimit.updateMany(
      { "leaveDetails.leaveType": leaveConfig._id },
      { $pull: { leaveDetails: { leaveType: leaveConfig._id } } },
      { session }
    );

    await session.commitTransaction();

    // Cache Invalidation
    await removeCache(`${CACHE_KEY.PREFIX}${id}`);
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

    return res.status(200).json(new ApiResponse(200, {}, "Leave configuration deleted and removed from employee limits successfully", true));
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});