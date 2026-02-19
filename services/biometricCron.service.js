/**
 * attendanceReconciliation.js
 * Production-grade biometric attendance sync
 *
 * Punch direction strategy:
 * - Per employee, sort logs chronologically.
 * - Deduplicate rapid scans (e.g., multiple scans within 5 minutes).
 * - Find the most recent open attendance record (< OPEN_SESSION_MAX_HOURS old).
 * - If found  -> treat log as PUNCH OUT for that record.
 * - If not    -> treat log as PUNCH IN (create new record).
 * - Automatically handles overnight shifts via raw time calculations.
 */

import cron from 'node-cron';
import axios from 'axios';
import mongoose from 'mongoose';
import Attendance from '../models/attendance.model.js';
import { Employee } from '../models/employee.model.js';
import { ShiftRoster } from '../models/shiftRoster.model.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  BIOMETRIC_API_URL: 'https://klcloud.in/bims/api/v2/WebAPI/GetDeviceLogs',
  API_KEY: '275412062524',

  /** If an open session is older than this, the next log is a new punch-in  */
  OPEN_SESSION_MAX_HOURS: 15,
  
  /** Ignore consecutive punches from the same employee within this window */
  MIN_PUNCH_INTERVAL_MINUTES: 5,

  /** Retry settings for biometric API calls */
  API_MAX_RETRIES: 3,
  API_RETRY_DELAY_MS: 2000,
  API_TIMEOUT_MS: 30_000,

  /** Prevents overlapping cron executions */
  CRON_SCHEDULE: '0 */2 * * *',
  CRON_TIMEZONE: 'Asia/Kolkata',

  /** Delay between processing each date in a range reconciliation */
  DATE_RANGE_DELAY_MS: 1000,
};

// ─── IST Date Helpers (Synced with Controller) ────────────────────────────────

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

const yesterdayIST = () => {
  const ist = toIST();
  ist.setUTCDate(ist.getUTCDate() - 1);
  return toISTDateString(ist);
};

/** Parse Biometric "YYYY-MM-DD HH:mm:ss" into IST Date */
const parseISTString = (logDate) => {
  if (!logDate) return null;
  try {
    return new Date(logDate.trim().replace(' ', 'T') + '+05:30');
  } catch {
    return null;
  }
};

/** Converts "08:00 AM" to "08:00:00" */
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

// ─── API & Data Helpers ──────────────────────────────────────────────────────

const fetchBiometricLogs = async (fromDate, toDate) => {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.API_MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(CONFIG.BIOMETRIC_API_URL, {
        params: { APIKey: CONFIG.API_KEY, FromDate: fromDate, ToDate: toDate },
        timeout: CONFIG.API_TIMEOUT_MS,
      });
      return Array.isArray(data) ? data : [];
    } catch (err) {
      lastError = err;
      const delay = CONFIG.API_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[Biometric API] Attempt ${attempt}/${CONFIG.API_MAX_RETRIES} failed: ${err.message}. ` +
        (attempt < CONFIG.API_MAX_RETRIES ? `Retrying in ${delay}ms…` : 'Giving up.')
      );
      if (attempt < CONFIG.API_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`Biometric API failed after ${CONFIG.API_MAX_RETRIES} attempts: ${lastError?.message}`);
};

/** * Group logs by EmployeeCode, sort chronologically, and deduplicate rapid scans 
 */
const groupAndSortLogs = (rawLogs) => {
  const map = new Map();
  for (const log of rawLogs) {
    const ts = parseISTString(log.LogDate);
    if (!ts || isNaN(ts.getTime())) continue;
    const code = log.EmployeeCode?.trim();
    if (!code) continue;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(ts);
  }

  for (const [code, times] of map) {
    times.sort((a, b) => a - b);
    
    // Deduplication Phase
    const deduped = [];
    for (const t of times) {
      if (deduped.length === 0) {
        deduped.push(t);
      } else {
        const last = deduped[deduped.length - 1];
        const diffMinutes = (t - last) / 60_000;
        if (diffMinutes >= CONFIG.MIN_PUNCH_INTERVAL_MINUTES) {
          deduped.push(t);
        }
      }
    }
    map.set(code, deduped);
  }
  return map;
};

// ─── Core Logic ──────────────────────────────────────────────────────────────

const findOpenSession = async (employeeId, logTime) => {
  const cutoff = new Date(logTime.getTime() - CONFIG.OPEN_SESSION_MAX_HOURS * 3_600_000);
  return Attendance.findOne({
    employeeId,
    punchInTime: { $gte: cutoff, $lte: logTime },
    $or: [{ punchOutTime: null }, { punchOutTime: { $exists: false } }],
  }).sort({ punchInTime: -1 });
};

const calculateAttendancePercentage = (post, sessionDate, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchInTime || !punchOutTime) return 0;

  let scheduledMinutes = 0;

  if (scheduledShift?.shiftId?.startTime && scheduledShift?.shiftId?.endTime) {
    const dateStr = toISTDateString(sessionDate);
    
    const tStart = convertTo24Hour(scheduledShift.shiftId.startTime);
    const tEnd   = convertTo24Hour(scheduledShift.shiftId.endTime);
    
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

  const shortfall = scheduledMinutes - workedMinutes;
  const thresholds = Array.isArray(post?.lateAttendanceMetrics) ? post.lateAttendanceMetrics : [];

  if (!thresholds.length) {
    return Math.max(0, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  const sorted = [...thresholds].sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const applicable = sorted.find((m) => shortfall > m.allowedMinutes);

  if (!applicable) return 100;

  return Math.max(0, Math.round(100 - applicable.attendanceDeductionPercent));
};

const processEmployeeLogs = async (employee, sortedTimestamps, shiftCache) => {
  const stats = { punchIns: 0, punchOuts: 0, errors: [] };

  for (const ts of sortedTimestamps) {
    try {
      const openSession = await findOpenSession(employee._id, ts);

      if (openSession) {
        // ── PUNCH OUT ──
        if (!openSession.punchOutTime || ts > openSession.punchOutTime) {
          const sessionDate = openSession.date;
          const dateStr     = toISTDateString(sessionDate);
          const shift       = shiftCache.get(dateStr) ?? null;

          const pct = calculateAttendancePercentage(
            employee.post,
            sessionDate,
            openSession.punchInTime,
            ts,
            shift
          );

          await Attendance.findByIdAndUpdate(openSession._id, {
            punchOutTime: ts,
            attendancePercentage: pct,
          });
          stats.punchOuts++;
        }
      } else {
        // ── PUNCH IN ──
        const dateStr = toISTDateString(ts);
        
        await Attendance.findOneAndUpdate(
          {
            employeeId: employee._id,
            date: midnightIST(dateStr),
            punchInTime: ts,
          },
          {
            $setOnInsert: {
              employeeId: employee._id,
              date: midnightIST(dateStr),
              punchInTime: ts,
              punchOutTime: null,
              isLeave: false,
              month: toISTMonthString(ts),
              week: getWeekId(ts),
              attendancePercentage: 0,
            },
          },
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

const reconcileAttendanceForDate = async (dateStr) => {
  console.log(`[Reconcile] Starting for ${dateStr}`);

  // Fetch target date AND next day to cover overnight shifts crossing midnight
  const nextDateStr = toISTDateString(new Date(midnightIST(dateStr).getTime() + 86_400_000));
  let rawLogs;
  try {
    rawLogs = await fetchBiometricLogs(dateStr, nextDateStr);
  } catch (err) {
    return { success: false, date: dateStr, error: err.message };
  }

  console.log(`[Reconcile] ${dateStr}: ${rawLogs.length} raw logs fetched`);
  if (!rawLogs.length) {
    return { success: true, date: dateStr, message: 'No logs', punchIns: 0, punchOuts: 0, failed: 0 };
  }

  const logsByEmployee = groupAndSortLogs(rawLogs);
  const totals = { punchIns: 0, punchOuts: 0, failed: 0, errors: [] };

  for (const [code, timestamps] of logsByEmployee) {
    try {
      const employee = await Employee.findOne({ employeeId: code }).populate('post').lean(false);
      if (!employee) {
        totals.failed++;
        totals.errors.push(`Employee ${code} not found`);
        continue;
      }

      const shiftCache = new Map();
      for (const ds of [dateStr, nextDateStr]) {
        const shift = await ShiftRoster.findOne({
          employeeId: employee._id,
          date: midnightIST(ds),
        }).populate('shiftId');
        if (shift) shiftCache.set(ds, shift);
      }

      const stats = await processEmployeeLogs(employee, timestamps, shiftCache);
      totals.punchIns  += stats.punchIns;
      totals.punchOuts += stats.punchOuts;
      if (stats.errors.length) {
        totals.failed++;
        totals.errors.push(...stats.errors.map((e) => `[${code}] ${e}`));
      }
    } catch (err) {
      totals.failed++;
      totals.errors.push(`[${code}] ${err.message}`);
    }
  }

  const result = { success: true, date: dateStr, ...totals };
  console.log(`[Reconcile] ${dateStr} done:`, result);
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
  console.log('[Cron] Scheduling attendance reconciliation…');

  cron.schedule(
    CONFIG.CRON_SCHEDULE,
    async () => {
      await withConcurrencyGuard('Cron', async () => {
        const target = yesterdayIST();
        console.log(`[Cron] Running reconciliation for ${target}`);
        const result = await reconcileAttendanceForDate(target);
        if (!result?.success) {
          console.error('[Cron] Reconciliation failed:', result?.error);
        } else {
          console.log(`[Cron] Done — punchIns: ${result.punchIns}, punchOuts: ${result.punchOuts}, failed: ${result.failed}`);
          if (result.errors?.length) console.warn('[Cron] Errors:', result.errors);
        }
      });
    },
    { scheduled: true, timezone: CONFIG.CRON_TIMEZONE }
  );

  console.log(`[Cron] Scheduled (${CONFIG.CRON_SCHEDULE}, ${CONFIG.CRON_TIMEZONE})`);
};

const manualReconciliation = async (dateStr) => {
  return withConcurrencyGuard('Manual', () => reconcileAttendanceForDate(dateStr));
};

const reconcileAttendanceForDateRange = async (fromDateStr, toDateStr) => {
  return withConcurrencyGuard('Range', async () => {
    const results = [];
    let current = midnightIST(fromDateStr);
    const end   = midnightIST(toDateStr);

    while (current <= end) {
      const ds = toISTDateString(current);
      results.push(await reconcileAttendanceForDate(ds));
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

  // Exported for testing/reusability
  toISTDateString,
  toISTMonthString,
  parseISTString,
  findOpenSession,
  calculateAttendancePercentage,
};