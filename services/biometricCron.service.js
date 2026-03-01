/**
 * attendanceReconciliation.js
 * Production-grade biometric attendance sync - 48-Hour Rolling Realtime Engine
 * Integrates Shift Rosters, Overnight Shifts, Overtime, Leaves, and Holidays.
 */

import cron from 'node-cron';
import axios from 'axios';
import mongoose from 'mongoose';
import Attendance from '../models/attendance.model.js';
import { Employee } from '../models/employee.model.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';
import { OvertimeConfig } from '../models/overtimeConfig.model.js'; 
import { Overtime } from '../models/overtime.model.js';     
import { Holiday } from '../models/holidays.model.js'; 
import { Leave } from '../models/leave.model.js';
import { removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from '../controllers/dashboard.controller.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  BIOMETRIC_API_URL: 'https://klcloud.in/bims/api/v2/WebAPI/GetDeviceLogs',
  API_KEY: '275412062524',

  /** Synchronization Window: Last 2 Days (48 Hours) */
  SYNC_WINDOW_HOURS: 48,

  /** * Maximum Shift Duration. 
   * Set to 14 hours. Perfect for a 10-hour (8PM to 6AM) night shift, 
   * allowing up to 4 hours of overtime before cutting off.
   */
  MAX_SHIFT_DURATION_HOURS: 16,
  
  /** Ignore consecutive punches from the same employee within this window */
  MIN_PUNCH_INTERVAL_MINUTES: 5,

  /** Retry settings for biometric API calls */
  API_MAX_RETRIES: 3,
  API_RETRY_DELAY_MS: 2000,
  API_TIMEOUT_MS: 30_000,

  /** Runs every hour for near real-time updates */
  CRON_SCHEDULE: '0 * * * *',
  CRON_TIMEZONE: 'Asia/Kolkata',

  DATE_RANGE_DELAY_MS: 1000,
};

// ─── IST Date Helpers ────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const toIST = (date = new Date()) =>
  new Date(date.getTime() + date.getTimezoneOffset() * 60_000 + IST_OFFSET_MS);

const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

const toISTDateString = (input) => {
  const ist = toIST(new Date(input));
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const toISTMonthString = (input) => {
  const ist = toIST(new Date(input));
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const getWeekId = (input) => {
  const ist = toIST(new Date(input));
  const thursday = new Date(ist);
  thursday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  const yy = String(thursday.getUTCFullYear()).slice(-2);
  return String(weekNo).padStart(2, '0') + yy;
};

const parseISTString = (logDate) => {
  if (!logDate) return null;
  try { return new Date(logDate.trim().replace(' ', 'T') + '+05:30'); } 
  catch { return null; }
};

const convertTo24Hour = (timeStr) => {
  if (!timeStr) return "00:00:00";
  const cleanStr = timeStr.trim();
  if (!cleanStr.toLowerCase().includes('m')) return cleanStr.length === 5 ? `${cleanStr}:00` : cleanStr;

  const [time, modifier] = cleanStr.split(' ');
  let [hours, minutes] = time.split(':');
  hours = parseInt(hours, 10);

  if (modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
  if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;

  return `${String(hours).padStart(2, '0')}:${minutes}:00`;
};

// ─── Controller Core Logic ───────────────────────────────────────────────────

const calculateAttendanceStats = (post, sessionDate, punchInTime, punchOutTime, scheduledShift, isExplicitHoliday) => {
  const defaultStats = { attendancePercentage: 0, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
  if (!punchInTime || !punchOutTime) return defaultStats;

  const workedMinutes = Math.round((new Date(punchOutTime) - new Date(punchInTime)) / 60_000);
  if (workedMinutes <= 0) return defaultStats;
  
  const isWeekOff = scheduledShift?.isWeekOff || false;
  const hasHolidayBenefits = ['Monthly_With_Sunday_Holiday', 'Weekly_With_Sunday_Holiday'].includes(post?.payrollType);
  const isHolidayOT = !isWeekOff && hasHolidayBenefits && isExplicitHoliday;

  // 1. NON-WORKING DAY OT SCENARIOS (Week-Off or Holiday)
  if (isWeekOff || isHolidayOT) {
      const baseMinutes = (post?.workingHour || 8) * 60;
      return {
          attendancePercentage: 100, // Fully present for their OT day
          overtimeHours: parseFloat((workedMinutes / 60).toFixed(2)),
          overtimePercentage: parseFloat(((workedMinutes / baseMinutes) * 100).toFixed(2)),
          otTrigger: isHolidayOT ? 'HOLIDAY' : 'WEEK_OFF'
      };
  }

  // 2. STRICTLY USE SCHEDULED SHIFT ROSTER
  let scheduledMinutes = 0;
  if (scheduledShift?.shiftId?.startTime && scheduledShift?.shiftId?.endTime) {
    const dateStr = toISTDateString(sessionDate);
    const tStart = convertTo24Hour(scheduledShift.shiftId.startTime);
    const tEnd = convertTo24Hour(scheduledShift.shiftId.endTime);
    
    const shiftStart = new Date(`${dateStr}T${tStart}+05:30`);
    let shiftEnd = new Date(`${dateStr}T${tEnd}+05:30`);

    // 🔴 OVERNIGHT SHIFT FIX: E.g., 8:00 PM to 6:00 AM
    if (shiftEnd < shiftStart) {
      shiftEnd = new Date(shiftEnd.getTime() + 86_400_000); // Add exactly 24 hours (1 day)
    }

    scheduledMinutes = Math.round((shiftEnd - shiftStart) / 60_000); 
  } 

  if (scheduledMinutes <= 0) return defaultStats;

  // ── STANDARD OVERTIME & FULL ATTENDANCE SCENARIO ──
  if (workedMinutes >= scheduledMinutes) {
    const otMins = workedMinutes - scheduledMinutes;
    return {
      attendancePercentage: 100, 
      overtimeHours: parseFloat((otMins / 60).toFixed(2)),
      overtimePercentage: parseFloat(((otMins / scheduledMinutes) * 100).toFixed(2)),
      otTrigger: 'STANDARD'
    };
  }

  // ── LATE / SHORTFALL SCENARIO ──
  const shortfall = scheduledMinutes - workedMinutes;
  const thresholds = Array.isArray(post?.lateAttendanceMetrics) ? post.lateAttendanceMetrics : [];
  const proratedPercentage = Math.round((workedMinutes / scheduledMinutes) * 100);

  if (!thresholds.length) {
    return { attendancePercentage: proratedPercentage, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
  }

  const sorted = [...thresholds].sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const applicable = sorted.find((m) => shortfall > m.allowedMinutes);

  if (!applicable) {
    return { attendancePercentage: 100, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
  }

  const cap = 100 - applicable.attendanceDeductionPercent;
  const finalPercentage = Math.min(proratedPercentage, cap);

  return { attendancePercentage: Math.max(0, finalPercentage), overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
};

const syncOvertimeRecord = async (attendance, stats, otConfig) => {
  if (!otConfig) return; 

  const existingOt = await Overtime.findOne({ attendanceId: attendance._id });

  if (existingOt && existingOt.status !== 'Pending') return;

  const { overtimeHours, overtimePercentage, otTrigger } = stats;

  if (overtimeHours <= 0 || overtimePercentage <= 0) {
    if (existingOt) await existingOt.deleteOne();
    return;
  }

  const t = otConfig.thresholds;
  let credit = 0, label = null, roundedPercentage = 0; 

  if (otConfig.configType === 'TIER_4') {
    if (overtimePercentage >= t.fullDayPercentage) { credit = 1.0; label = 'Full Day'; roundedPercentage = 80; }
    else if (overtimePercentage >= t.threeQuarterDayPercentage) { credit = 0.75; label = '3/4 Day'; roundedPercentage = 70; }
    else if (overtimePercentage >= t.halfDayPercentage) { credit = 0.5; label = 'Half Day'; roundedPercentage = 40; }
    else if (overtimePercentage >= t.quarterDayPercentage) { credit = 0.25; label = '1/4 Day'; roundedPercentage = 20; }
  } else {
    if (overtimePercentage >= t.fullDayPercentage) { credit = 1.0; label = 'Full Day'; roundedPercentage = 80; }
    else if (overtimePercentage >= t.halfDayPercentage) { credit = 0.5; label = 'Half Day'; roundedPercentage = 40; }
  }

  if (credit > 0) {
    let defaultNote = "Standard Overtime.";
    if (otTrigger === 'WEEK_OFF') defaultNote = "Auto-generated against Week-Off punch.";
    if (otTrigger === 'HOLIDAY') defaultNote = "Overtime against holiday.";

    await Overtime.findOneAndUpdate(
      { attendanceId: attendance._id },
      {
        $set: {
          employeeId: attendance.employeeId,
          attendanceId: attendance._id,
          date: attendance.date,
          month: attendance.month,
          week: attendance.week,
          overtimeHours,
          overtimePercentage: roundedPercentage,
          earnedCredit: credit,
          earnedCreditLabel: label,
          redeemedNotes: defaultNote 
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true } 
    );
  } else if (existingOt) {
    await existingOt.deleteOne();
  }
};

// ─── API & Data Helpers ──────────────────────────────────────────────────────

const fetchBiometricLogs = async (fromDateStr, toDateStr) => {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.API_MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(CONFIG.BIOMETRIC_API_URL, {
        params: { APIKey: CONFIG.API_KEY, FromDate: fromDateStr, ToDate: toDateStr },
        timeout: CONFIG.API_TIMEOUT_MS,
      });
      return Array.isArray(data) ? data : [];
    } catch (err) {
      lastError = err;
      const delay = CONFIG.API_RETRY_DELAY_MS * 2 ** (attempt - 1);
      if (attempt < CONFIG.API_MAX_RETRIES) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`Biometric API failed: ${lastError?.message}`);
};

const groupAndSortLogs = (rawLogs, windowStartIST, windowEndIST) => {
  const map = new Map();
  for (const log of rawLogs) {
    const ts = parseISTString(log.LogDate);
    if (!ts || isNaN(ts.getTime())) continue;
    if (ts < windowStartIST || ts > windowEndIST) continue;

    const code = log.EmployeeCode?.trim();
    if (!code) continue;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(ts);
  }

  for (const [code, times] of map) {
    times.sort((a, b) => a - b);
    
    const deduped = [];
    for (const t of times) {
      if (deduped.length === 0) {
        deduped.push(t);
      } else {
        const last = deduped[deduped.length - 1];
        if ((t - last) / 60_000 >= CONFIG.MIN_PUNCH_INTERVAL_MINUTES) {
          deduped.push(t);
        }
      }
    }
    map.set(code, deduped);
  }
  return map;
};

// ─── Primary Sync Engine ──────────────────────────────────────────────────────

const processEmployeeLogs = async (employee, sortedTimestamps, shiftCache, holidayCache, leaveCache, otConfig) => {
  const stats = { punchIns: 0, punchOuts: 0, skipped: 0, errors: [] };

  for (const ts of sortedTimestamps) {
    try {
      // 1. Duplicate Guard
      const duplicateGuard = await Attendance.findOne({
        employeeId: employee._id,
        $or: [{ punchInTime: ts }, { punchOutTime: ts }]
      }).select('_id').lean();

      if (duplicateGuard) {
        stats.skipped++;
        continue;
      }

      // 2. Fetch Latest Record
      const lastRecord = await Attendance.findOne({ employeeId: employee._id }).sort({ punchInTime: -1 });

      let isPunchOut = false;
      if (lastRecord && lastRecord.punchInTime) {
          const diffHours = (ts.getTime() - lastRecord.punchInTime.getTime()) / (1000 * 60 * 60);
          if (diffHours > 0 && diffHours <= CONFIG.MAX_SHIFT_DURATION_HOURS) {
              isPunchOut = true;
          }
      }

      if (isPunchOut) {
        // ── PUNCH OUT (or extending existing Punch Out) ──
        if (!lastRecord.punchOutTime || ts > lastRecord.punchOutTime) {
            const sessionDate = lastRecord.date;
            const dateStr = toISTDateString(sessionDate);
            const shift = shiftCache.get(dateStr) ?? null;
            const isHoliday = holidayCache.has(dateStr);

            const calcStats = calculateAttendanceStats(
                employee.post,
                sessionDate,
                lastRecord.punchInTime,
                ts,
                shift,
                isHoliday
            );

            lastRecord.punchOutTime = ts;
            lastRecord.attendancePercentage = calcStats.attendancePercentage;
            await lastRecord.save();

            await syncOvertimeRecord(lastRecord, calcStats, otConfig);
            stats.punchOuts++;
        } else {
            stats.skipped++; // Old punch out, ignore
        }
      } else {
        // ── NEW PUNCH IN (> MAX_SHIFT_DURATION_HOURS since last) ──
        const dateStr = toISTDateString(ts);
        const dateForDB = midnightIST(dateStr);
        
        const existingToday = await Attendance.findOne({ employeeId: employee._id, date: dateForDB });
        if (existingToday && existingToday.punchInTime) {
            stats.skipped++; 
            continue; 
        }

        const shift = shiftCache.get(dateStr) ?? null;
        const isLeave = leaveCache.has(dateStr);

        const payload = {
            employeeId: employee._id,
            date: dateForDB,
            punchInTime: ts,
            punchOutTime: null,
            isLeave: isLeave,
            isWeekOff: shift?.isWeekOff || false,
            month: toISTMonthString(ts),
            week: getWeekId(ts),
            attendancePercentage: isLeave ? 100 : 0, 
        };

        await Attendance.findOneAndUpdate(
            { employeeId: employee._id, date: dateForDB },
            { $set: payload },
            { upsert: true, new: true }
        );
        stats.punchIns++;
      }
    } catch (err) {
      stats.errors.push(`ts=${ts.toISOString()}: ${err.message}`);
    }
  }

  return stats;
};

const reconcileTimeWindow = async (windowStartIST, windowEndIST) => {
  const fromDateStr = toISTDateString(windowStartIST);
  const toDateStr   = toISTDateString(windowEndIST);
  
  console.log(`[Reconcile] Processing ${CONFIG.SYNC_WINDOW_HOURS}h rolling window: ${windowStartIST.toISOString()} to ${windowEndIST.toISOString()}`);

  let rawLogs;
  try {
    rawLogs = await fetchBiometricLogs(fromDateStr, toDateStr);
  } catch (err) {
    return { success: false, window: { fromDateStr, toDateStr }, error: err.message };
  }

  if (!rawLogs.length) {
    return { success: true, message: 'No logs fetched from API', punchIns: 0, punchOuts: 0, failed: 0 };
  }

  const logsByEmployee = groupAndSortLogs(rawLogs, windowStartIST, windowEndIST);
  const totals = { punchIns: 0, punchOuts: 0, skipped: 0, failed: 0, errors: [] };

  const otConfig = await OvertimeConfig.findOne();

  for (const [code, timestamps] of logsByEmployee) {
    try {
      const employee = await Employee.findOne({ employeeId: code }).populate('post').lean(false);
      if (!employee) {
        totals.failed++;
        totals.errors.push(`Employee ${code} not found`);
        continue;
      }

      const uniqueDates = [...new Set(timestamps.map(ts => toISTDateString(ts)))];
      // Inject previous day to ensure shift lookups work for overnight punch-outs
      uniqueDates.forEach(d => {
        const prev = toISTDateString(new Date(midnightIST(d).getTime() - 86_400_000));
        if (!uniqueDates.includes(prev)) uniqueDates.push(prev);
      });
      
      const [shifts, holidays, leaves] = await Promise.all([
          ShiftRoster.find({ employeeId: employee._id, date: { $in: uniqueDates.map(midnightIST) } }).populate('shiftId'),
          Holiday.find({ date: { $in: uniqueDates.map(midnightIST) }, isActive: true }),
          Leave.find({ employeeId: employee._id, status: 'Approved', startDate: { $lte: midnightIST(uniqueDates[uniqueDates.length-1]) }, endDate: { $gte: midnightIST(uniqueDates[0]) }})
      ]);

      const shiftCache = new Map(shifts.map(s => [toISTDateString(s.date), s]));
      const holidayCache = new Set(holidays.map(h => toISTDateString(h.date)));
      
      const leaveCache = new Set();
      leaves.forEach(l => {
          let curr = midnightIST(toISTDateString(l.startDate));
          const end = midnightIST(toISTDateString(l.endDate));
          while (curr <= end) {
              leaveCache.add(toISTDateString(curr));
              curr = new Date(curr.getTime() + 86_400_000);
          }
      });

      const stats = await processEmployeeLogs(employee, timestamps, shiftCache, holidayCache, leaveCache, otConfig);
      
      totals.punchIns  += stats.punchIns;
      totals.punchOuts += stats.punchOuts;
      totals.skipped   += stats.skipped;
      
      if (stats.errors.length) {
        totals.failed++;
        totals.errors.push(...stats.errors.map((e) => `[${code}] ${e}`));
      }
    } catch (err) {
      totals.failed++;
      totals.errors.push(`[${code}] ${err.message}`);
    }
  }

  await removeCachePattern('attendance_list_*');
  await invalidateDashboardCache();

  const result = { success: true, fromDateStr, toDateStr, ...totals };
  console.log(`[Reconcile] Done:`, result);
  return result;
};

// ─── Concurrency Guard & Exports ─────────────────────────────────────────────

let _isRunning = false;

const withConcurrencyGuard = async (label, fn) => {
  if (_isRunning) {
    console.warn(`[${label}] Skipping — previous run still in progress`);
    return null;
  }
  _isRunning = true;
  try {
    return await fn();
  } finally {
    _isRunning = false;
  }
};

const startAttendanceReconciliationCron = () => {
  console.log('[Cron] Scheduling realtime attendance reconciliation…');

  cron.schedule(
    CONFIG.CRON_SCHEDULE, 
    async () => {
      await withConcurrencyGuard('Cron', async () => {
        const endIST = toIST(new Date());
        const startIST = new Date(endIST.getTime() - (CONFIG.SYNC_WINDOW_HOURS * 60 * 60 * 1000));
        await reconcileTimeWindow(startIST, endIST);
      });
    },
    { scheduled: true, timezone: CONFIG.CRON_TIMEZONE }
  );

  console.log(`[Cron] Scheduled (${CONFIG.CRON_SCHEDULE}, ${CONFIG.CRON_TIMEZONE}) for a ${CONFIG.SYNC_WINDOW_HOURS}-hour rolling window.`);
};

const manualReconciliation = async (dateStr) => {
  return withConcurrencyGuard('Manual', () => {
    const start = midnightIST(dateStr);
    const end = new Date(start.getTime() + 86_400_000 - 1); 
    return reconcileTimeWindow(start, end);
  });
};

const reconcileAttendanceForDateRange = async (fromDateStr, toDateStr) => {
  return withConcurrencyGuard('Range', async () => {
    const results = [];
    let current = midnightIST(fromDateStr);
    const end   = midnightIST(toDateStr);

    while (current <= end) {
      const dayEnd = new Date(current.getTime() + 86_400_000 - 1);
      results.push(await reconcileTimeWindow(current, dayEnd));
      current = new Date(current.getTime() + 86_400_000);
      if (current <= end) await new Promise((r) => setTimeout(r, CONFIG.DATE_RANGE_DELAY_MS));
    }

    return results;
  });
};

export {
  startAttendanceReconciliationCron,
  manualReconciliation,
  reconcileAttendanceForDateRange,

  toISTDateString,
  toISTMonthString,
  parseISTString,
  calculateAttendanceStats,
};