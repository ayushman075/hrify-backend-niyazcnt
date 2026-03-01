/**
 * leave.controller.js
 *
 * IST contract (consistent with all other controllers):
 * - All `date` fields stored as midnightIST("YYYY-MM-DD") = 2025-07-08T18:30:00.000Z for "2025-07-09"
 * - month/week always derived from IST wall-clock, never from server local time or UTC toISOString()
 * - Leave refresh logic is NOT run inside read endpoints — belongs in a cron job
 */
  
import Attendance   from '../models/attendance.model.js';
import { Leave }    from '../models/leave.model.js';
import LeaveLimit   from '../models/leaveLimit.model.js';
import { LeaveConfig } from '../models/leaveConfig.model.js';
import { User }     from '../models/user.model.js';
import { Employee } from '../models/employee.model.js';
import { ApiResponse }  from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

// ─── Cache keys ───────────────────────────────────────────────────────────────

const CACHE_KEY = {
  PREFIX:          'leave_',
  LIST_PREFIX:     'leave_list_',
  ATTENDANCE_LIST: 'attendance_list_',
};

const AUTHORIZED_APPROVER_ROLES = new Set(['Admin', 'HR Manager', 'HR Assistance', 'Head Of Department']);

// ─── IST date helpers (Robust against server timezone) ────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// FIX 1: Removed getTimezoneOffset() so it works perfectly regardless of whether 
// the server is hosted in UTC, IST, or any other timezone.
const toIST = (input = new Date()) => {
  const date = new Date(input);
  return new Date(date.getTime() + IST_OFFSET_MS);
};

const toISTDateString = (input) => {
  const ist = toIST(input);
  return [
    ist.getUTCFullYear(),
    String(ist.getUTCMonth() + 1).padStart(2, '0'),
    String(ist.getUTCDate()).padStart(2, '0'),
  ].join('-');
};

const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

const toISTMonthString = (input) => {
  const ist = toIST(input);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

const toISTWeekString = (input) => {
  const ist = toIST(input);
  const thursday = new Date(ist.getTime());
  thursday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  return String(weekNo).padStart(2, '0') + String(thursday.getUTCFullYear()).slice(-2);
};

const inclusiveDayCount = (startInput, endInput) => {
  const start = midnightIST(toISTDateString(startInput));
  const end   = midnightIST(toISTDateString(endInput));
  return Math.round((end - start) / 86_400_000) + 1;
};

// ─── Cache invalidation helper ────────────────────────────────────────────────

const invalidateLeaveCaches = async (leaveId) => {
  await Promise.allSettled([
    leaveId ? removeCache(`${CACHE_KEY.PREFIX}${leaveId}`) : Promise.resolve(),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    removeCachePattern(`${CACHE_KEY.ATTENDANCE_LIST}*`),
    invalidateDashboardCache(),
  ]);
};

// ─── Leave limit helpers ──────────────────────────────────────────────────────

const getOrInitLeaveLimit = async (employee) => {
  let leaveLimit = await LeaveLimit.findOne({ employeeId: employee._id });
  const leaveConfigs = await LeaveConfig.find({ posts: employee.post });

  if (!leaveConfigs.length) return null;

  if (!leaveLimit) {
    const daysSinceJoining = Math.ceil((Date.now() - new Date(employee.dateOfJoining)) / 86_400_000);

    leaveLimit = await LeaveLimit.create({
      employeeId:    employee._id,
      postId:        employee.post,
      joinDate:      employee.dateOfJoining,
      lastRefreshed: new Date(),
      leaveDetails:  leaveConfigs.map((config) => ({
        leaveType:       config._id,
        usedLeaves:      0,
        remainingLeaves: daysSinceJoining >= config.eligibilityDays ? config.totalLeaves : 0,
      })),
    });
    return leaveLimit;
  }

  const existingIds = new Set(leaveLimit.leaveDetails.map((d) => d.leaveType.toString()));
  const daysSinceJoining = Math.ceil((Date.now() - new Date(employee.dateOfJoining)) / 86_400_000);
  let mutated = false;

  for (const config of leaveConfigs) {
    if (!existingIds.has(config._id.toString())) {
      leaveLimit.leaveDetails.push({
        leaveType:       config._id,
        usedLeaves:      0,
        remainingLeaves: daysSinceJoining >= config.eligibilityDays ? config.totalLeaves : 0,
      });
      mutated = true;
    }
  }

  if (mutated) await leaveLimit.save();
  return leaveLimit;
};

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const applyForLeave = asyncHandler(async (req, res) => {
  const { employeeId, leaveType, startDate, endDate, reason } = req.body;

  if (!employeeId || !leaveType || !startDate || !endDate || !reason) {
    return res.status(400).json(new ApiResponse(400, {}, 'Required fields are missing', false));
  }

  const leaveConfig = await LeaveConfig.findById(leaveType);
  if (!leaveConfig) {
    return res.status(404).json(new ApiResponse(404, {}, 'Invalid leave type. Leave configuration not found.', false));
  }

  const startIST = midnightIST(toISTDateString(startDate));
  const endIST   = midnightIST(toISTDateString(endDate));

  if (endIST < startIST) {
    return res.status(400).json(new ApiResponse(400, {}, 'endDate must be on or after startDate', false));
  }

  const overlapping = await Leave.findOne({
    employeeId,
    status: { $in: ['Pending', 'Approved'] },
    startDate: { $lte: endIST },
    endDate:   { $gte: startIST },
  });

  if (overlapping) {
    return res.status(409).json(new ApiResponse(409, {}, 'There are overlapping leaves for the selected dates', false));
  }

  const leaveApplication = await Leave.create({
    employeeId,
    leaveType,
    startDate: startIST,
    endDate:   endIST,
    reason,
  });

  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(201).json(new ApiResponse(201, leaveApplication, 'Leave application submitted successfully', true));
});

export const approveOrDisapproveLeave = asyncHandler(async (req, res) => {
  const { id, status, comments } = req.body;
  const userId = req.auth.userId;

  if (!id) {
    return res.status(400).json(new ApiResponse(400, {}, 'Leave application ID is required', false));
  }

  if (!['Approved', 'Disapproved', 'Pending'].includes(status)) {
    return res.status(400).json(new ApiResponse(400, {}, "status must be 'Approved', 'Disapproved', or 'Pending'", false));
  }

  const user = await User.findOne({ userId });
  if (!user || !AUTHORIZED_APPROVER_ROLES.has(user.role)) {
    return res.status(403).json(new ApiResponse(403, {}, 'Unauthorized', false));
  }

  const leaveApplication = await Leave.findById(id)
    .populate('leaveType')
    .populate('employeeId');

  if (!leaveApplication) {
    return res.status(404).json(new ApiResponse(404, {}, 'Leave application not found', false));
  }

  const previousStatus = leaveApplication.status;

  if (previousStatus === status) {
    return res.status(400).json(new ApiResponse(400, {}, `Leave is already ${status}`, false));
  }

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (status === 'Approved') {
    const employee = await Employee.findById(leaveApplication.employeeId);
    if (!employee) {
      return res.status(404).json(new ApiResponse(404, {}, 'Employee not found', false));
    }

    const leaveLimit = await getOrInitLeaveLimit(employee);
    if (!leaveLimit) {
      return res.status(404).json(new ApiResponse(404, {}, 'No leave configurations found for this employee\'s post', false));
    }

    const leaveDetail = leaveLimit.leaveDetails.find(
      (d) => d.leaveType.toString() === leaveApplication.leaveType._id.toString()
    );

    if (!leaveDetail) {
      return res.status(404).json(new ApiResponse(404, {}, 'Leave type not configured for this employee.', false));
    }

    const leaveDays = inclusiveDayCount(leaveApplication.startDate, leaveApplication.endDate);

    if (leaveDays > leaveDetail.remainingLeaves) {
      leaveApplication.status                = 'Disapproved';
      leaveApplication.comments              = 'Insufficient leave balance';
      leaveApplication.approvedOrDisapprovedBy = user._id;
      await leaveApplication.save();
      return res.status(409).json(new ApiResponse(409, {}, 'Insufficient leave balance for the requested leave type', false));
    }

    // ── Build attendance records for each leave day ──────────────────────
    const bulkOps = [];
    let cursor = midnightIST(toISTDateString(leaveApplication.startDate));
    const endIST = midnightIST(toISTDateString(leaveApplication.endDate));
    
    // Check Paid vs Unpaid from LeaveConfig
    const isPaidLeave = leaveApplication.leaveType.isPaidLeave === true;
    const leaveAttendancePercentage = isPaidLeave ? 100 : 0;

    while (cursor <= endIST) {
      const dateStr = toISTDateString(cursor);
      const dateForDB = midnightIST(dateStr);

      bulkOps.push({
        updateOne: {
          filter: {
            employeeId: leaveApplication.employeeId._id,
            date:       dateForDB,
          },
          update: {
            $set: {
              employeeId:           leaveApplication.employeeId._id,
              date:                 dateForDB,
              month:                toISTMonthString(cursor),
              week:                 toISTWeekString(cursor),
              isLeave:              true,
              leaveId:              leaveApplication._id,
              attendancePercentage: leaveAttendancePercentage,
              punchInTime:          null, // FIX 2: Explicitly clear punches so frontend reads N/A
              punchOutTime:         null, 
            },
          },
          upsert: true,
        },
      });

      cursor = new Date(cursor.getTime() + 86_400_000); 
    }

    if (bulkOps.length) {
      await Attendance.bulkWrite(bulkOps);
    }

    // Deduct balance
    leaveDetail.remainingLeaves -= leaveDays;
    leaveDetail.usedLeaves      += leaveDays;
    await leaveLimit.save();
  }

  // ── UN-APPROVE (Approved → anything else) ────────────────────────────────
  else if (previousStatus === 'Approved') {
    const leaveDays = inclusiveDayCount(leaveApplication.startDate, leaveApplication.endDate);

    const leaveLimit = await LeaveLimit.findOne({ employeeId: leaveApplication.employeeId });
    if (leaveLimit) {
      const leaveDetail = leaveLimit.leaveDetails.find(
        (d) => d.leaveType.toString() === leaveApplication.leaveType._id.toString()
      );
      if (leaveDetail) {
        leaveDetail.remainingLeaves = Math.min(
          leaveDetail.remainingLeaves + leaveDays,
          leaveApplication.leaveType.totalLeaves ?? Infinity
        );
        leaveDetail.usedLeaves = Math.max(0, leaveDetail.usedLeaves - leaveDays);
        await leaveLimit.save();
      }
    }

    // Remove the attendance records generated by the approval
    await Attendance.deleteMany({
      employeeId: leaveApplication.employeeId,
      leaveId:    leaveApplication._id,
    });
  }

  leaveApplication.status                  = status;
  leaveApplication.comments                = comments ?? leaveApplication.comments;
  leaveApplication.approvedOrDisapprovedBy = user._id;
  await leaveApplication.save();

  await invalidateLeaveCaches(id);

  return res.status(200).json(
    new ApiResponse(200, leaveApplication, `Leave application ${status.toLowerCase()} successfully`, true)
  );
});

export const updateLeaveApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comments, reason, startDate: newStartDate, endDate: newEndDate } = req.body;
  const userId = req.auth.userId;

  const leaveApplication = await Leave.findById(id)
    .populate('leaveType')
    .populate('employeeId');

  if (!leaveApplication) {
    return res.status(404).json(new ApiResponse(404, {}, 'Leave application not found.', false));
  }

  const user = await User.findOne({ userId });
  if (!user) {
    return res.status(403).json(new ApiResponse(403, {}, 'User not found', false));
  }

  const isOwner    = leaveApplication.employeeId._id.toString() === user._id.toString();
  const isPrivileged = AUTHORIZED_APPROVER_ROLES.has(user.role);

  if (!isOwner && !isPrivileged) {
    return res.status(403).json(new ApiResponse(403, {}, 'You are not authorized to update this leave application.', false));
  }

  if (leaveApplication.status !== 'Pending') {
    return res.status(400).json(new ApiResponse(400, {}, 'Only pending leave applications can be updated.', false));
  }

  if (newStartDate) leaveApplication.startDate = midnightIST(toISTDateString(newStartDate));
  if (newEndDate)   leaveApplication.endDate   = midnightIST(toISTDateString(newEndDate));
  if (comments)     leaveApplication.comments  = comments;
  if (reason)       leaveApplication.reason    = reason;

  if (leaveApplication.endDate < leaveApplication.startDate) {
    return res.status(400).json(new ApiResponse(400, {}, 'endDate must be on or after startDate', false));
  }

  const updated = await leaveApplication.save();

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(new ApiResponse(200, updated, 'Leave application updated successfully.', true));
});

export const deleteLeaveApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const leaveApplication = await Leave.findById(id);
  if (!leaveApplication) {
    return res.status(404).json(new ApiResponse(404, {}, 'Leave application not found.', false));
  }

  if (leaveApplication.status !== 'Pending') {
    return res.status(409).json(new ApiResponse(409, {}, 'Cannot delete leave applications that are already processed.', false));
  }

  await Leave.findByIdAndDelete(id);

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    removeCachePattern(`${CACHE_KEY.ATTENDANCE_LIST}*`),
  ]);

  return res.status(200).json(new ApiResponse(200, {}, 'Leave application deleted successfully.', true));
});

export const getLeaveApplicationById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;
  const cached   = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json(new ApiResponse(200, cached, 'Leave application retrieved from cache.', true));
  }

  const leaveApplication = await Leave.findById(id)
    .populate('leaveType', 'leaveType totalLeaves validityDays carryForwardAllowed')
    .populate('employeeId', 'firstName lastName employeeId');

  if (!leaveApplication) {
    return res.status(404).json(new ApiResponse(404, {}, 'Leave application not found.', false));
  }

  await setCache(cacheKey, leaveApplication, 3600);
  return res.status(200).json(new ApiResponse(200, leaveApplication, 'Leave application retrieved successfully.', true));
});

export const getAllLeaveApplications = asyncHandler(async (req, res) => {
  const {
    page      = 1,
    limit     = 10,
    sortBy    = 'appliedOn',
    sortOrder = 'desc',
    employeeId,
    leaveType,
    status,
    startDate,
    endDate,
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 10);

  const filterKey = JSON.stringify({ employeeId, leaveType, status, startDate, endDate, sortBy, sortOrder });
  const cacheKey  = `${CACHE_KEY.LIST_PREFIX}p${pageNum}_l${limitNum}_${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json(new ApiResponse(200, cached, 'Leave applications retrieved from cache.', true));
  }

  const filterConditions = {};
  if (employeeId) filterConditions.employeeId = employeeId;
  if (leaveType)  filterConditions.leaveType  = leaveType;
  if (status)     filterConditions.status     = status;

  if (startDate || endDate) {
    filterConditions.startDate = {};
    if (startDate) filterConditions.startDate.$gte = midnightIST(toISTDateString(startDate));
    if (endDate) {
      const endIST = new Date(midnightIST(toISTDateString(endDate)).getTime() + 86_400_000 - 1);
      filterConditions.startDate.$lte = endIST;
    }
  }

  const [leaveApplications, total] = await Promise.all([
    Leave.find(filterConditions)
      .populate('leaveType', 'leaveType totalLeaves')
      .populate('employeeId', 'firstName lastName employeeId')
      .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Leave.countDocuments(filterConditions),
  ]);

  const payload = {
    leaveApplications,
    totalPages:           Math.ceil(total / limitNum),
    currentPage:          pageNum,
    totalLeaveApplications: total,
  };

  await setCache(cacheKey, payload, 3600);

  return res.status(200).json(new ApiResponse(200, payload, 'Leave applications retrieved successfully.', true));
});

// ══════════════════════════════════════════════════════════════════════════════
// CRON JOB — Leave balance refresh
// ══════════════════════════════════════════════════════════════════════════════

export const refreshLeaveLimits = async () => {
  console.log('[LeaveRefresh] Starting leave limit refresh...');
  const now = new Date();

  const allLimits = await LeaveLimit.find().populate('leaveDetails.leaveType');
  let refreshed = 0;

  for (const limit of allLimits) {
    const daysSinceJoining = Math.ceil((now - new Date(limit.joinDate)) / 86_400_000);
    let mutated = false;

    for (const detail of limit.leaveDetails) {
      const config = detail.leaveType; 
      if (!config?.validityDays || config.validityDays <= 0) continue;

      if (daysSinceJoining > 0 && daysSinceJoining % config.validityDays === 0) {
        if (config.carryForwardAllowed) {
          const carryLimit = config.carryForwardLimit ?? 0;
          const unused     = Math.min(detail.remainingLeaves, carryLimit);
          detail.remainingLeaves = config.totalLeaves + unused;
        } else {
          detail.remainingLeaves = config.totalLeaves;
        }
        detail.usedLeaves = 0;
        mutated = true;
      }
    }

    if (mutated) {
      limit.lastRefreshed = now;
      await limit.save();
      refreshed++;
    }
  }

  console.log(`[LeaveRefresh] Done. Refreshed ${refreshed} of ${allLimits.length} records.`);
};