import Attendance from '../models/attendance.model.js';
import Matrices from '../models/attendanceMatrices.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';
import { Employee } from '../models/employee.model.js';
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";
import { invalidateDashboardCache } from './dashboard.controller.js';

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "attendance_",           // Single ID
  LIST_PREFIX: "attendance_list_"  // Query lists
};

// --- Helper Function to derive Week ID (WWYY) ---
export const getWeekId = (dateInput) => {
  const date = new Date(dateInput);
  
  // Get Year (Last 2 digits)
  const yearShort = date.getFullYear().toString().slice(-2);

  // Get ISO Week Number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);

  // Pad week with 0
  const weekString = weekNo.toString().padStart(2, '0');

  return `${weekString}${yearShort}`; // e.g., "0225"
};

const calculateAttendancePercentage = (post, date, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchOutTime) return 0; 

  let scheduledMinutes = 0;

  // 1. Try Shift Roster
  if (scheduledShift && scheduledShift.shiftId) {
    const shiftStartTime = scheduledShift.shiftId.startTime;
    const shiftEndTime = scheduledShift.shiftId.endTime;
    const dateStr = new Date(date).toDateString(); 
    scheduledMinutes = Math.floor((new Date(`${dateStr} ${shiftEndTime}`) - new Date(`${dateStr} ${shiftStartTime}`)) / 60000);
  } 
  // 2. Fallback to Post Working Hours
  else if (post && post.workingHour) {
    scheduledMinutes = post.workingHour * 60; 
  }

  if (scheduledMinutes === 0) return 0;

  const workedMinutes = Math.floor((new Date(punchOutTime) - new Date(punchInTime)) / 60000);

  if (workedMinutes >= scheduledMinutes) {
    return Math.round((workedMinutes / scheduledMinutes) * 100);
  }

  const absDifference = scheduledMinutes - workedMinutes;
  const thresholds = post?.lateAttendanceMetrics || [];

  const sortedMetrics = thresholds.sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const largestMetric = sortedMetrics.length > 0 ? sortedMetrics[0] : null;

  if (!largestMetric || absDifference > largestMetric.allowedMinutes) {
     return Math.round((workedMinutes / scheduledMinutes) * 100);
  }

  let attendancePercentage = 100;
  const applicableLateMetric = sortedMetrics.find(metric => absDifference > metric.allowedMinutes);

  if (applicableLateMetric) {
    attendancePercentage -= applicableLateMetric.attendanceDeductionPercent;
  }

  return Math.max(0, Math.round(attendancePercentage));
};

const createAttendance = asyncHandler(async (req, res) => {
  try {
    let {
      employeeId,
      date,
      punchInTime,
      punchOutTime,
      isLeave = false,
      leaveId
    } = req.body;

    if (!employeeId || !date || !(punchInTime || isLeave)) {
      return res.status(400).json(
        new ApiResponse(400, null, "Missing required fields", false)
      );
    }

    if (punchOutTime && new Date(punchOutTime) <= new Date(punchInTime)) {
      const updatedPunchOutTime = new Date(punchOutTime);
      updatedPunchOutTime.setDate(updatedPunchOutTime.getDate() + 1);
      punchOutTime = updatedPunchOutTime;
    }

    const employee = await Employee.findById(employeeId).populate("post");
    if (!employee) {
       return res.status(404).json(new ApiResponse(404, null, "Employee not found", false));
    }

    const scheduledShift = await ShiftRoster.findOne({
      employeeId,
      date: new Date(date)
    }).populate("shiftId");

    let attendancePercentage = 100;

    if (!isLeave) {
      attendancePercentage = await calculateAttendancePercentage(
        employee.post,
        date,
        punchInTime,
        punchOutTime ? punchOutTime : null,
        scheduledShift, 
      );
    }

    const monthDate = new Date(date);
    const monthYear = monthDate.getFullYear();
    const monthMonth = String(monthDate.getMonth() + 1).padStart(2, '0');
    const month = `${monthYear}-${monthMonth}`;

    const week = getWeekId(date);

    const attendanceData = {
      employeeId,
      date: new Date(date),
      punchInTime: new Date(punchInTime),
      punchOutTime: punchOutTime ? new Date(punchOutTime) : null,
      isLeave,
      leaveId,
      month,
      week, 
      attendancePercentage
    };

    const existingAttendance = await Attendance.findOne({
      employeeId,
      date: new Date(date)
    });

    let attendance;
    if (existingAttendance) {
      attendance = await Attendance.findByIdAndUpdate(
        existingAttendance._id,
        attendanceData,
        { new: true }
      );
      
      await removeCache(`${CACHE_KEY.PREFIX}${existingAttendance._id}`);
      await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
      await invalidateDashboardCache();

      return res.status(200).json(
        new ApiResponse(200, attendance, "Attendance updated successfully", true)
      );
    } else {
      attendance = new Attendance(attendanceData);
      await attendance.save();

      await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

      return res.status(201).json(
        new ApiResponse(201, attendance, "Attendance created successfully", true)
      );
    }

  } catch (error) {
    console.error("Attendance operation error:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error processing attendance record", false)
    );
  }
});

const getAttendanceById = asyncHandler(async (req, res) => {
  const { employeeId, date } = req.query;

  if (!employeeId || !date) {
    return res.status(400).json(new ApiResponse(400, {}, "Employee ID and date are required", false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}one_emp${employeeId}_date${new Date(date).toISOString().split('T')[0]}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance fetched from Cache", true));
  }

  const attendance = await Attendance.findOne({ employeeId, date: new Date(date) }).populate('employeeId');

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, "Attendance not found", false));
  }

  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance fetched successfully", true));
});

const getAttendanceByMonth = asyncHandler(async (req, res) => {
  const { employeeId, month } = req.query;

  if (!employeeId || !month) {
    return res.status(400).json(new ApiResponse(400, {}, "Employee ID and month are required", false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}emp${employeeId}_mon${month}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const attendance = await Attendance.find({ employeeId, month }).populate('employeeId');

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, "No attendance records found for this employee in the given month", false));
  }

  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance records fetched successfully", true));
});

const getAllAttendanceForMonth = asyncHandler(async (req, res) => {
  const { month } = req.query;

  if (!month) {
    return res.status(400).json(new ApiResponse(400, {}, "Month is required", false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_mon${month}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const attendance = await Attendance.find({ month }).populate('employeeId');

  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance records for the month fetched successfully", true));
});

const updateAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { punchInTime, punchOutTime, date, isLeave, leaveId } = req.body;

  const attendance = await Attendance.findById(id);

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, "Attendance not found", false));
  }

  if (punchInTime) attendance.punchInTime = new Date(punchInTime);
  if (punchOutTime) attendance.punchOutTime = new Date(punchOutTime);
  if (isLeave !== undefined) attendance.isLeave = isLeave;
  if (leaveId) attendance.leaveId = leaveId;
  
  if (date) {
    attendance.date = new Date(date);
    attendance.week = getWeekId(date); 
  }

  const scheduledShift = await ShiftRoster.findOne({
    employeeId: attendance.employeeId,
    date: new Date(attendance.date)
  }).populate("shiftId");

  let attendancePercentage = 100;
  
  const employee = await Employee.findById(attendance.employeeId).populate("post");

  if (!isLeave && employee) {
    attendancePercentage = await calculateAttendancePercentage(
      employee.post,
      attendance.date,
      attendance.punchInTime,
      attendance.punchOutTime ? attendance.punchOutTime : null,
      scheduledShift,
    );
    attendance.attendancePercentage = attendancePercentage;
  }

  await attendance.save();

  await removeCache(`${CACHE_KEY.PREFIX}${id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance updated successfully", true));
});

const deleteAttendance = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const attendance = await Attendance.findByIdAndDelete(id);

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, "Attendance not found", false));
  }

  await removeCache(`${CACHE_KEY.PREFIX}${id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
  await invalidateDashboardCache();

  return res.status(200).json(new ApiResponse(200, {}, "Attendance deleted successfully", true));
});

const getAttendanceByWeek = asyncHandler(async (req, res) => {
  const { week, employeeId } = req.query;

  if (!week || !/^\d{4}$/.test(week)) {
    return res.status(400).json(new ApiResponse(400, {}, "Valid Week identifier (WWYY) is required (e.g., 0225)", false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}week${week}_emp${employeeId || 'all'}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const query = { week };
  if (employeeId) {
    query.employeeId = employeeId;
  }

  const attendance = await Attendance.find(query).populate('employeeId');

  if (!attendance || attendance.length === 0) {
    return res.status(404).json(new ApiResponse(404, [], "No attendance records found for this week", false));
  }

  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance records for the week fetched successfully", true));
});

const getAllAttendanceForWeek = asyncHandler(async (req, res) => {
  const { week } = req.query;

  if (!week) {
    return res.status(400).json(new ApiResponse(400, {}, "Week identifier (WWYY) is required", false));
  }
  if (!/^\d{4}$/.test(week)) {
     return res.status(400).json(new ApiResponse(400, {}, "Invalid Week format. Use WWYY (e.g., 0225)", false));
  }

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_week${week}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const attendance = await Attendance.find({ week }).populate('employeeId');

  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance records for the week fetched successfully", true));
});

const bulkCreateAttendance = asyncHandler(async (req, res) => {
  const attendanceData = req.body;

  if (!Array.isArray(attendanceData) || attendanceData.length === 0) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Invalid or empty attendance data", false));
  }

  const createdAttendance = [];
  const updatedAttendance = [];
  const failedRecords = [];

  for (const record of attendanceData) {
    const { employeeId, date, punchInTime, punchOutTime, isLeave = false, leaveId } = record;

    try {
      if (!employeeId || !/^\d{6}$/.test(String(employeeId))) {
        throw new Error(`Invalid employee ID format: ${employeeId}. Must be 6 digits.`);
      }

      if (!date || !(punchInTime || isLeave)) {
        throw new Error("Missing required fields: date, or punchInTime (unless it's leave).");
      }

      if (punchOutTime && new Date(punchOutTime) <= new Date(punchInTime)) {
        throw new Error("Punch out time must be after punch in time.");
      }

      const employee = await Employee.findOne({ employeeId: String(employeeId) }).populate("post");
      if (!employee) {
        throw new Error(`Employee with ID ${employeeId} not found.`);
      }

      const scheduledShift = await ShiftRoster.findOne({
        employeeId: employee._id,
        date: new Date(date)
      }).populate("shiftId");

      let attendancePercentage = 100;
      
      if (!isLeave) {
        attendancePercentage = await calculateAttendancePercentage(
          employee.post,
          date,
          punchInTime ? new Date(punchInTime) : null,
          punchOutTime ? new Date(punchOutTime) : null,
          scheduledShift
        );
      }

      const monthDate = new Date(date);
      const monthYear = monthDate.getFullYear();
      const monthMonth = String(monthDate.getMonth() + 1).padStart(2, "0");
      const month = `${monthYear}-${monthMonth}`;
      
      const week = getWeekId(date);

      const attendanceObj = {
        employeeId: employee._id, 
        date: new Date(date),
        punchInTime: punchInTime ? new Date(punchInTime) : null,
        punchOutTime: punchOutTime ? new Date(punchOutTime) : null,
        isLeave,
        leaveId,
        month,
        week, 
        attendancePercentage,
      };

      const existingAttendance = await Attendance.findOne({
        employeeId: employee._id,
        date: new Date(date),
      });

      let attendance;
      if (existingAttendance) {
        attendance = await Attendance.findByIdAndUpdate(existingAttendance._id, attendanceObj, { new: true });
        updatedAttendance.push(attendance);
        await removeCache(`${CACHE_KEY.PREFIX}${existingAttendance._id}`);
      } else {
        attendance = new Attendance(attendanceObj);
        await attendance.save();
        createdAttendance.push(attendance);
      }
    } catch (error) {
      failedRecords.push({
        record,
        error: error.message || "Unknown error occurred",
      });
    }
  }

  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
  await invalidateDashboardCache();

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        createdAttendance,
        updatedAttendance,
        failedRecords,
      },
      "Bulk attendance processing completed",
      true
    )
  );
});

// --- UPDATED FUNCTION ---
const getFilteredAttendance = asyncHandler(async (req, res) => {
  const {
    sort = "date",
    order = "desc",
    filters = {},
    page = 1,
    limit = 10
  } = req.query;

  // [CACHE READ] Key includes filters, so site filter is automatically handled in caching
  const filterKey = JSON.stringify(filters);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}filter_p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
  
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    console.log("Serving attendance from cache for key:", cacheKey);
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance retrieved from Cache!", true));
  }

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  const query = {};

  // --- SITE FILTER LOGIC ---
  // Attendance doesn't store site, so we must fetch employees belonging to the site first.
  if (filters.site) {
    try {
      // 1. Find all employees at this site
      const employeesAtSite = await Employee.find({ site: filters.site }).select('_id');
      const siteEmployeeIds = employeesAtSite.map(emp => emp._id);

      // 2. Handle potential conflict if `filters.employeeId` is also present
      if (filters.employeeId) {
        const isEmployeeAtSite = siteEmployeeIds.some(
            id => id.toString() === filters.employeeId.toString()
        );
        
        if (isEmployeeAtSite) {
            query.employeeId = filters.employeeId;
        } else {
            // The specific employee requested is NOT at the specific site requested.
            // Force return 0 results.
            query.employeeId = null; 
        }
      } else {
        // 3. Filter Attendance by list of IDs from that site
        // If site has no employees, siteEmployeeIds is [], result will be empty.
        query.employeeId = { $in: siteEmployeeIds };
      }
    } catch (error) {
        console.error("Error filtering by site:", error);
        // Fail gracefully or throw? Returning empty list usually safer for filter errors.
        return res.status(500).json(new ApiResponse(500, null, "Error applying site filter", false));
    }
  } else if (filters.employeeId) {
    // Standard employee filter (if no site filter)
    query.employeeId = filters.employeeId;
  }
  // -------------------------

  if (filters.month) {
    query.month = filters.month;
  }

  if (filters.isLeave) {
    query.isLeave = filters.isLeave;
  }
  
  if (filters.week) {
    query.week = filters.week;
  }

  if (filters.dateRange && filters.dateRange.length === 2) {
    query.date = {
      $gte: new Date(filters.dateRange[0]),
      $lte: new Date(filters.dateRange[1])
    };
  }

  try {
    const attendance = await Attendance.find(query)
      .populate("employeeId")
      .populate({ path: 'employeeId', populate: { path: 'site', select: 'siteName' } }) // Populate site info in response
      .sort({ [sort]: order === "desc" ? -1 : 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const totalAttendance = await Attendance.countDocuments(query);

    const responsePayload = {
        success: true,
        attendances: attendance, 
        totalPages: Math.ceil(totalAttendance / limitNum),
        currentPage: pageNum
    };

    // [CACHE WRITE]
    await setCache(cacheKey, responsePayload, 3600);

    return res.status(200).json(new ApiResponse(
      200,
      responsePayload,
      "Attendance retrieved successfully!",
      true
    ));
  } catch (error) {
    console.error("Error fetching attendance:", error);
    return res.status(500).json(new ApiResponse(
      500,
      null,
      "Error fetching attendance records",
      false
    ));
  }
});

export { createAttendance, getAttendanceById, getAttendanceByMonth, getAllAttendanceForMonth, updateAttendance, deleteAttendance, bulkCreateAttendance, getFilteredAttendance, getAttendanceByWeek, getAllAttendanceForWeek };