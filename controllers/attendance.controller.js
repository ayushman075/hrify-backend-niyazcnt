import Attendance from '../models/attendance.model.js';
import Matrices from '../models/attendanceMatrices.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';
import { Employee } from '../models/employee.model.js';
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "attendance_",           // Single ID: attendance_12345
  LIST_PREFIX: "attendance_list_"  // Query lists: attendance_list_month_...
};

// --- Helper Function to derive Week ID (WWYY) ---
const getWeekId = (dateInput) => {
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

const calculateAttendancePercentage = async (post, date, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchOutTime) {
    return 0;
  }

  let scheduledMinutes = 0;

  // 1. Try to get minutes from Scheduled Shift
  if (scheduledShift && scheduledShift.shiftId) {
    const shiftStartTime = scheduledShift.shiftId.startTime;
    const shiftEndTime = scheduledShift.shiftId.endTime;

    const dateShiftStartTimeString = `${new Date().toDateString()} ${shiftStartTime}`;
    const dateShiftEndTimeString = `${new Date().toDateString()} ${shiftEndTime}`;
    
    scheduledMinutes = Math.floor((new Date(dateShiftEndTimeString) - new Date(dateShiftStartTimeString)) / 60000);
  } 
  // 2. Fallback: Get minutes from Post Working Hours
  else if (post && post.workingHour) {
    scheduledMinutes = post.workingHour * 60; 
  }

  if (scheduledMinutes === 0) return 0;

  const workedMinutes = Math.floor((new Date(punchOutTime) - new Date(punchInTime)) / 60000);

  if (workedMinutes > scheduledMinutes) {
    const simplePercentage = (workedMinutes / scheduledMinutes) * 100;
    return Math.round(simplePercentage);
  }

  let attendancePercentage = 100;
  
  const timeDifference = workedMinutes - scheduledMinutes; 
  
  const thresholds = post.lateAttendanceMetrics;

  if (thresholds && timeDifference !== 0) {
      const absDifference = Math.abs(timeDifference);
      
      const sortedMetrics = thresholds.sort((a, b) => b.allowedMinutes - a.allowedMinutes);

      const applicableLateMetric = sortedMetrics.find(metric => absDifference > metric.allowedMinutes);

      if (applicableLateMetric) {
        attendancePercentage -= applicableLateMetric.attendanceDeductionPercent;
      }
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

    // Validation
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

    // 1. Fetch Employee & Post FIRST
    const employee = await Employee.findById(employeeId).populate("post");
    if (!employee) {
       return res.status(404).json(new ApiResponse(404, null, "Employee not found", false));
    }

    // 2. Get scheduled shift
    const scheduledShift = await ShiftRoster.findOne({
      employeeId,
      date: new Date(date)
    }).populate("shiftId");

    let attendancePercentage = 100;

    // 3. Calculate Percentage
    if (!isLeave) {
      attendancePercentage = await calculateAttendancePercentage(
        employee.post,
        date,
        punchInTime,
        punchOutTime ? punchOutTime : null,
        scheduledShift, 
      );
    }

    // Get month name from date
    const monthDate = new Date(date);
    const monthYear = monthDate.getFullYear();
    const monthMonth = String(monthDate.getMonth() + 1).padStart(2, '0');
    const month = `${monthYear}-${monthMonth}`;

    // --- Derive Week ---
    const week = getWeekId(date);

    // Prepare attendance data
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

    // Try to find existing attendance record
    const existingAttendance = await Attendance.findOne({
      employeeId,
      date: new Date(date)
    });

    let attendance;
    if (existingAttendance) {
      // Update existing record
      attendance = await Attendance.findByIdAndUpdate(
        existingAttendance._id,
        attendanceData,
        { new: true }
      );
      
      // [CACHE INVALIDATION]
      await removeCache(`${CACHE_KEY.PREFIX}${existingAttendance._id}`);
      await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

      return res.status(200).json(
        new ApiResponse(200, attendance, "Attendance updated successfully", true)
      );
    } else {
      // Create new record
      attendance = new Attendance(attendanceData);
      await attendance.save();

      // [CACHE INVALIDATION]
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

  // [CACHE READ] Create a key specific to this query
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}one_emp${employeeId}_date${new Date(date).toISOString().split('T')[0]}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance fetched from Cache", true));
  }

  const attendance = await Attendance.findOne({ employeeId, date: new Date(date) }).populate('employeeId');

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, "Attendance not found", false));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance fetched successfully", true));
});

const getAttendanceByMonth = asyncHandler(async (req, res) => {
  const { employeeId, month } = req.query;

  if (!employeeId || !month) {
    return res.status(400).json(new ApiResponse(400, {}, "Employee ID and month are required", false));
  }

  // [CACHE READ]
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}emp${employeeId}_mon${month}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const attendance = await Attendance.find({ employeeId, month }).populate('employeeId');

  if (!attendance) {
    return res.status(404).json(new ApiResponse(404, {}, "No attendance records found for this employee in the given month", false));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, attendance, 3600);

  return res.status(200).json(new ApiResponse(200, attendance, "Attendance records fetched successfully", true));
});

const getAllAttendanceForMonth = asyncHandler(async (req, res) => {
  const { month } = req.query;

  if (!month) {
    return res.status(400).json(new ApiResponse(400, {}, "Month is required", false));
  }

  // [CACHE READ]
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_mon${month}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const attendance = await Attendance.find({ month }).populate('employeeId');

  // [CACHE WRITE]
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
  
  // Update week if date changes
  if (date) {
    attendance.date = new Date(date);
    attendance.week = getWeekId(date); 
  }

  const scheduledShift = await ShiftRoster.findOne({
    employeeId: attendance.employeeId,
    date: new Date(attendance.date)
  }).populate("shiftId");

  let attendancePercentage = 100;
  
  // Fallback Logic
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

  // [CACHE INVALIDATION]
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

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, {}, "Attendance deleted successfully", true));
});

const getAttendanceByWeek = asyncHandler(async (req, res) => {
  const { week, employeeId } = req.query;

  if (!week || !/^\d{4}$/.test(week)) {
    return res.status(400).json(new ApiResponse(400, {}, "Valid Week identifier (WWYY) is required (e.g., 0225)", false));
  }

  // [CACHE READ]
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
    // Note: We don't cache 404s usually, or cache empty array. Here caching empty array is fine.
    return res.status(404).json(new ApiResponse(404, [], "No attendance records found for this week", false));
  }

  // [CACHE WRITE]
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

  // [CACHE READ]
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}all_week${week}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Attendance records from Cache", true));
  }

  const attendance = await Attendance.find({ week }).populate('employeeId');

  // [CACHE WRITE]
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
        // We invalidate individual cache inside the loop or bulk invalidate at the end.
        // Doing strictly required key invalidation here:
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

  // [CACHE INVALIDATION]
  // Bulk operations affect many lists, safest to clear all attendance lists
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

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

const getFilteredAttendance = asyncHandler(async (req, res) => {
  const {
    sort = "date",
    order = "desc",
    filters = {},
    page = 1,
    limit = 10
  } = req.query;

  // [CACHE READ] Complex unique key for filtered queries
  // We stringify filters to ensure exact match on criteria
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

  if (filters.employeeId) {
    query.employeeId = filters.employeeId;
  }

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