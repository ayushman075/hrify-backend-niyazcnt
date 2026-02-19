/**
 * attendanceReconciliation.js
 * Production-grade biometric attendance sync.
 * Strictly uses native Intl IST date calculations to perfectly match `attendance.controller.js`.
 */

import axios from 'axios';
import Attendance from '../models/attendance.model.js';
import { Employee } from '../models/employee.model.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  BIOMETRIC_API_URL: 'https://klcloud.in/bims/api/v2/WebAPI/GetDeviceLogs',
  API_KEY: '275412062524',
  SESSION_MAX_HOURS: 16,        // Maximum length of a valid shift (for overnight detection)
  PUNCH_IGNORE_MINUTES: 10,     // Ignore duplicate machine punches within 10 mins
  NEW_SHIFT_HOURS: 4,           // If a punch occurs 4+ hours after an OUT punch, it's a new shift
};

const CACHE_KEY = {
  LIST_PREFIX: 'attendance_list_',
};

// ─── Bulletproof IST Date Helpers (Immune to Server Timezone) ────────────────

const toISTDateString = (input) => {
  // Uses en-CA locale which natively outputs YYYY-MM-DD format
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(input));
};

const toISTMonthString = (input) => {
  const dStr = toISTDateString(input);
  return dStr.substring(0, 7); // Returns YYYY-MM
};

const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

const getWeekId = (input) => {
  const dStr = toISTDateString(input);
  const noon = new Date(`${dStr}T12:00:00Z`); // use noon UTC to safely calculate week
  const thursday = new Date(noon);
  thursday.setUTCDate(noon.getUTCDate() - ((noon.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  const yy = String(thursday.getUTCFullYear()).slice(-2);
  return String(weekNo).padStart(2, '0') + yy;
};

// ─── Percentage Calculation Helpers (100% Synced with Controller) ────────────

const convertTo24Hour = (timeStr) => {
  if (!timeStr) return "00:00:00";
  const cleanStr = timeStr.trim();
  if (!cleanStr.toLowerCase().includes('m')) {
    return cleanStr.length === 5 ? `${cleanStr}:00` : cleanStr;
  }
  const [time, modifier] = cleanStr.split(' ');
  let [hours, minutes] = time.split(':');
  hours = parseInt(hours, 10);
  if (modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
  if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}:00`;
};

const calculateAttendancePercentage = (post, sessionDate, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchInTime || !punchOutTime) return 0;

  let scheduledMinutes = 0;

  if (scheduledShift?.shiftId?.startTime && scheduledShift?.shiftId?.endTime) {
    const dateStr    = toISTDateString(sessionDate);
    const tStart     = convertTo24Hour(scheduledShift.shiftId.startTime);
    const tEnd       = convertTo24Hour(scheduledShift.shiftId.endTime);
    
    const shiftStart = new Date(`${dateStr}T${tStart}+05:30`);
    const shiftEnd   = new Date(`${dateStr}T${tEnd}+05:30`);
    const raw        = (shiftEnd - shiftStart) / 60_000;

    // Handle overnight shift definitions
    scheduledMinutes = raw < 0 ? raw + 24 * 60 : raw;
  } else if (post?.workingHour > 0) {
    scheduledMinutes = post.workingHour * 60;
  }

  if (scheduledMinutes <= 0) return 0;

  const workedMinutes = Math.round((new Date(punchOutTime) - new Date(punchInTime)) / 60_000);
  if (workedMinutes <= 0) return 0;

  if (workedMinutes >= scheduledMinutes) {
    return Math.max(100, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  const shortfall   = scheduledMinutes - workedMinutes;
  const thresholds  = Array.isArray(post?.lateAttendanceMetrics) ? post.lateAttendanceMetrics : [];

  if (!thresholds.length) {
    return Math.max(0, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  const sorted     = [...thresholds].sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const applicable = sorted.find((m) => shortfall > m.allowedMinutes);

  if (!applicable) return 100;

  return Math.max(0, Math.round(100 - applicable.attendanceDeductionPercent));
};

// ─── Data Ingestion Helpers ──────────────────────────────────────────────────

/** Parses biometric API date "2025-07-08 19:17:03" natively as IST to UTC */
const parseBiometricLogToIST = (logDate) => {
  try {
    return new Date(logDate.replace(' ', 'T') + '+05:30');
  } catch {
    return null;
  }
};

/**
 * Dynamic Shift Fetcher
 * Prevents the "0% bug" by ensuring shifts are matched strictly by IST date strings.
 */
const getShift = async (employeeId, dateStr, shiftCache) => {
  const key = `${employeeId.toString()}|${dateStr}`;
  if (shiftCache.has(key)) return shiftCache.get(key);

  const shift = await ShiftRoster.findOne({
    employeeId: employeeId,
    date: midnightIST(dateStr)
  }).populate('shiftId');

  shiftCache.set(key, shift);
  return shift;
};

/**
 * State machine to process a single punch timestamp.
 * Handles debouncing, open sessions, back-to-back shifts, and overnight shifts seamlessly.
 */
const processEmployeePunch = async (employee, ts, shiftCache) => {
  const cutoff = new Date(ts.getTime() - CONFIG.SESSION_MAX_HOURS * 3_600_000);

  // 1. Find an open session for this employee (within the last 16 hours)
  let session = await Attendance.findOne({
    employeeId: employee._id,
    punchInTime: { $gte: cutoff, $lte: ts }
  }).sort({ punchInTime: -1 });

  // Safety net: If session has a punchOutTime that was hours ago, it's a new shift, not an update.
  if (session && session.punchOutTime) {
      const hoursSinceOut = (ts - session.punchOutTime) / 3_600_000;
      if (hoursSinceOut > CONFIG.NEW_SHIFT_HOURS) {
          session = null; // Forces creation of a new Punch IN
      }
  }

  // 2. If a valid session exists, treat this log as a punch OUT
  if (session && (!session.punchOutTime || ts > session.punchOutTime)) {
    const minsSinceIn = (ts - session.punchInTime) / 60_000;
    
    // Anti-bounce: Ignore duplicate machine punches within 10 minutes
    if (minsSinceIn < CONFIG.PUNCH_IGNORE_MINUTES && !session.punchOutTime) {
      return { action: 'ignored_bounce', session };
    }

    session.punchOutTime = ts;
    const dateStr = toISTDateString(session.date);
    const shift = await getShift(employee._id, dateStr, shiftCache);

    if (!session.isLeave) {
      session.attendancePercentage = calculateAttendancePercentage(
        employee.post, session.date, session.punchInTime, session.punchOutTime, shift
      );
    }
    
    await session.save();
    return { action: 'updated_out', session };
  } 
  
  // 3. If no session exists, treat this log as a punch IN
  const dateStr = toISTDateString(ts);
  const dateForDB = midnightIST(dateStr);

  let existingDayRecord = await Attendance.findOne({ employeeId: employee._id, date: dateForDB });
  
  if (!existingDayRecord) {
    // Create entirely new day session
    const newSession = new Attendance({
      employeeId: employee._id,
      date: dateForDB,
      isLeave: false,
      month: toISTMonthString(ts),
      week: getWeekId(ts),
      attendancePercentage: 0,
      punchInTime: ts
    });
    await newSession.save();
    return { action: 'created_in', session: newSession };
  } else {
    // A record exists for today (e.g. they were marked on Leave, or HR manually made a record)
    if (existingDayRecord.isLeave) {
      return { action: 'ignored_leave', session: existingDayRecord };
    }
    
    // Inject the punch times if they are missing
    if (!existingDayRecord.punchInTime || ts < existingDayRecord.punchInTime) {
      existingDayRecord.punchInTime = ts;
      await existingDayRecord.save();
      return { action: 'updated_in', session: existingDayRecord };
    } else if (!existingDayRecord.punchOutTime || ts > existingDayRecord.punchOutTime) {
      existingDayRecord.punchOutTime = ts;
      const shift = await getShift(employee._id, dateStr, shiftCache);
      existingDayRecord.attendancePercentage = calculateAttendancePercentage(
        employee.post, existingDayRecord.date, existingDayRecord.punchInTime, existingDayRecord.punchOutTime, shift
      );
      await existingDayRecord.save();
      return { action: 'updated_out', session: existingDayRecord };
    }
  }

  return { action: 'ignored', session: existingDayRecord };
};

// ─── API Controllers ─────────────────────────────────────────────────────────

export const processBiometricAttendance = asyncHandler(async (req, res) => {
  const { fromDate, toDate } = req.query;

  if (!fromDate || !toDate) {
    return res.status(400).json(new ApiResponse(400, null, "FromDate and ToDate are required (YYYY-MM-DD)", false));
  }

  // Extend fetching by 1 day to ensure we catch next-day punch-outs for overnight shifts
  const endDate = new Date(midnightIST(toDate).getTime() + 86_400_000);
  const toDateExtended = toISTDateString(endDate);

  const response = await axios.get(CONFIG.BIOMETRIC_API_URL, {
    params: { APIKey: CONFIG.API_KEY, FromDate: fromDate, ToDate: toDateExtended }
  });

  const rawLogs = response.data || [];
  if (!rawLogs.length) {
    return res.status(200).json(new ApiResponse(200, { processed: 0 }, "No biometric logs found for date range", true));
  }

  // 1. Group, Parse, and Sort Logs
  const map = new Map();
  for (const log of rawLogs) {
    const ts = parseBiometricLogToIST(log.LogDate);
    if (!ts || isNaN(ts.getTime())) continue;
    const code = log.EmployeeCode?.trim();
    if (!code) continue;
    
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(ts);
  }

  const employeeCodes = Array.from(map.keys());
  const employees = await Employee.find({ employeeId: { $in: employeeCodes } }).populate('post');
  
  // 2. Initialize dynamic shift cache
  const shiftCache = new Map();

  // 3. Process logs chronologically per employee
  const stats = { created: 0, updated: 0, ignored: 0, failed: 0, errors: [] };

  for (const employee of employees) {
    try {
      const timestamps = map.get(employee.employeeId.toString());
      timestamps.sort((a, b) => a - b); // Crucial: ensures IN -> OUT processing order

      for (const ts of timestamps) {
        const result = await processEmployeePunch(employee, ts, shiftCache);
        if (result.action === 'created_in' || result.action === 'updated_in') stats.created++;
        else if (result.action === 'updated_out') stats.updated++;
        else stats.ignored++;
      }
    } catch (error) {
      stats.failed++;
      stats.errors.push(`[${employee.employeeId}] ${error.message}`);
    }
  }

  // Invalidate Dashboard caches immediately
  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { stats, dateRange: { fromDate, toDate } }, "Biometric attendance processing completed", true)
  );
});

export const fetchBiometricLogs = asyncHandler(async (req, res) => {
  const { fromDate, toDate } = req.query;

  if (!fromDate || !toDate) {
    return res.status(400).json(new ApiResponse(400, null, "FromDate and ToDate are required", false));
  }

  const response = await axios.get(CONFIG.BIOMETRIC_API_URL, {
    params: { APIKey: CONFIG.API_KEY, FromDate: fromDate, ToDate: toDate }
  });

  const logs = response.data || [];
  return res.status(200).json(new ApiResponse(200, { rawLogs: logs, totalLogs: logs.length }, "Logs fetched successfully", true));
});

export const getAttendanceSummary = asyncHandler(async (req, res) => {
  const { fromDate, toDate, employeeId } = req.query;

  if (!fromDate || !toDate) {
    return res.status(400).json(new ApiResponse(400, null, "FromDate and ToDate are required", false));
  }

  const startDate = midnightIST(fromDate);
  const endDate = new Date(midnightIST(toDate).getTime() + 86_400_000 - 1);

  const matchConditions = { date: { $gte: startDate, $lte: endDate } };
  if (employeeId) matchConditions.employeeId = employeeId;

  const records = await Attendance.find(matchConditions).populate('employeeId', 'employeeId firstName lastName');

  const grouped = {};
  records.forEach(r => {
    const empId = r.employeeId.employeeId;
    if (!grouped[empId]) grouped[empId] = { employee: r.employeeId, totalDays: 0, presentDays: 0, leaveDays: 0, pctSum: 0 };
    
    grouped[empId].totalDays++;
    if (r.isLeave) grouped[empId].leaveDays++;
    else if (r.punchInTime && r.punchOutTime) grouped[empId].presentDays++;
    
    grouped[empId].pctSum += r.attendancePercentage;
  });

  const summary = Object.values(grouped).map(emp => ({
    employee: emp.employee,
    totalDays: emp.totalDays,
    presentDays: emp.presentDays,
    leaveDays: emp.leaveDays,
    absentDays: emp.totalDays - emp.presentDays - emp.leaveDays,
    avgAttendancePercentage: emp.totalDays > 0 ? Math.round(emp.pctSum / emp.totalDays) : 0
  }));

  return res.status(200).json(new ApiResponse(200, { summary, totalEmployees: summary.length }, "Summary retrieved", true));
});

export const manualReconciliation = asyncHandler(async (req, res) => {
  req.query.fromDate = req.query.date;
  req.query.toDate = req.query.date;
  return processBiometricAttendance(req, res);
});