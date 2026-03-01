import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import moment from "moment";
import mongoose from "mongoose";
import Attendance from "../models/attendance.model.js";
import { Payroll } from "../models/payroll.model.js";
import { Leave } from "../models/leave.model.js";
import { User } from "../models/user.model.js";
import { Employee } from "../models/employee.model.js";
import { AdvancePayment } from "../models/advancedPayment.model.js"; // Fixed typo in import
import { getCache, setCache, removeCachePattern } from "../utils/cache.js";

// ==========================================
// CONFIGURATION & HELPERS
// ==========================================

const CACHE_KEY = {
  HR_STATS: "dash_hr_stats",             // Global HR Stats
  EMP_STATS: "dash_emp_stats_",          // Employee specific
  HR_DETAIL_ATT: "dash_det_att_",        
  HR_DETAIL_PAY: "dash_det_pay_",
  HR_DETAIL_LEAVE: "dash_det_leave_",
  SITE_ATTENDANCE: "dash_site_att_"      // New Cache key for site detailed attendance
};

const getLastMonthString = () => moment().subtract(1, "month").format("YYYY-MM");
const getCurrentMonthString = () => moment().format("YYYY-MM");

export const invalidateDashboardCache = async (specificUserId = null) => {
    try {
        await removeCachePattern(`${CACHE_KEY.HR_STATS}*`);
        await removeCachePattern(`${CACHE_KEY.SITE_ATTENDANCE}*`);
        if (specificUserId) {
            await removeCachePattern(`${CACHE_KEY.EMP_STATS}${specificUserId}`);
        }
        console.log("Dashboard Cache Invalidated");
    } catch (error) {
        console.error("Error clearing dashboard cache", error);
    }
};

// ==========================================
// HR DASHBOARD CONTROLLER
// ==========================================

const getHRDashboardStats = asyncHandler(async (req, res) => {
  const cachedStats = await getCache(CACHE_KEY.HR_STATS);
  if (cachedStats) {
      return res.status(200).json(new ApiResponse(200, cachedStats, "HR dashboard statistics fetched from Cache"));
  }

  const lastMonth = getLastMonthString();
  const currentMonth = getCurrentMonthString();
  const todayStart = moment().startOf("day").toDate();
  const todayEnd = moment().endOf("day").toDate();

  const [attendanceStats, payrollStats, leaveStats, siteWiseStats] = await Promise.all([
      getAttendanceStats(currentMonth),
      getPayrollStats(lastMonth, currentMonth),
      getLeaveStats(todayStart, todayEnd),
      getSiteWiseStats(todayStart, todayEnd)
  ]);

  const responsePayload = {
      attendanceStats, 
      payrollStats,    
      leaveStats,      
      siteWiseStats,   
  };

  await setCache(CACHE_KEY.HR_STATS, responsePayload, 300);

  return res.status(200).json(new ApiResponse(200, responsePayload, "HR dashboard statistics fetched successfully"));
});

// --- HR Logic Helpers ---

async function getAttendanceStats(monthStr) {
  const attendanceAggregation = await Attendance.aggregate([
    { $match: { month: monthStr, isLeave: false, isWeekOff: false, punchInTime: { $ne: null } } },
    {
      $group: {
        _id: null,
        averageAttendance: { $avg: "$attendancePercentage" },
      },
    },
  ]);

  const activeEmployees = await Attendance.distinct("employeeId", { month: monthStr });

  return {
    month: monthStr,
    averageAttendancePercentage: attendanceAggregation[0]?.averageAttendance?.toFixed(2) || 0,
    activeEmployeeCount: activeEmployees.length || 0,
  };
}

async function getPayrollStats(lastMonthStr, currentMonthStr) {
  const getStatsForMonth = async (month) => {
    const records = await Payroll.find({ month }).lean();
    
    const processed = records.filter(p => p.status === 'paid');
    const pending = records.filter(p => ['draft', 'processed'].includes(p.status));

    return {
        processedAmount: processed.reduce((sum, p) => sum + (p.netSalary || 0), 0),
        pendingAmount: pending.reduce((sum, p) => sum + (p.netSalary || 0), 0),
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

async function getLeaveStats(todayStart, todayEnd) {
  const employeesOnLeaveToday = await Leave.countDocuments({
    status: "Approved",
    startDate: { $lte: todayEnd },
    endDate: { $gte: todayStart },
  });

  const currentMonthStart = moment().startOf("month").toDate();
  const currentMonthEnd = moment().endOf("month").toDate();

  const [leaveApplicationsThisMonth, acceptedLeaveApplicationsThisMonth] = await Promise.all([
      Leave.countDocuments({ appliedOn: { $gte: currentMonthStart, $lte: currentMonthEnd } }),
      Leave.countDocuments({ status: "Approved", appliedOn: { $gte: currentMonthStart, $lte: currentMonthEnd } })
  ]);

  return { employeesOnLeaveToday, leaveApplicationsThisMonth, acceptedLeaveApplicationsThisMonth };
}

// FIXED: Now relies strictly on today's Attendance records to prevent application-date bugs.
async function getSiteWiseStats(todayStart, todayEnd) {
    return await Attendance.aggregate([
        { 
            $match: { date: { $gte: todayStart, $lte: todayEnd } } 
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
        { $unwind: { path: "$siteDetails", preserveNullAndEmptyArrays: true } },
        {
            $group: {
                _id: "$siteDetails.siteName",
                present: { 
                    $sum: { $cond: [{ $and: [{ $ne: ["$punchInTime", null] }, { $eq: ["$isLeave", false] }, { $eq: ["$isWeekOff", false] }] }, 1, 0] } 
                },
                leave: { 
                    $sum: { $cond: [{ $eq: ["$isLeave", true] }, 1, 0] } 
                },
                weekoff: { 
                    $sum: { $cond: [{ $eq: ["$isWeekOff", true] }, 1, 0] } 
                }
            }
        },
        {
            $project: {
                _id: 0,
                site: { $ifNull: ["$_id", "Unassigned"] },
                present: 1,
                leave: 1,
                weekoff: 1
            }
        }
    ]);
}


// ==========================================
// NEW: DETAILED SITE ATTENDANCE
// ==========================================

const getDetailedSiteAttendance = asyncHandler(async (req, res) => {
    const { siteId } = req.params;
    const queryDate = req.query.date ? moment(req.query.date) : moment();
    
    if (!siteId) {
        return res.status(400).json(new ApiResponse(400, null, "Site ID is required"));
    }

    const todayStart = queryDate.startOf('day').toDate();
    const todayEnd = queryDate.endOf('day').toDate();
    
    const cacheKey = `${CACHE_KEY.SITE_ATTENDANCE}${siteId}_${queryDate.format('YYYYMMDD')}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Detailed site attendance fetched from Cache"));
    }

    // High-performance single pipeline to fetch employees, their posts/departments, and today's exact status
    const siteAttendanceData = await Employee.aggregate([
        // 1. Match Active Employees belonging to the Site
        { 
            $match: { 
                site: new mongoose.Types.ObjectId(siteId), 
                status: { $in: ['Active', 'Probation', 'Trainee', 'Contractual'] } 
            } 
        },
        // 2. Lookup Post & Department
        { $lookup: { from: 'posts', localField: 'post', foreignField: '_id', as: 'postDoc' } },
        { $unwind: { path: '$postDoc', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'departments', localField: 'postDoc.department', foreignField: '_id', as: 'deptDoc' } },
        { $unwind: { path: '$deptDoc', preserveNullAndEmptyArrays: true } },
        // 3. Lookup Today's Attendance Record
        {
            $lookup: {
                from: 'attendances',
                let: { empId: '$_id' },
                pipeline: [
                    { 
                        $match: {
                            $expr: { $eq: ['$employeeId', '$$empId'] },
                            date: { $gte: todayStart, $lte: todayEnd }
                        }
                    }
                ],
                as: 'attendance'
            }
        },
        { $unwind: { path: '$attendance', preserveNullAndEmptyArrays: true } },
        // 4. Assign Status
        {
            $addFields: {
                status: {
                    $switch: {
                        branches: [
                            { case: { $eq: ['$attendance.isLeave', true] }, then: 'Leave' },
                            { case: { $eq: ['$attendance.isWeekOff', true] }, then: 'WeekOff' },
                            { case: { $ne: ['$attendance.punchInTime', null] }, then: 'Present' }
                        ],
                        default: 'Absent'
                    }
                }
            }
        },
        // 5. Group by Department and Post First
        {
            $group: {
                _id: {
                    deptId: '$deptDoc._id',
                    deptName: '$deptDoc.name',
                    postId: '$postDoc._id',
                    postTitle: '$postDoc.title'
                },
                employees: {
                    $push: {
                        employeeId: '$employeeId',
                        firstName: '$firstName',
                        middleName: '$middleName',
                        lastName: '$lastName',
                        status: '$status',
                        punchInTime: '$attendance.punchInTime'
                    }
                }
            }
        },
        // 6. Group by Department to create the nested arrays
        {
            $group: {
                _id: { deptId: '$_id.deptId', deptName: '$_id.deptName' },
                posts: {
                    $push: {
                        postId: '$_id.postId',
                        postTitle: { $ifNull: ['$_id.postTitle', 'Unassigned Post'] },
                        present: { $filter: { input: '$employees', as: 'e', cond: { $eq: ['$$e.status', 'Present'] } } },
                        leave: { $filter: { input: '$employees', as: 'e', cond: { $eq: ['$$e.status', 'Leave'] } } },
                        weekOff: { $filter: { input: '$employees', as: 'e', cond: { $eq: ['$$e.status', 'WeekOff'] } } },
                        absent: { $filter: { input: '$employees', as: 'e', cond: { $eq: ['$$e.status', 'Absent'] } } }
                    }
                }
            }
        },
        // 7. Format Final Output
        {
            $project: {
                _id: 0,
                departmentId: '$_id.deptId',
                departmentName: { $ifNull: ['$_id.deptName', 'Unassigned Department'] },
                posts: 1
            }
        },
        { $sort: { departmentName: 1 } }
    ]);

    await setCache(cacheKey, siteAttendanceData, 300);

    return res.status(200).json(new ApiResponse(200, siteAttendanceData, "Detailed site attendance fetched successfully"));
});


// ==========================================
// DETAILED LIST CONTROLLERS
// ==========================================

const getDetailedAttendance = asyncHandler(async (req, res) => {
  const currentMonth = getCurrentMonthString();
  const { page = 1, limit = 10, sort = "date", order = "desc", search = "" } = req.query;

  const cacheKey = `${CACHE_KEY.HR_DETAIL_ATT}p${page}_l${limit}_s${sort}_o${order}_q${search}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) return res.status(200).json(new ApiResponse(200, cachedData, "Detailed attendance fetched from Cache"));

  const query = { month: currentMonth };
  
  const [attendanceRecords, totalRecords] = await Promise.all([
      Attendance.find(query)
        .populate("employeeId", "firstName lastName email")
        .sort({ [sort]: order === "desc" ? -1 : 1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Attendance.countDocuments(query)
  ]);

  const responsePayload = {
      success: true,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: parseInt(page),
      attendanceRecords,
  };

  await setCache(cacheKey, responsePayload, 300);
  return res.status(200).json(new ApiResponse(200, responsePayload, "Detailed attendance records fetched successfully"));
});

const getDetailedPayroll = asyncHandler(async (req, res) => {
  const currentMonth = getCurrentMonthString();
  const { page = 1, limit = 10, sort = "processedAt", order = "desc", search = "" } = req.query;

  const cacheKey = `${CACHE_KEY.HR_DETAIL_PAY}p${page}_l${limit}_s${sort}_o${order}_q${search}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) return res.status(200).json(new ApiResponse(200, cachedData, "Detailed payroll fetched from Cache"));

  const query = { month: currentMonth };

  const [payrollRecords, totalRecords] = await Promise.all([
      Payroll.find(query)
        .populate("employee", "firstName lastName email")
        .sort({ [sort]: order === "desc" ? -1 : 1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Payroll.countDocuments(query)
  ]);

  const responsePayload = {
      success: true,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: parseInt(page),
      payrollRecords,
  };

  await setCache(cacheKey, responsePayload, 300);
  return res.status(200).json(new ApiResponse(200, responsePayload, "Detailed payroll records fetched successfully"));
});

const getDetailedLeaves = asyncHandler(async (req, res) => {
  const currentMonthStart = moment().startOf("month").toDate();
  const currentMonthEnd = moment().endOf("month").toDate();
  const { page = 1, limit = 10, sort = "appliedOn", order = "desc", search = "", status = "" } = req.query;

  const cacheKey = `${CACHE_KEY.HR_DETAIL_LEAVE}p${page}_l${limit}_s${sort}_o${order}_q${search}_st${status}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) return res.status(200).json(new ApiResponse(200, cachedData, "Detailed leaves fetched from Cache"));

  const query = { appliedOn: { $gte: currentMonthStart, $lte: currentMonthEnd } };
  if (status) query.status = status;

  const [leaveRecords, totalRecords] = await Promise.all([
      Leave.find(query)
        .populate("employeeId", "firstName lastName email")
        .populate("leaveType", "leaveName")
        .populate("approvedOrDisapprovedBy", "firstName lastName")
        .sort({ [sort]: order === "desc" ? -1 : 1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Leave.countDocuments(query)
  ]);

  const responsePayload = {
      success: true,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: parseInt(page),
      leaveRecords,
  };

  await setCache(cacheKey, responsePayload, 300);
  return res.status(200).json(new ApiResponse(200, responsePayload, "Detailed leave applications fetched successfully"));
});

// ==========================================
// EMPLOYEE DASHBOARD CONTROLLER
// ==========================================

const getEmployeeDashboardStats = asyncHandler(async (req, res) => {
    const userId = req.auth.userId;
    if (!userId) return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  
    const cacheKey = `${CACHE_KEY.EMP_STATS}${userId}`;
    const cachedStats = await getCache(cacheKey);
    if (cachedStats) return res.status(200).json(new ApiResponse(200, cachedStats, "Employee dashboard stats fetched from Cache"));

    const currentMonth = getCurrentMonthString();
    const todayStart = moment().startOf("day").toDate();
    const todayEnd = moment().endOf("day").toDate();
    
    const user = await User.findOne({ userId }).lean();
    if (!user || !user.employeeId) return res.status(404).json(new ApiResponse(404, {}, "User or Employee record not found", false));

    const employeeId = user.employeeId;
    
    const [attendanceStats, payrollStats, leaveStats, advancePayoutStats] = await Promise.all([
        getEmployeeAttendanceStats(employeeId, currentMonth),
        getEmployeePayrollStats(employeeId, currentMonth),
        getEmployeeLeaveStats(employeeId, todayStart, todayEnd, currentMonth),
        getEmployeeAdvancePayoutStats(employeeId)
    ]);
  
    const responsePayload = { attendanceStats, payrollStats, leaveStats, advancePayoutStats };

    await setCache(cacheKey, responsePayload, 300);
    return res.status(200).json(new ApiResponse(200, responsePayload, "Employee dashboard statistics fetched successfully"));
});
  
// --- Employee Logic Helpers ---

async function getEmployeeAttendanceStats(employeeId, month) {
  const payroll = await Payroll.findOne({ employee: employeeId, month: month }).lean();
  return { attendancePercentage: payroll?.attendance?.attendancePercentage?.toFixed(2) || 0 };
}
  
async function getEmployeePayrollStats(employeeId, month) {
  const payroll = await Payroll.findOne({ employee: employeeId, month: month }).lean();
  return { netSalary: payroll?.netSalary || 0, status: payroll?.status || "Not Processed" };
}
  
async function getEmployeeLeaveStats(employeeId, todayStart, todayEnd, currentMonth) {
  const [pendingLeaves, processedLeaves, totalLeaves] = await Promise.all([
      Leave.countDocuments({ employeeId, status: "Pending" }),
      Leave.countDocuments({ employeeId, status: { $in: ["Approved", "Disapproved"] } }),
      Leave.aggregate([
          { $match: { employeeId, status: "Approved" } },
          { $group: { _id: null, totalLeavesUsed: { $sum: 1 } } } 
      ])
  ]);
  
  return {
    pendingLeaves,
    processedLeaves,
    totalLeavesUsed: totalLeaves[0]?.totalLeavesUsed || 0,
  };
}
  
async function getEmployeeAdvancePayoutStats(employeeId) {
  const [pendingRequests, processedRequests] = await Promise.all([
      AdvancePayment.countDocuments({ employeeId, status: "Pending" }),
      AdvancePayment.countDocuments({ employeeId, status: { $in: ["Approved", "Rejected", "Paid"] } })
  ]);
  
  return { pendingRequests, processedRequests };
}
  
export {
  getHRDashboardStats,
  getDetailedSiteAttendance,
  getEmployeeDashboardStats,
  getDetailedAttendance,
  getDetailedPayroll,
  getDetailedLeaves
};