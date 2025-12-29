import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";

import moment from "moment";
import Attendance from "../models/attendance.model.js";
import { Payroll } from "../models/payroll.model.js";
import { Leave } from "../models/leave.model.js";
import { User } from "../models/user.model.js";
import { AdvancePayment } from "../models/advancedPayment.model.js";


const getLastMonthString = () => {
  const lastMonth = moment().subtract(1, "month");
  return lastMonth.format("YYYY-MM");
};

const getCurrentMonthString = () => {
  return moment().format("YYYY-MM");
};

const getHRDashboardStats = asyncHandler(async (req, res) => {
  const lastMonth = getLastMonthString();
  const currentMonth = getCurrentMonthString();
  const today = moment().startOf("day");
  const todayEnd = moment().endOf("day");

  // 1. Last Month Attendance Stats
  const attendanceStats = await getAttendanceStats(lastMonth);

  // 2. Last Month Payroll Stats
  const payrollStats = await getPayrollStats(lastMonth);

  // 3. Leave Stats
  const leaveStats = await getLeaveStats(today, todayEnd, currentMonth);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        attendanceStats,
        payrollStats,
        leaveStats,
      },
      "HR dashboard statistics fetched successfully"
    )
  );
});

// Get attendance statistics for last month
async function getAttendanceStats(lastMonth) {
  // Get average attendance percentage for last month
  const attendanceAggregation = await Attendance.aggregate([
    { $match: { month: lastMonth } },
    {
      $group: {
        _id: null,
        averageAttendance: { $avg: "$attendancePercentage" },
        count: { $sum: 1 },
      },
    },
  ]);

  // Count unique active employees who had attendance records last month
  const activeEmployees = await Attendance.distinct("employeeId", {
    month: lastMonth,
  });

  return {
    averageAttendancePercentage:
      attendanceAggregation[0]?.averageAttendance?.toFixed(2) || 0,
    activeEmployeeCount: activeEmployees.length || 0,
  };
}

// Get payroll statistics for last month
async function getPayrollStats(lastMonth) {
  // Get total processed payroll amount
  const processedPayrolls = await Payroll.find({
    month: lastMonth,
    status: "paid",
  });

  const processedAmount = processedPayrolls.reduce(
    (total, payroll) => total + payroll.netSalary,
    0
  );

  // Get total pending payroll amount
  const pendingPayrolls = await Payroll.find({
    month: lastMonth,
    status: { $in: ["draft", "processed"] },
  });

  const pendingAmount = pendingPayrolls.reduce(
    (total, payroll) => total + payroll.netSalary,
    0
  );

  return {
    processedAmount,
    pendingAmount,
    totalPayrolls: processedPayrolls.length + pendingPayrolls.length,
  };
}

// Get leave statistics
async function getLeaveStats(today, todayEnd, currentMonth) {
  // Count employees on leave today
  const employeesOnLeaveToday = await Leave.countDocuments({
    status: "Approved",
    startDate: { $lte: todayEnd },
    endDate: { $gte: today },
  });

  // Count leave applications for this month
  const currentMonthStartDate = moment().startOf("month").toDate();
  const currentMonthEndDate = moment().endOf("month").toDate();

  const leaveApplicationsThisMonth = await Leave.countDocuments({
    appliedOn: {
      $gte: currentMonthStartDate,
      $lte: currentMonthEndDate,
    },
  });

  // Count accepted leave applications for this month
  const acceptedLeaveApplicationsThisMonth = await Leave.countDocuments({
    status: "Approved",
    appliedOn: {
      $gte: currentMonthStartDate,
      $lte: currentMonthEndDate,
    },
  });

  return {
    employeesOnLeaveToday,
    leaveApplicationsThisMonth,
    acceptedLeaveApplicationsThisMonth,
  };
}

// Get detailed attendance for last month
const getDetailedAttendance = asyncHandler(async (req, res) => {
  const lastMonth = getLastMonthString();
  const {
    page = 1,
    limit = 10,
    sort = "date",
    order = "desc",
    search = "",
  } = req.query;

  const query = { month: lastMonth };
  if (search) {
    // Assume we're searching by employee name through population
    query["$or"] = [
      { "employee.name": { $regex: search, $options: "i" } },
    ];
  }

  const attendanceRecords = await Attendance.find(query)
    .populate("employeeId", "name email department")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalRecords = await Attendance.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        success: true,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        currentPage: parseInt(page),
        attendanceRecords,
      },
      "Detailed attendance records fetched successfully"
    )
  );
});

// Get detailed payroll for last month
const getDetailedPayroll = asyncHandler(async (req, res) => {
  const lastMonth = getLastMonthString();
  const {
    page = 1,
    limit = 10,
    sort = "processedAt",
    order = "desc",
    search = "",
  } = req.query;

  const query = { month: lastMonth };
  if (search) {
    query["$or"] = [
      { "employee.name": { $regex: search, $options: "i" } },
    ];
  }

  const payrollRecords = await Payroll.find(query)
    .populate("employee", "name email department")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalRecords = await Payroll.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        success: true,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        currentPage: parseInt(page),
        payrollRecords,
      },
      "Detailed payroll records fetched successfully"
    )
  );
});

// Get detailed leave applications for current month
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

  const query = {
    appliedOn: {
      $gte: currentMonthStartDate,
      $lte: currentMonthEndDate,
    },
  };

  if (search) {
    query["$or"] = [
      { "employeeId.name": { $regex: search, $options: "i" } },
    ];
  }

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

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        success: true,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        currentPage: parseInt(page),
        leaveRecords,
      },
      "Detailed leave applications fetched successfully"
    )
  );
});




const getEmployeeDashboardStats = asyncHandler(async (req, res) => {
    const lastMonth = getLastMonthString();
    const currentMonth = getCurrentMonthString();
    const today = moment().startOf("day");
    const todayEnd = moment().endOf("day");
      const userId = req.auth.userId;
      if (!userId) {
        return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
      }
    
      const user = await User.findOne({ userId });
      if (!user ) {
        return res.status(401).json(new ApiResponse(401, {}, "Only Admin can create departments", false));
      }

      const employeeId = user.employeeId
    
  
    // Fetch stats
    const attendanceStats = await getEmployeeAttendanceStats(employeeId, lastMonth);
    const payrollStats = await getEmployeePayrollStats(employeeId, lastMonth);
    const leaveStats = await getEmployeeLeaveStats(employeeId, today, todayEnd, currentMonth);
    const advancePayoutStats = await getEmployeeAdvancePayoutStats(employeeId);
  
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          attendanceStats,
          payrollStats,
          leaveStats,
          advancePayoutStats,
        },
        "Employee dashboard statistics fetched successfully"
      )
    );
  });
  
  // Get attendance statistics for the employee
  async function getEmployeeAttendanceStats(employeeId, lastMonth) {
    const payroll = await Payroll.findOne({ employee:employeeId, month: lastMonth });
    return {
      attendancePercentage: payroll?.attendance?.attendancePercentage?.toFixed(2) || 0,
    };
  }
  
  // Get payroll statistics for the employee
  async function getEmployeePayrollStats(employeeId, lastMonth) {
    const payroll = await Payroll.findOne({ employee: employeeId, month: lastMonth });
    return {
      netSalary: payroll?.netSalary || 0,
      status: payroll?.status || "Not Processed",
    };
  }
  
  // Get leave statistics for the employee
  async function getEmployeeLeaveStats(employeeId, today, todayEnd, currentMonth) {
    const pendingLeaves = await Leave.countDocuments({ employeeId, status: "Pending" });
    const processedLeaves = await Leave.countDocuments({ employeeId, status: { $in: ["Approved", "Rejected"] } });
  
    const totalLeaves = await Leave.aggregate([
      { $match: { employeeId, status: "Approved" } },
      { $group: { _id: null, totalLeavesUsed: { $sum: "$days" } } },
    ]);
  
    return {
      pendingLeaves,
      processedLeaves,
      totalLeavesUsed: totalLeaves[0]?.totalLeavesUsed || 0,
    };
  }
  
  // Get advance payout request statistics
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
  getEmployeeDashboardStats
};