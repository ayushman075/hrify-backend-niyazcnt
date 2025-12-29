import cron from 'node-cron';
import axios from 'axios';
import Attendance from '../models/attendance.model.js';
import { Employee } from '../models/employee.model.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';

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

// Helper function to get yesterday's date in IST
const getYesterdayDateIST = () => {
  const istToday = getISTDate();
  const istYesterday = new Date(istToday);
  istYesterday.setDate(istYesterday.getDate() - 1);
  return getDateStringIST(istYesterday);
};

// Helper function to get today's date in IST
const getTodayDateIST = () => {
  return getDateStringIST(getISTDate());
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

// Modified function to process punch logs for single entry per day
const processPunchLogsForSingleEntry = async (logs, targetDate, employeeId) => {
  if (!logs || logs.length === 0) {
    return null;
  }

  // Convert log dates to proper IST format and sort logs by timestamp
  const sortedLogs = logs
    .map(log => ({
      ...log,
      convertedDate: convertLogDateToIST(log.LogDate)
    }))
    .filter(log => log.convertedDate !== null) // Filter out invalid dates
    .sort((a, b) => a.convertedDate - b.convertedDate);
  
  if (sortedLogs.length === 0) {
    return null;
  }

  // Check if employee has incomplete attendance from previous day
  const incompleteAttendance = await checkPreviousDayIncompleteAttendance(employeeId, targetDate);
  
  let availableLogs = [...sortedLogs];
  let punchInTime = null;
  let punchOutTime = null;

  // If there's incomplete attendance from previous day, use first log as punch out
  if (incompleteAttendance && availableLogs.length > 0) {
    const firstLog = availableLogs[0];
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
      
      // Remove the first log as it's used for previous day punch out
      availableLogs.shift();
    }
  }

  // Process remaining logs for current day - take earliest as punch in, latest as punch out
  if (availableLogs.length > 0) {
    punchInTime = availableLogs[0].convertedDate; // Earliest log
    
    if (availableLogs.length > 1) {
      punchOutTime = availableLogs[availableLogs.length - 1].convertedDate; // Latest log
    }
    // If only one log remains, it's punch in without punch out
  }

  return {
    punchInTime,
    punchOutTime,
    date: targetDate
  };
};

// Function to fetch biometric logs for date range
const fetchBiometricLogs = async (fromDate, toDate) => {
  try {
    const response = await axios.get(BIOMETRIC_API_URL, {
      params: {
        APIKey: API_KEY,
        FromDate: fromDate,
        ToDate: toDate
      }
    });
    return response.data || [];
  } catch (error) {
    console.error('Error fetching biometric logs:', error);
    return [];
  }
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

// Function to handle incomplete punch out by checking next day's logs
const handleIncompletePunchOut = async (employeeCode, targetDate, punchData) => {
  if (!punchData || !punchData.punchInTime || punchData.punchOutTime) {
    return punchData; // No punch in or already has punch out
  }

  const nextDay = new Date(targetDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayString = getDateStringIST(nextDay);
  
  // Fetch next day's logs to find punch out
  const nextDayLogs = await fetchBiometricLogs(nextDayString, nextDayString);
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
      punchData.punchOutTime = sortedNextDayLogs[0].convertedDate;
    }
  }
  
  return punchData;
};

// Main function to reconcile attendance for a specific date
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
    
    const logs = await fetchBiometricLogs(date, nextDayString);
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

        // Process punch logs for single entry per day
        let punchData = await processPunchLogsForSingleEntry(targetDateLogs, targetDate, employee._id);
        
        // Handle incomplete punch out by checking next day
        punchData = await handleIncompletePunchOut(employeeCode, targetDate, punchData);

        // Calculate attendance percentage
        let attendancePercentage = 100;
        
        if (punchData && punchData.punchInTime) {
          if (scheduledShift && punchData.punchOutTime) {
            attendancePercentage = await calculateAttendancePercentage(
              employee.post,
              targetDate,
              punchData.punchInTime,
              punchData.punchOutTime,
              scheduledShift
            );
          } else if (!punchData.punchOutTime) {
            attendancePercentage = 0; // No punch out = 0% attendance
          }
        } else if (scheduledShift) {
          attendancePercentage = 0; // No punch in = 0% attendance
        }

        // Calculate month using IST
        const istDate = getISTDate(targetDate);
        const monthYear = istDate.getFullYear();
        const monthMonth = String(istDate.getMonth() + 1).padStart(2, '0');
        const month = `${monthYear}-${monthMonth}`;

        // Create single attendance record for the day
        const attendanceData = {
          employeeId: employee._id,
          date: targetDate,
          punchInTime: punchData ? punchData.punchInTime : null,
          punchOutTime: punchData ? punchData.punchOutTime : null,
          isLeave: false,
          month,
          attendancePercentage
        };

        // Only create attendance record if employee has a scheduled shift OR has punch data
        if (scheduledShift || punchData) {
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

// Cron job to run every 6 hours
const startAttendanceReconciliationCron = () => {
  console.log('Starting attendance reconciliation cron job...');
  
  // Run every 6 hours: '0 */6 * * *'
  // Changed back to proper 6-hour schedule instead of every minute
  cron.schedule('0 */6 * * *', async () => {
    console.log('Running attendance reconciliation every 6 hours...');
    
    try {
      const yesterdayDate = getYesterdayDateIST();
      console.log(`Reconciling attendance for yesterday: ${yesterdayDate} (IST)`);
      
      const result = await reconcileAttendanceForDate(yesterdayDate);
      
      if (result.success) {
        console.log(`Attendance reconciliation completed successfully for ${yesterdayDate}`);
        console.log(`Created: ${result.created}, Updated: ${result.updated}, Failed: ${result.failed}`);
        
        if (result.errors.length > 0) {
          console.log('Errors encountered:', result.errors);
        }
      } else {
        console.error(`Attendance reconciliation failed for ${yesterdayDate}:`, result.error);
      }
    } catch (error) {
      console.error('Error in cron job execution:', error);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
  
  console.log('Attendance reconciliation cron job scheduled to run every 6 hours');
};

// Function to manually trigger reconciliation for any date
const manualReconciliation = async (date) => {
  console.log(`Manual reconciliation triggered for date: ${date} (IST)`);
  return await reconcileAttendanceForDate(date);
};

// Function to reconcile attendance for a date range
const reconcileAttendanceForDateRange = async (fromDate, toDate) => {
  console.log(`Starting attendance reconciliation for date range: ${fromDate} to ${toDate} (IST)`);
  
  const results = [];
  const startDate = createISTDateFromString(fromDate);
  const endDate = createISTDateFromString(toDate);
  
  for (let date = startDate; date <= endDate; date.setDate(date.getDate() + 1)) {
    const dateString = getDateStringIST(date);
    const result = await reconcileAttendanceForDate(dateString);
    results.push(result);
    
    // Add a small delay to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
};

export { 
  startAttendanceReconciliationCron, 
  manualReconciliation, 
  reconcileAttendanceForDateRange 
};