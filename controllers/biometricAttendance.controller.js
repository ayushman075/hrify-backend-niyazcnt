import axios from 'axios';
import Attendance from '../models/attendance.model.js';
import { Employee } from '../models/employee.model.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';

const BIOMETRIC_API_URL = 'https://klcloud.in/bims/api/v2/WebAPI/GetDeviceLogs';
const API_KEY = '275412062524';

// Helper function to get IST date objects
const getISTDate = (date = new Date()) => {
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  const utcTime = date.getTime() + (date.getTimezoneOffset() * 60000);
  return new Date(utcTime + istOffset);
};

// Helper function to convert biometric log date to proper IST Date object
const convertLogDateToIST = (logDate) => {
  try {
    // Input format: "2025-07-11 09:49:32"
    // Assuming this is already in IST
    const isoString = logDate.replace(' ', 'T');
    const date = new Date(isoString);
    
    // If the biometric system gives IST time, we need to adjust for storage
    // Create a date object that represents the IST time
    const istDate = new Date(isoString + '+05:30');
    return istDate;
  } catch (error) {
    console.error('Error converting log date to IST:', error);
    return null;
  }
};

// Helper function to get date in YYYY-MM-DD format using IST
const getDateStringIST = (date) => {
  const istDate = getISTDate(date);
  return istDate.toISOString().split('T')[0];
};

// Helper function to create IST date from YYYY-MM-DD string
const createISTDateFromString = (dateString) => {
  // Create date at midnight IST
  const istDate = new Date(dateString + 'T00:00:00+05:30');
  return istDate;
};

// Helper function to check if a date is the same day in IST
const isSameDayIST = (date1, date2) => {
  const d1 = getISTDate(date1);
  const d2 = getISTDate(date2);
  return d1.toDateString() === d2.toDateString();
};

// Helper function to calculate attendance percentage
const calculateAttendancePercentage = async (post, date, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchOutTime) {
    return 0;
  }

  const shiftStartTime = scheduledShift.shiftId.startTime;
  const shiftEndTime = scheduledShift.shiftId.endTime;

  // Use IST date for shift calculations
  const istDate = getISTDate(date);
  const dateString = istDate.toDateString();
  
  const dateShiftStartTimeString = `${dateString} ${shiftStartTime}`;
  const dateShiftEndTimeString = `${dateString} ${shiftEndTime}`;

  const scheduledMinutes = Math.floor((new Date(dateShiftEndTimeString) - new Date(dateShiftStartTimeString)) / 60000);
  const workedMinutes = Math.floor((new Date(punchOutTime) - new Date(punchInTime)) / 60000);

  let timeDifference = workedMinutes - Math.abs(scheduledMinutes);
  if (!scheduledMinutes) {
    timeDifference = 0;
  }

  const thresholds = post.lateAttendanceMetrics;
  let attendancePercentage = 100;

  if (thresholds && timeDifference !== 0) {
    const sortedMetrics = thresholds.sort((a, b) => b.allowedMinutes - a.allowedMinutes);
    const applicableLateMetric = sortedMetrics.find(metric => Math.abs(timeDifference) > metric.allowedMinutes);

    if (applicableLateMetric) {
      if (timeDifference < 0) {
        attendancePercentage -= applicableLateMetric.attendanceDeductionPercent;
      } else if (timeDifference > 0) {
        attendancePercentage += applicableLateMetric.attendanceDeductionPercent;
      }
    }
  }

  return Math.max(0, Math.min(100, attendancePercentage));
};

// Helper function to check if employee has incomplete attendance from previous day
const checkPreviousDayIncompleteAttendance = async (employeeId, targetDate) => {
  try {
    const previousDay = new Date(targetDate);
    previousDay.setDate(previousDay.getDate() - 1);
    
    // Find the last attendance record for the employee on the previous day
    const lastAttendance = await Attendance.findOne({
      employeeId: employeeId,
      date: previousDay,
      punchInTime: { $exists: true, $ne: null },
      punchOutTime: { $exists: false } // Missing punch out time
    }).sort({ punchInTime: -1 }); // Get the latest punch in without punch out

    return lastAttendance;
  } catch (error) {
    console.error('Error checking previous day attendance:', error);
    return null;
  }
};

// Improved function to process punch logs for an employee
const processPunchLogs = async (logs, targetDate, employeeId) => {
  if (!logs || logs.length === 0) {
    return [];
  }

  // Convert log dates to proper IST format and sort logs by timestamp
  const sortedLogs = logs
    .map(log => ({
      ...log,
      convertedDate: convertLogDateToIST(log.LogDate)
    }))
    .filter(log => log.convertedDate !== null) // Filter out invalid dates
    .sort((a, b) => a.convertedDate - b.convertedDate);
  
  // Check if employee has incomplete attendance from previous day
  const incompleteAttendance = await checkPreviousDayIncompleteAttendance(employeeId, targetDate);
  
  let startIndex = 0;
  let punchPairs = [];

  // If there's incomplete attendance from previous day, use first log as punch out
  if (incompleteAttendance && sortedLogs.length > 0) {
    const firstLog = sortedLogs[0];
    const firstLogDate = getDateStringIST(firstLog.convertedDate);
    const targetDateString = getDateStringIST(new Date(targetDate));
    
    // If first log is from target date, use it as punch out for previous day
    if (firstLogDate === targetDateString) {
      // Update the incomplete attendance record with punch out time
      await Attendance.findByIdAndUpdate(incompleteAttendance._id, {
        punchOutTime: firstLog.convertedDate
      });
      
      // Recalculate attendance percentage for the updated record
      const employee = await Employee.findById(employeeId).populate("post");
      const previousDayShift = await ShiftRoster.findOne({
        employeeId: employeeId,
        date: incompleteAttendance.date
      }).populate("shiftId");
      
      if (employee && previousDayShift) {
        const updatedPercentage = await calculateAttendancePercentage(
          employee.post,
          incompleteAttendance.date,
          incompleteAttendance.punchInTime,
          firstLog.convertedDate,
          previousDayShift
        );
        
        await Attendance.findByIdAndUpdate(incompleteAttendance._id, {
          attendancePercentage: updatedPercentage
        });
      }
      
      startIndex = 1; // Skip first log as it's used for previous day punch out
    }
  }

  // Process remaining logs in pairs (punch in, punch out)
  for (let i = startIndex; i < sortedLogs.length; i += 2) {
    const punchInTime = sortedLogs[i].convertedDate;
    let punchOutTime = null;

    // Check if we have a pair
    if (i + 1 < sortedLogs.length) {
      punchOutTime = sortedLogs[i + 1].convertedDate;
    }

    punchPairs.push({
      punchInTime,
      punchOutTime,
      date: targetDate
    });
  }

  return punchPairs;
};

// Function to group logs by employee
const groupLogsByEmployee = (logs) => {
  const groupedLogs = {};
  
  logs.forEach(log => {
    const employeeCode = log.EmployeeCode;
    if (!groupedLogs[employeeCode]) {
      groupedLogs[employeeCode] = [];
    }
    groupedLogs[employeeCode].push(log);
  });
  
  return groupedLogs;
};

// Function to handle odd number of punches by fetching next day's first log
const handleOddPunches = async (employeeCode, targetDate, punchPairs) => {
  if (punchPairs.length === 0) return punchPairs;

  const lastPair = punchPairs[punchPairs.length - 1];
  
  // If last pair has punch in but no punch out, try to get next day's first log
  if (lastPair.punchInTime && !lastPair.punchOutTime) {
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayString = getDateStringIST(nextDay);
    
    try {
      // Fetch next day's logs to find punch out
      const response = await axios.get(BIOMETRIC_API_URL, {
        params: {
          APIKey: API_KEY,
          FromDate: nextDayString,
          ToDate: nextDayString
        }
      });
      
      const nextDayLogs = response.data || [];
      const employeeNextDayLogs = nextDayLogs.filter(log => log.EmployeeCode === employeeCode);
      
      if (employeeNextDayLogs.length > 0) {
        // Convert dates and sort, then take first log as punch out
        const sortedNextDayLogs = employeeNextDayLogs
          .map(log => ({
            ...log,
            convertedDate: convertLogDateToIST(log.LogDate)
          }))
          .filter(log => log.convertedDate !== null)
          .sort((a, b) => a.convertedDate - b.convertedDate);
        
        if (sortedNextDayLogs.length > 0) {
          lastPair.punchOutTime = sortedNextDayLogs[0].convertedDate;
        }
      }
    } catch (error) {
      console.error(`Error fetching next day logs for employee ${employeeCode}:`, error);
    }
  }
  
  return punchPairs;
};

// Function to reconcile attendance for a specific date
const reconcileAttendanceForDate = async (date) => {
  try {
    console.log(`Starting attendance reconciliation for date: ${date} (IST)`);
    
    // Create proper IST date for the target date
    const targetDate = createISTDateFromString(date);
    
    // Delete all existing attendance records for the date
    await Attendance.deleteMany({ 
      date: targetDate 
    });
    console.log(`Deleted existing attendance records for ${date}`);
    
    // Fetch logs for target date and next day (to handle punch out scenarios)
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayString = getDateStringIST(nextDay);
    
    console.log(`Fetching logs from ${date} to ${nextDayString}`);
    
    const response = await axios.get(BIOMETRIC_API_URL, {
      params: {
        APIKey: API_KEY,
        FromDate: date,
        ToDate: nextDayString
      }
    });
    
    const logs = response.data || [];
    console.log(`Fetched ${logs.length} biometric logs`);
    
    if (logs.length === 0) {
      console.log(`No biometric logs found for date range`);
      return {
        success: true,
        message: `No biometric logs found for date range`,
        processedCount: 0
      };
    }

    // Group logs by employee
    const groupedLogs = groupLogsByEmployee(logs);
    
    const results = {
      created: 0,
      updated: 0,
      failed: 0,
      errors: []
    };

    // Process each employee's logs
    for (const [employeeCode, employeeLogs] of Object.entries(groupedLogs)) {
      try {
        // Find employee by employeeId
        const employee = await Employee.findOne({ 
          employeeId: employeeCode 
        }).populate("post");

        if (!employee) {
          results.failed++;
          results.errors.push(`Employee with code ${employeeCode} not found`);
          continue;
        }

        // Get scheduled shift for the target date
        const scheduledShift = await ShiftRoster.findOne({
          employeeId: employee._id,
          date: targetDate
        }).populate("shiftId");

        // Filter logs for target date only using IST comparison
        const targetDateLogs = employeeLogs.filter(log => {
          const convertedDate = convertLogDateToIST(log.LogDate);
          if (!convertedDate) return false;
          return isSameDayIST(convertedDate, targetDate);
        });

        // Process punch logs for this employee
        let punchPairs = await processPunchLogs(targetDateLogs, targetDate, employee._id);
        
        // Handle odd number of punches
        punchPairs = await handleOddPunches(employeeCode, targetDate, punchPairs);

        // Create attendance records for each punch pair
        for (const pair of punchPairs) {
          let attendancePercentage = 100;
          
          if (scheduledShift && pair.punchInTime && pair.punchOutTime) {
            attendancePercentage = await calculateAttendancePercentage(
              employee.post,
              targetDate,
              pair.punchInTime,
              pair.punchOutTime,
              scheduledShift
            );
          } else if (!pair.punchOutTime) {
            attendancePercentage = 0;
          }

          // Calculate month using IST
          const istDate = getISTDate(targetDate);
          const monthYear = istDate.getFullYear();
          const monthMonth = String(istDate.getMonth() + 1).padStart(2, '0');
          const month = `${monthYear}-${monthMonth}`;

          // Create attendance record
          const attendanceData = {
            employeeId: employee._id,
            date: targetDate,
            punchInTime: pair.punchInTime,
            punchOutTime: pair.punchOutTime,
            isLeave: false,
            month,
            attendancePercentage
          };

          const attendance = new Attendance(attendanceData);
          await attendance.save();
          results.created++;
        }

        // If no punch pairs found, create a record with 0% attendance
        if (punchPairs.length === 0 && scheduledShift) {
          const istDate = getISTDate(targetDate);
          const monthYear = istDate.getFullYear();
          const monthMonth = String(istDate.getMonth() + 1).padStart(2, '0');
          const month = `${monthYear}-${monthMonth}`;

          const attendanceData = {
            employeeId: employee._id,
            date: targetDate,
            punchInTime: null,
            punchOutTime: null,
            isLeave: false,
            month,
            attendancePercentage: 0
          };

          const attendance = new Attendance(attendanceData);
          await attendance.save();
          results.created++;
        }

      } catch (error) {
        results.failed++;
        results.errors.push(`Error processing employee ${employeeCode}: ${error.message}`);
      }
    }

    console.log(`Reconciliation completed for ${date}:`, results);
    return {
      success: true,
      date,
      ...results
    };

  } catch (error) {
    console.error(`Error in attendance reconciliation for ${date}:`, error);
    return {
      success: false,
      date,
      error: error.message
    };
  }
};

// Fetch biometric logs from API
const fetchBiometricLogs = asyncHandler(async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    
    if (!fromDate || !toDate) {
      return res.status(400).json(
        new ApiResponse(400, null, "FromDate and ToDate are required", false)
      );
    }

    const response = await axios.get(BIOMETRIC_API_URL, {
      params: {
        APIKey: API_KEY,
        FromDate: fromDate,
        ToDate: toDate
      }
    });

    const logs = response.data || [];
    const groupedLogs = groupLogsByEmployee(logs);

    // Convert grouped logs to processed format for display
    const processedLogs = [];
    for (const [employeeCode, employeeLogs] of Object.entries(groupedLogs)) {
      const employee = await Employee.findOne({ employeeId: employeeCode });
      
      if (employee) {
        const fromDateIST = createISTDateFromString(fromDate);
        const toDateIST = createISTDateFromString(toDate);
        
        const targetDateLogs = employeeLogs.filter(log => {
          const convertedDate = convertLogDateToIST(log.LogDate);
          if (!convertedDate) return false;
          return convertedDate >= fromDateIST && convertedDate <= toDateIST;
        });
        
        const punchPairs = await processPunchLogs(targetDateLogs, fromDateIST, employee._id);
        
        processedLogs.push({
          employeeCode,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          totalLogs: targetDateLogs.length,
          punchPairs,
          logs: targetDateLogs.map(log => ({
            ...log,
            convertedDate: convertLogDateToIST(log.LogDate)
          }))
        });
      }
    }

    return res.status(200).json(
      new ApiResponse(200, { 
        rawLogs: logs, 
        processedLogs,
        totalRawLogs: logs.length,
        totalProcessedRecords: processedLogs.length
      }, "Biometric logs fetched successfully", true)
    );

  } catch (error) {
    console.error("Error fetching biometric logs:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error fetching biometric logs", false)
    );
  }
});

// Process and save biometric attendance data
const processBiometricAttendance = asyncHandler(async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    
    if (!fromDate || !toDate) {
      return res.status(400).json(
        new ApiResponse(400, null, "FromDate and ToDate are required", false)
      );
    }

    const results = [];
    const startDate = createISTDateFromString(fromDate);
    const endDate = createISTDateFromString(toDate);
    
    // Process each date in the range
    for (let date = startDate; date <= endDate; date.setDate(date.getDate() + 1)) {
      const dateString = getDateStringIST(date);
      const result = await reconcileAttendanceForDate(dateString);
      results.push(result);
      
      // Add a small delay to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Calculate summary statistics
    const summary = {
      totalDates: results.length,
      successfulDates: results.filter(r => r.success).length,
      failedDates: results.filter(r => !r.success).length,
      totalCreated: results.reduce((sum, r) => sum + (r.created || 0), 0),
      totalUpdated: results.reduce((sum, r) => sum + (r.updated || 0), 0),
      totalFailed: results.reduce((sum, r) => sum + (r.failed || 0), 0),
      totalErrors: results.reduce((sum, r) => sum + (r.errors ? r.errors.length : 0), 0)
    };

    return res.status(200).json(
      new ApiResponse(200, {
        results,
        summary,
        dateRange: { fromDate, toDate }
      }, "Biometric attendance processing completed", true)
    );

  } catch (error) {
    console.error("Error processing biometric attendance:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error processing biometric attendance", false)
    );
  }
});

// Get attendance summary for a date range
const getAttendanceSummary = asyncHandler(async (req, res) => {
  try {
    const { fromDate, toDate, employeeId } = req.query;
    
    if (!fromDate || !toDate) {
      return res.status(400).json(
        new ApiResponse(400, null, "FromDate and ToDate are required", false)
      );
    }

    const startDate = createISTDateFromString(fromDate);
    const endDate = createISTDateFromString(toDate);

    const matchConditions = {
      date: {
        $gte: startDate,
        $lte: endDate
      }
    };

    if (employeeId) {
      matchConditions.employeeId = employeeId;
    }

    const attendanceRecords = await Attendance.find(matchConditions)
      .populate('employeeId', 'employeeId firstName lastName')
      .sort({ date: 1, 'employeeId.employeeId': 1 });

    // Group by employee
    const groupedByEmployee = {};
    attendanceRecords.forEach(record => {
      const empId = record.employeeId.employeeId;
      if (!groupedByEmployee[empId]) {
        groupedByEmployee[empId] = {
          employee: record.employeeId,
          attendanceRecords: []
        };
      }
      groupedByEmployee[empId].attendanceRecords.push(record);
    });

    // Calculate summary statistics
    const summary = Object.keys(groupedByEmployee).map(empId => {
      const empData = groupedByEmployee[empId];
      const records = empData.attendanceRecords;
      
      const totalDays = records.length;
      const presentDays = records.filter(r => r.punchInTime && r.punchOutTime).length;
      const leaveDays = records.filter(r => r.isLeave).length;
      const avgAttendancePercentage = totalDays > 0 ? 
        records.reduce((sum, r) => sum + r.attendancePercentage, 0) / totalDays : 0;
      
      return {
        employee: empData.employee,
        totalDays,
        presentDays,
        leaveDays,
        absentDays: totalDays - presentDays - leaveDays,
        avgAttendancePercentage: Math.round(avgAttendancePercentage * 100) / 100,
        attendanceRecords: records
      };
    });

    return res.status(200).json(
      new ApiResponse(200, {
        summary,
        totalEmployees: Object.keys(groupedByEmployee).length,
        dateRange: { fromDate, toDate }
      }, "Attendance summary retrieved successfully", true)
    );

  } catch (error) {
    console.error("Error getting attendance summary:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error getting attendance summary", false)
    );
  }
});

// Manual reconciliation for specific date
const manualReconciliation = asyncHandler(async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json(
        new ApiResponse(400, null, "Date is required", false)
      );
    }

    const result = await reconcileAttendanceForDate(date);

    if (result.success) {
      return res.status(200).json(
        new ApiResponse(200, result, "Manual reconciliation completed successfully", true)
      );
    } else {
      return res.status(500).json(
        new ApiResponse(500, result, "Manual reconciliation failed", false)
      );
    }

  } catch (error) {
    console.error("Error in manual reconciliation:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error in manual reconciliation", false)
    );
  }
});

export { 
  fetchBiometricLogs, 
  processBiometricAttendance, 
  getAttendanceSummary,
  manualReconciliation 
};