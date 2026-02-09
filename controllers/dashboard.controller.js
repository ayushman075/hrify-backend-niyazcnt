import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import moment from "moment";
import Attendance from "../models/attendance.model.js";
import { Payroll } from "../models/payroll.model.js";
import { Leave } from "../models/leave.model.js";
import { User } from "../models/user.model.js";
import { Employee } from "../models/employee.model.js";
import { AdvancePayment } from "../models/advancedPayment.model.js";
import { getCache, setCache, removeCachePattern } from "../utils/cache.js";

// ==========================================
// CONFIGURATION & HELPERS
// ==========================================

const CACHE_KEY = {
  HR_STATS: "dash_hr_stats",             // Global HR Stats
  EMP_STATS: "dash_emp_stats_",          // Employee specific: dash_emp_stats_123
  HR_DETAIL_ATT: "dash_det_att_",        // Detailed lists...
  HR_DETAIL_PAY: "dash_det_pay_",
  HR_DETAIL_LEAVE: "dash_det_leave_"
};

const getLastMonthString = () => moment().subtract(1, "month").format("YYYY-MM");
const getCurrentMonthString = () => moment().format("YYYY-MM");

/**
 * EXPORTED HELPER: Cache Invalidator
 * Import and call this function in your Attendance/Leave/Payroll controllers
 * whenever data is created or updated.
 */
export const invalidateDashboardCache = async (specificUserId = null) => {
    try {
        // 1. Clear Global HR Stats
        await removeCachePattern(CACHE_KEY.HR_STATS);
        
        // 2. Clear Specific Employee Stats if ID provided
        if (specificUserId) {
            await removeCachePattern(`${CACHE_KEY.EMP_STATS}${specificUserId}`);
        }
        
        // 3. Optional: Clear list caches if strictly necessary 
        // (Usually lists are short-lived or paginated, so aggressive clearing isn't always needed)
        
        console.log("Dashboard Cache Invalidated");
    } catch (error) {
        console.error("Error clearing dashboard cache", error);
    }
};

// ==========================================
// HR DASHBOARD CONTROLLER
// ==========================================

const getHRDashboardStats = asyncHandler(async (req, res) => {
  // [CACHE READ] Check for global stats
  const cachedStats = await getCache(CACHE_KEY.HR_STATS);
  if (cachedStats) {
      return res.status(200).json(new ApiResponse(200, cachedStats, "HR dashboard statistics fetched from Cache"));
  }

  // Timeframes
  const lastMonth = getLastMonthString();
  const currentMonth = getCurrentMonthString();
  const todayStart = moment().startOf("day").toDate();
  const todayEnd = moment().endOf("day").toDate();

  // Run independent queries in parallel for performance
  const [attendanceStats, payrollStats, leaveStats, siteWiseStats] = await Promise.all([
      // 1. Attendance Stats (Current Month)
      getAttendanceStats(currentMonth),
      
      // 2. Payroll Stats (Previous AND Current Month)
      getPayrollStats(lastMonth, currentMonth),
      
      // 3. Leave Stats (Current Month)
      getLeaveStats(todayStart, todayEnd),

      // 4. Site-wise Stats (Today)
      getSiteWiseStats(todayStart, todayEnd)
  ]);

  const responsePayload = {
      attendanceStats, 
      payrollStats,    
      leaveStats,      
      siteWiseStats,   
  };

  // [CACHE WRITE] Save for 5 minutes
  await setCache(CACHE_KEY.HR_STATS, responsePayload, 300);

  return res.status(200).json(
    new ApiResponse(
      200,
      responsePayload,
      "HR dashboard statistics fetched successfully"
    )
  );
});

// --- HR Logic Helpers ---

// 1. Attendance Statistics (Current Month)
async function getAttendanceStats(monthStr) {
  const attendanceAggregation = await Attendance.aggregate([
    { $match: { month: monthStr } },
    {
      $group: {
        _id: null,
        averageAttendance: { $avg: "$attendancePercentage" },
        count: { $sum: 1 },
      },
    },
  ]);

  const activeEmployees = await Attendance.distinct("employeeId", {
    month: monthStr,
  });

  return {
    month: monthStr,
    averageAttendancePercentage: attendanceAggregation[0]?.averageAttendance?.toFixed(2) || 0,
    activeEmployeeCount: activeEmployees.length || 0,
  };
}

// 2. Payroll Statistics (Last Month vs Current Month)
async function getPayrollStats(lastMonthStr, currentMonthStr) {
  
  const getStatsForMonth = async (month) => {
    const records = await Payroll.find({ month });
    
    const processed = records.filter(p => p.status === 'paid');
    const pending = records.filter(p => ['draft', 'processed'].includes(p.status));

    const processedAmount = processed.reduce((sum, p) => sum + (p.netSalary || 0), 0);
    const pendingAmount = pending.reduce((sum, p) => sum + (p.netSalary || 0), 0);

    return {
        processedAmount,
        pendingAmount,
        totalCount: records.length,
        processedCount: processed.length,
        pendingCount: pending.length
    };
  };

  const [lastMonthStats, currentMonthStats] = await Promise.all([
      getStatsForMonth(lastMonthStr),
      getStatsForMonth(currentMonthStr)
  ]);

  return {
    lastMonth: { month: lastMonthStr, ...lastMonthStats },
    currentMonth: { month: currentMonthStr, ...currentMonthStats }
  };
}

// 3. Leave Statistics (Current Month + Today)
async function getLeaveStats(todayStart, todayEnd) {
  // Count employees on leave today
  const employeesOnLeaveToday = await Leave.countDocuments({
    status: "Approved",
    startDate: { $lte: todayEnd },
    endDate: { $gte: todayStart },
  });

  const currentMonthStart = moment().startOf("month").toDate();
  const currentMonthEnd = moment().endOf("month").toDate();

  // All applications this month
  const leaveApplicationsThisMonth = await Leave.countDocuments({
    appliedOn: { $gte: currentMonthStart, $lte: currentMonthEnd },
  });

  // Approved applications this month
  const acceptedLeaveApplicationsThisMonth = await Leave.countDocuments({
    status: "Approved",
    appliedOn: { $gte: currentMonthStart, $lte: currentMonthEnd },
  });

  return {
    employeesOnLeaveToday,
    leaveApplicationsThisMonth,
    acceptedLeaveApplicationsThisMonth,
  };
}

// 4. Site Wise Stats (Present & Leave Today)
async function getSiteWiseStats(todayStart, todayEnd) {
    // A. Aggregate Present Today by Site
    const presentBySite = await Attendance.aggregate([
        { 
            $match: { 
                date: { $gte: todayStart, $lte: todayEnd },
                isLeave: false // Only count actual present
            } 
        },
        {
            $lookup: {
                from: "employees", 
                localField: "employeeId",
                foreignField: "_id",
                as: "employee"
            }
            
        },
        { $unwind: "$employee" },
        {
            $lookup: {
                from: "sites", 
                localField: "employee.site",
                foreignField: "_id",
                as: "siteDetails"
            }
        },
        {
            $unwind: { path: "$siteDetails", preserveNullAndEmptyArrays: true }
        },
        {
            $group: {
                _id: "$siteDetails.siteName", // Group by Site Name
                presentCount: { $sum: 1 }
            }
        }
    ]);

    // B. Aggregate Approved Leaves Today by Site
    const leavesBySite = await Leave.aggregate([
        { 
            $match: { 
                status: "Approved",
                startDate: { $lte: todayEnd },
                endDate: { $gte: todayStart }
            } 
        },
        {
            $lookup: {
                from: "employees",
                localField: "employeeId",
                foreignField: "_id",
                as: "employee"
            }
        },
        { $unwind: "$employee" },
        {
            $lookup: {
                from: "sites",
                localField: "employee.site",
                foreignField: "_id",
                as: "siteDetails"
            }
        },
        {
            $unwind: { path: "$siteDetails", preserveNullAndEmptyArrays: true }
        },
        {
            $group: {
                _id: "$siteDetails.siteName",
                leaveCount: { $sum: 1 }
            }
        }
    ]);

    // C. Merge the data into a single array
    const siteMap = new Map();

    // Helper to get or create map entry
    const getEntry = (name) => {
        const siteName = name || "Unassigned"; // Handle null sites
        if (!siteMap.has(siteName)) {
            siteMap.set(siteName, { site: siteName, present: 0, leave: 0 });
        }
        return siteMap.get(siteName);
    };

    presentBySite.forEach(item => {
        const entry = getEntry(item._id);
        entry.present = item.presentCount;
    });

    leavesBySite.forEach(item => {
        const entry = getEntry(item._id);
        entry.leave = item.leaveCount;
    });

    // Convert Map to Array
    return Array.from(siteMap.values());
}


// ==========================================
// DETAILED LIST CONTROLLERS
// ==========================================

const getDetailedAttendance = asyncHandler(async (req, res) => {
  const currentMonth = getCurrentMonthString();
  const {
    page = 1,
    limit = 10,
    sort = "date",
    order = "desc",
    search = "",
  } = req.query;

  const cacheKey = `${CACHE_KEY.HR_DETAIL_ATT}p${page}_l${limit}_s${sort}_o${order}_q${search}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
      return res.status(200).json(new ApiResponse(200, cachedData, "Detailed attendance fetched from Cache"));
  }

  const query = { month: currentMonth };
  
  // Note: Searching inside populated fields in Mongo requires aggregation or post-filtering. 
  // For simple implementation, we assume client might filter by exact ID or simple fields, 
  // or we implement aggregation if searching by Name is strict requirement.
  // Here keeping it simple based on previous code structure:
  
  const attendanceRecords = await Attendance.find(query)
    .populate("employeeId", "name email department")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalRecords = await Attendance.countDocuments(query);

  const responsePayload = {
      success: true,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: parseInt(page),
      attendanceRecords,
  };

  await setCache(cacheKey, responsePayload, 300);

  return res.status(200).json(
    new ApiResponse(
      200,
      responsePayload,
      "Detailed attendance records fetched successfully"
    )
  );
});

const getDetailedPayroll = asyncHandler(async (req, res) => {
  const currentMonth = getCurrentMonthString();
  const {
    page = 1,
    limit = 10,
    sort = "processedAt",
    order = "desc",
    search = "",
  } = req.query;

  const cacheKey = `${CACHE_KEY.HR_DETAIL_PAY}p${page}_l${limit}_s${sort}_o${order}_q${search}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
      return res.status(200).json(new ApiResponse(200, cachedData, "Detailed payroll fetched from Cache"));
  }

  const query = { month: currentMonth };

  const payrollRecords = await Payroll.find(query)
    .populate("employee", "name email department")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalRecords = await Payroll.countDocuments(query);

  const responsePayload = {
      success: true,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: parseInt(page),
      payrollRecords,
  };

  await setCache(cacheKey, responsePayload, 300);

  return res.status(200).json(
    new ApiResponse(
      200,
      responsePayload,
      "Detailed payroll records fetched successfully"
    )
  );
});

const getDetailedLeaves = asyncHandler(async (req, res) => {
  const currentMonthStartDate = moment().startOf("month").toDate();
  const currentMonthEndDate = moment().endOf("month").toDate();
  const {
    page = 1,
    limit = 10,
    sort = "appliedOn",
    order = "desc",
    search = "",
    status = "",
  } = req.query;

  const cacheKey = `${CACHE_KEY.HR_DETAIL_LEAVE}p${page}_l${limit}_s${sort}_o${order}_q${search}_st${status}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
      return res.status(200).json(new ApiResponse(200, cachedData, "Detailed leaves fetched from Cache"));
  }

  const query = {
    appliedOn: {
      $gte: currentMonthStartDate,
      $lte: currentMonthEndDate,
    },
  };

  if (status) {
    query.status = status;
  }

  const leaveRecords = await Leave.find(query)
    .populate("employeeId", "name email department")
    .populate("leaveType", "name")
    .populate("approvedOrDisapprovedBy", "name")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalRecords = await Leave.countDocuments(query);

  const responsePayload = {
      success: true,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: parseInt(page),
      leaveRecords,
  };

  await setCache(cacheKey, responsePayload, 300);

  return res.status(200).json(
    new ApiResponse(
      200,
      responsePayload,
      "Detailed leave applications fetched successfully"
    )
  );
});

// ==========================================
// EMPLOYEE DASHBOARD CONTROLLER
// ==========================================

const getEmployeeDashboardStats = asyncHandler(async (req, res) => {
    const userId = req.auth.userId;
    if (!userId) {
      return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
    }
  
    // [CACHE READ] Check for specific employee stats
    const cacheKey = `${CACHE_KEY.EMP_STATS}${userId}`;
    const cachedStats = await getCache(cacheKey);
    if (cachedStats) {
        return res.status(200).json(new ApiResponse(200, cachedStats, "Employee dashboard stats fetched from Cache"));
    }

    const currentMonth = getCurrentMonthString();
    const today = moment().startOf("day").toDate();
    const todayEnd = moment().endOf("day").toDate();
    
    const user = await User.findOne({ userId });
    if (!user || !user.employeeId) {
      return res.status(404).json(new ApiResponse(404, {}, "User or Employee record not found", false));
    }

    const employeeId = user.employeeId;
    
    // Fetch stats
    const attendanceStats = await getEmployeeAttendanceStats(employeeId, currentMonth);
    const payrollStats = await getEmployeePayrollStats(employeeId, currentMonth);
    const leaveStats = await getEmployeeLeaveStats(employeeId, today, todayEnd, currentMonth);
    const advancePayoutStats = await getEmployeeAdvancePayoutStats(employeeId);
  
    const responsePayload = {
        attendanceStats,
        payrollStats,
        leaveStats,
        advancePayoutStats,
    };

    // [CACHE WRITE] 5 min TTL
    await setCache(cacheKey, responsePayload, 300);

    return res.status(200).json(
      new ApiResponse(
        200,
        responsePayload,
        "Employee dashboard statistics fetched successfully"
      )
    );
});
  
// --- Employee Logic Helpers ---

async function getEmployeeAttendanceStats(employeeId, month) {
  const payroll = await Payroll.findOne({ employee: employeeId, month: month });
  return {
    attendancePercentage: payroll?.attendance?.attendancePercentage?.toFixed(2) || 0,
  };
}
  
async function getEmployeePayrollStats(employeeId, month) {
  const payroll = await Payroll.findOne({ employee: employeeId, month: month });
  return {
    netSalary: payroll?.netSalary || 0,
    status: payroll?.status || "Not Processed",
  };
}
  
async function getEmployeeLeaveStats(employeeId, today, todayEnd, currentMonth) {
  const pendingLeaves = await Leave.countDocuments({ employeeId, status: "Pending" });
  const processedLeaves = await Leave.countDocuments({ employeeId, status: { $in: ["Approved", "Disapproved"] } });
  
  const totalLeaves = await Leave.aggregate([
    { $match: { employeeId, status: "Approved" } },
    { $group: { _id: null, totalLeavesUsed: { $sum: 1 } } }, // Assuming 1 doc = 1 day, or use $sum: "$days" if days field exists
  ]);
  
  return {
    pendingLeaves,
    processedLeaves,
    totalLeavesUsed: totalLeaves[0]?.totalLeavesUsed || 0,
  };
}
  
async function getEmployeeAdvancePayoutStats(employeeId) {
  const pendingRequests = await AdvancePayment.countDocuments({ employeeId, status: "Pending" });
  const processedRequests = await AdvancePayment.countDocuments({ employeeId, status: { $in: ["Approved", "Rejected"] } });
  
  return {
    pendingRequests,
    processedRequests,
  };
}
  
export {
  getHRDashboardStats,
  getEmployeeDashboardStats,
  getDetailedAttendance,
  getDetailedPayroll,
  getDetailedLeaves
};