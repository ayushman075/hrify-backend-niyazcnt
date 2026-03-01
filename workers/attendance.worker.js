/**
 * attendance.worker.js
 * BullMQ worker for face-recognition based attendance (punch in / out).
 *
 * Overnight shift support:
 *   Instead of anchoring everything to "today midnight", we look for an open
 *   session (punchIn set, punchOut not set) within the last OPEN_SESSION_MAX_HOURS.
 *   This means an employee who punched IN at 20:00 will correctly get their
 *   punch OUT recorded at 08:00 the next morning.
 *
 * IST safety:
 *   All date strings (date field, month, week) are computed from IST wall-clock
 *   using pure UTC arithmetic — no moment.js, no server-timezone dependency.
 */

import { Worker } from "bullmq";
import { redis } from "../db/redis.config.js";
import fs from "fs";

import { User } from "../models/user.model.js";
import { CheckIn } from "../models/checkIn.model.js";
import { Employee } from "../models/employee.model.js";
import { ShiftRoster } from "../models/shiftRoster.model.js";
import Attendance from "../models/attendance.model.js";

import { identifyUserFromFace } from "../services/azureFace.service.js";
import { removeCache, removeCachePattern } from "../utils/cache.js";
import { invalidateDashboardCache } from "../controllers/dashboard.controller.js";

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * If an open session's punchInTime is older than this, the current scan is
 * treated as a NEW punch-in rather than a punch-out for the old session.
 * 15 hours covers any realistic overnight shift (e.g. 20:00 → 08:00 = 12 hrs).
 */
const OPEN_SESSION_MAX_HOURS = 15;

const CACHE_KEY = {
  PREFIX:      "attendance_",
  LIST_PREFIX: "attendance_list_",
};

// ─── IST date helpers (zero external dependencies) ───────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/**
 * Returns a Date object whose UTC fields read as the IST wall-clock time.
 * Safe regardless of the server's local timezone.
 */
const toIST = (date = new Date()) =>
  new Date(date.getTime() + date.getTimezoneOffset() * 60_000 + IST_OFFSET_MS);

/** "YYYY-MM-DD" string for a date evaluated in IST */
const toISTDateString = (date) => {
  const ist = toIST(date);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/** "YYYY-MM" string for a date evaluated in IST */
const toISTMonthString = (date) => {
  const ist = toIST(date);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * ISO week number as "WWYY" string (e.g. week 2 of 2025 → "0225"), IST-aware.
 * Thursday-of-the-week rule (ISO 8601).
 */
const toISTWeekString = (date) => {
  const ist = toIST(date);
  const thursday = new Date(ist);
  thursday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  const yy = String(thursday.getUTCFullYear()).slice(-2);
  return String(weekNo).padStart(2, "0") + yy;
};

/**
 * Returns a Date representing 00:00:00 IST for the given "YYYY-MM-DD" string.
 * Storing this in MongoDB means the UTC value is the night before at 18:30 UTC,
 * which is the correct and consistent representation throughout the codebase.
 */
const midnightIST = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);

// ─── Open-session lookup ──────────────────────────────────────────────────────

/**
 * Find the most recent open attendance record for an employee where:
 *   - punchInTime exists
 *   - punchOutTime is absent / null
 *   - punchInTime is within OPEN_SESSION_MAX_HOURS before eventTime
 *
 * Returning a record means the current scan is a PUNCH-OUT for that session.
 * Returning null means the current scan is a new PUNCH-IN.
 *
 * @param {ObjectId} employeeId
 * @param {Date}     eventTime
 * @returns {Promise<Document|null>}
 */
const findOpenSession = (employeeId, eventTime) => {
  const cutoff = new Date(eventTime.getTime() - OPEN_SESSION_MAX_HOURS * 3_600_000);
  return Attendance.findOne({
    employeeId,
    punchInTime: { $gte: cutoff, $lte: eventTime },
    $or: [{ punchOutTime: null }, { punchOutTime: { $exists: false } }],
  })
    .sort({ punchInTime: -1 }) // most recent open session wins
    .populate({ path: "employeeId", select: "_id" }); // lightweight populate for safety
};

// ─── Attendance percentage ────────────────────────────────────────────────────

/**
 * Calculate attendance percentage for a completed session.
 *
 * Rules:
 *   1. If a ShiftRoster entry exists → use its shift times for scheduled minutes.
 *   2. Else if post.workingHour exists → use that as scheduled minutes.
 *   3. Else → return 0 (can't compute without a reference).
 *
 * Scoring:
 *   - workedMinutes >= scheduledMinutes → proportional score (can exceed 100 for overtime).
 *   - workedMinutes < scheduledMinutes  → apply lateAttendanceMetrics deduction if within
 *     allowed threshold, otherwise proportional score.
 *
 * @param {Object}      post           - employee.post (populated)
 * @param {Date}        sessionDate    - the date the session belongs to (for shift lookup)
 * @param {Date}        punchInTime
 * @param {Date}        punchOutTime
 * @param {Object|null} scheduledShift - ShiftRoster doc populated with shiftId
 * @returns {number} 0–100+ (capped at 100 for storage if desired; left uncapped here)
 */
const calculateAttendancePercentage = (
  post,
  sessionDate,
  punchInTime,
  punchOutTime,
  scheduledShift
) => {
  if (!punchInTime || !punchOutTime) return 0;

  // ── Determine scheduled minutes ──────────────────────────────────────────
  let scheduledMinutes = 0;

  if (scheduledShift?.shiftId?.startTime && scheduledShift?.shiftId?.endTime) {
    // Build IST-anchored Date objects for the shift times on sessionDate.
    // Using "YYYY-MM-DDTHH:mm:ss+05:30" avoids all locale/server-tz issues.
    const dateStr   = toISTDateString(sessionDate); // "YYYY-MM-DD"
    const shiftStart = new Date(`${dateStr}T${scheduledShift.shiftId.startTime}+05:30`);
    const shiftEnd   = new Date(`${dateStr}T${scheduledShift.shiftId.endTime}+05:30`);

    // Guard: if shift crosses midnight (e.g. 20:00–08:00), end < start → add 1 day
    const rawMinutes = (shiftEnd - shiftStart) / 60_000;
    scheduledMinutes = rawMinutes < 0
      ? rawMinutes + 24 * 60   // overnight shift correction
      : rawMinutes;
  } else if (post?.workingHour > 0) {
    scheduledMinutes = post.workingHour * 60;
  }

  if (scheduledMinutes <= 0) return 0;

  // ── Compute worked minutes ───────────────────────────────────────────────
  const workedMinutes = Math.round((punchOutTime - punchInTime) / 60_000);
  if (workedMinutes <= 0) return 0;

  // ── Score ────────────────────────────────────────────────────────────────
  if (workedMinutes >= scheduledMinutes) {
    // On-time or overtime — proportional (cap at 100 if overtime shouldn't bonus)
    return Math.min(100, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  // Undertime: apply deduction thresholds if configured
  const shortfall   = scheduledMinutes - workedMinutes;
  const thresholds  = Array.isArray(post?.lateAttendanceMetrics) ? post.lateAttendanceMetrics : [];

  if (!thresholds.length) {
    // No thresholds configured → pure proportion
    return Math.max(0, Math.round((workedMinutes / scheduledMinutes) * 100));
  }

  // Sort descending by allowedMinutes so we find the tightest applicable rule
  const sorted     = [...thresholds].sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const applicable = sorted.find((m) => shortfall > m.allowedMinutes);

  if (!applicable) {
    // Shortfall is within the most lenient threshold → full marks
    return 100;
  }

  return Math.max(0, Math.round(100 - applicable.attendanceDeductionPercent));
};

// ─── Cache helpers ────────────────────────────────────────────────────────────

const invalidateAttendanceCaches = async (attendanceId) => {
  const tasks = [removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`), invalidateDashboardCache()];
  if (attendanceId) tasks.push(removeCache(`${CACHE_KEY.PREFIX}${attendanceId}`));
  // Fire all cache invalidations concurrently; don't let cache errors kill the job
  await Promise.allSettled(tasks);
};

// ─── Worker ───────────────────────────────────────────────────────────────────

export const worker = new Worker(
  "attendanceQueue",
  async (job) => {
    const { filePath, checkInId, type, timestamp } = job.data;
    const eventTime = timestamp ? new Date(timestamp) : new Date();

    console.log(
      `[Worker] Job ${job.id} | ${type?.toUpperCase()} | CheckIn: ${checkInId} | ${eventTime.toISOString()}`
    );

    // Validate job type early
    if (type !== "in" && type !== "out") {
      throw new Error(`Unknown job type: "${type}". Expected "in" or "out".`);
    }

    // ── A. Identify face ──────────────────────────────────────────────────────
    const result = await identifyUserFromFace(filePath);
    if (!result.identified) {
      throw new Error(result.reason || "Face not recognized");
    }

    const personId = result.azurePersonId;
    console.log(`[Worker] Identified personId: ${personId}`);

    // ── B. Find employee ──────────────────────────────────────────────────────
    const employee = await Employee.findOne({ azurePersonId: personId }).populate("post");
    if (!employee) {
      throw new Error(`Face recognized (ID: ${personId}) but no Employee record found.`);
    }

    const employeeId = employee._id;
    console.log(`[Worker] Matched: ${employee.firstName} ${employee.lastName}`);

    // ── C. Look for an open session (handles overnight automatically) ─────────
    const openSession = await findOpenSession(employeeId, eventTime);

    // ── D. Determine IST-anchored date context for new records ────────────────
    //      (only needed for punch-in path, but compute once)
    const istDateStr = toISTDateString(eventTime);  // "YYYY-MM-DD" in IST
    const dateForDB  = midnightIST(istDateStr);      // midnight IST → stored as UTC
    const monthStr   = toISTMonthString(eventTime);
    const weekStr    = toISTWeekString(eventTime);

    // ── E. Fetch shift roster (for the session's date) ────────────────────────
    //      If punching out on an overnight shift, the relevant date is the
    //      punch-IN date, not today.
    const shiftDate   = openSession ? openSession.date : dateForDB;
    const shiftDateStr = toISTDateString(shiftDate);
    const scheduledShift = await ShiftRoster.findOne({
      employeeId: employeeId,
      date: midnightIST(shiftDateStr),
    }).populate("shiftId");

    // ─────────────────────────────────────────────────────────────────────────
    // F. PUNCH-IN
    // ─────────────────────────────────────────────────────────────────────────
    if (type === "in") {
      if (openSession) {
        // Employee is already clocked in from a recent session
        await CheckIn.findByIdAndUpdate(checkInId, {
          status:                "SUCCESS",
          message:               "You are already clocked in.",
          identifiedEmployeeId:  employeeId,
          read:                  false,
        });
        console.log(`[Worker] Punch-in skipped — open session exists (id: ${openSession._id})`);
        return;
      }

      // Use findOneAndUpdate + upsert to avoid race conditions from rapid double-taps
      await Attendance.findOneAndUpdate(
        {
          employeeId:  employeeId,
          date:        dateForDB,
          punchInTime: eventTime,
        },
        {
          $setOnInsert: {
            employeeId:           employeeId,
            date:                 dateForDB,
            punchInTime:          eventTime,
            punchOutTime:         null,
            isLeave:              false,
            month:                monthStr,
            week:                 weekStr,
            attendancePercentage: 0,
          },
        },
        { upsert: true, new: true }
      );

      await CheckIn.findByIdAndUpdate(checkInId, {
        status:                "SUCCESS",
        message:               "Welcome! Punch In successful.",
        identifiedEmployeeId:  employeeId,
        read:                  false,
      });

      await invalidateAttendanceCaches(null);
      console.log(`[Worker] Punch-in recorded for ${istDateStr}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // G. PUNCH-OUT
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "out") {
      if (!openSession) {
        // No prior punch-in found within the window — record as discrepancy
        console.warn(`[Worker] Punch-out with no matching open session for employee ${employeeId}`);

        await Attendance.create({
          employeeId:           employeeId,
          date:                 dateForDB,
          punchInTime:          null,       // explicitly null — no valid punch-in
          punchOutTime:         eventTime,
          isLeave:              false,
          month:                monthStr,
          week:                 weekStr,
          attendancePercentage: 0,
        });

        await CheckIn.findByIdAndUpdate(checkInId, {
          status:                "FAILED",
          message:               "No active check-in found. Recorded as discrepancy.",
          identifiedEmployeeId:  employeeId,
          read:                  false,
        });

        await invalidateAttendanceCaches(null);
        return;
      }

      // Safeguard: don't allow a punch-out timestamp earlier than punch-in
      if (eventTime <= openSession.punchInTime) {
        throw new Error(
          `Punch-out time (${eventTime.toISOString()}) is not after punch-in time (${openSession.punchInTime.toISOString()})`
        );
      }

      // Calculate percentage using the open session's date (overnight-safe)
      const percentage = employee.post
        ? calculateAttendancePercentage(
            employee.post,
            openSession.date,     // ← use punch-IN date, not today
            openSession.punchInTime,
            eventTime,
            scheduledShift
          )
        : 0;

      await Attendance.findByIdAndUpdate(openSession._id, {
        punchOutTime:         eventTime,
        attendancePercentage: percentage,
      });

      const message = employee.post
        ? `Goodbye! Attendance recorded: ${percentage}%`
        : `Goodbye! (No post assigned — percentage not calculated)`;

      await CheckIn.findByIdAndUpdate(checkInId, {
        status:                "SUCCESS",
        message,
        identifiedEmployeeId:  employeeId,
        read:                  false,
      });

      await invalidateAttendanceCaches(openSession._id);
      console.log(
        `[Worker] Punch-out recorded. Session: ${openSession.punchInTime.toISOString()} → ${eventTime.toISOString()} | ${percentage}%`
      );
    }
  },

  {
    connection: redis,
    limiter: { max: 10, duration: 10000 },
  }
);

// ─── Worker-level error handlers ──────────────────────────────────────────────

worker.on("failed", async (job, err) => {
  console.error(`[Worker] Job ${job?.id} permanently failed:`, err.message);

  // Best-effort: mark the CheckIn as failed so the UI reflects reality
  const checkInId = job?.data?.checkInId;
  if (checkInId) {
    try {
      await CheckIn.findByIdAndUpdate(checkInId, {
        status:  "FAILED",
        message: `Processing error: ${err.message}`,
      });
    } catch (updateErr) {
      console.error("[Worker] Could not update CheckIn status on failure:", updateErr.message);
    }
  }

  // Clean up the uploaded image whether or not processing succeeded
  const filePath = job?.data?.filePath;
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
});

worker.on("completed", (job) => {
  // Clean up image on success too (the try/catch in finally originally did this,
  // but having it here keeps the job handler clean)
  const filePath = job?.data?.filePath;
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
  console.log(`[Worker] Job ${job.id} completed.`);
});

worker.on("error", (err) => {
  // Connection-level errors (Redis disconnect etc.)
  console.error("[Worker] Worker-level error:", err.message);
});