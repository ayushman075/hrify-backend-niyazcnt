import { Worker } from "bullmq";
import { redis } from "../db/redis.config.js";
import fs from "fs";
import moment from "moment"; 

// Models
import { User } from "../models/user.model.js"; 
import { CheckIn } from "../models/checkIn.model.js";
import { Employee } from "../models/employee.model.js"; 
import { ShiftRoster } from "../models/shiftRoster.model.js"; 
import Attendance from "../models/attendance.model.js"; 

// Services
// [Updated] Ensure this imports from your new AWS service file (or the updated azureFace.service.js)
import { identifyUserFromFace } from "../services/azureFace.service.js"; 
import { removeCache, removeCachePattern } from "../utils/cache.js";
import { invalidateDashboardCache } from "../controllers/dashboard.controller.js";


// Cache Constants
const CACHE_KEY = {
  PREFIX: "attendance_",           
  LIST_PREFIX: "attendance_list_"  
};

// ==========================================
// 1. HELPER FUNCTIONS (Local to Worker)
// ==========================================

const getWeekId = (dateInput) => {
  const date = new Date(dateInput);
  const yearShort = date.getFullYear().toString().slice(-2);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
  return `${weekNo.toString().padStart(2, '0')}${yearShort}`;
};

const calculateAttendancePercentage = (post, date, punchInTime, punchOutTime, scheduledShift) => {
  if (!punchOutTime) return 0; 
  if (!punchInTime) return 0;

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

  // Avoid division by zero
  if (scheduledMinutes <= 0) return 0;

  const workedMinutes = Math.floor((new Date(punchOutTime) - new Date(punchInTime)) / 60000);

  // Case A: Bonus / Full Score
  if (workedMinutes >= scheduledMinutes) {
    return Math.round((workedMinutes / scheduledMinutes) * 100);
  }

  // Case B: Undertime Logic
  const absDifference = scheduledMinutes - workedMinutes;
  // Safety: Ensure lateAttendanceMetrics exists
  const thresholds = post?.lateAttendanceMetrics || [];

  const sortedMetrics = thresholds.sort((a, b) => b.allowedMinutes - a.allowedMinutes);
  const largestMetric = sortedMetrics.length > 0 ? sortedMetrics[0] : null;

  if (!largestMetric || absDifference > largestMetric.allowedMinutes) {
     return Math.round((workedMinutes / scheduledMinutes) * 100);
  }

  // Case C: Penalty Logic
  let attendancePercentage = 100;
  const applicableLateMetric = sortedMetrics.find(metric => absDifference > metric.allowedMinutes);

  if (applicableLateMetric) {
    attendancePercentage -= applicableLateMetric.attendanceDeductionPercent;
  }

  return Math.max(0, Math.round(attendancePercentage));
};

// ==========================================
// 2. WORKER LOGIC
// ==========================================

export const worker = new Worker('attendanceQueue', async job => {
    const { filePath, checkInId, type, timestamp } = job.data;
    const eventTime = timestamp ? new Date(timestamp) : new Date();
        console.log("4")
        

    console.log(`[Worker] Processing ${type.toUpperCase()} | CheckIn ID: ${checkInId} | Time: ${eventTime.toISOString()}`);

    try {
        // ---------------------------------------------------------
        // A. Identify Face
        // ---------------------------------------------------------
        console.log("5")

        const result = await identifyUserFromFace(filePath);
        if (!result.identified) throw new Error(result.reason || "Face not recognized");

        // [Updated Log] Reflecting AWS terminology
        const personId = result.azurePersonId; 
        console.log(`[Worker] Identified Person ID: ${personId}`);
        console.log("6")

        // ---------------------------------------------------------
        // B. Find Employee
        // ---------------------------------------------------------
        const employeeDetails = await Employee.findOne({ azurePersonId: personId }).populate("post");

        if (!employeeDetails) {
            throw new Error(`Face recognized (ID: ${personId}), but no Employee record found.`);
        }

        console.log(`[Worker] Matched Employee: ${employeeDetails.firstName} ${employeeDetails.lastName}`);

        const targetId = employeeDetails._id; 

        // ---------------------------------------------------------
        // C. Prepare Context
        // ---------------------------------------------------------
        const todayStart = moment(eventTime).startOf('day').toDate();
        const monthStr = moment(eventTime).format('YYYY-MM'); 
        const weekNum = getWeekId(eventTime);

        // Fetch Shift Roster
        const scheduledShift = await ShiftRoster.findOne({
            employeeId: targetId,
            date: { 
                $gte: todayStart, 
                $lt: moment(todayStart).add(1, 'day').toDate() 
            }
        }).populate("shiftId");

        // Check Existing Attendance
        let attendance = await Attendance.findOne({
            employeeId: targetId,
            date: { $gte: todayStart }
        });

        // ---------------------------------------------------------
        // D. Logic Branch: IN vs OUT
        // ---------------------------------------------------------
        
        if (type === 'in') {
            if (attendance) {
                await CheckIn.findByIdAndUpdate(checkInId, {
                    status: "SUCCESS",
                    message: "You are already clocked in today.",
                    identifiedEmployeeId: targetId, 
                    read: false
                });
            } else {
                await Attendance.create({
                    employeeId: targetId,
                    date: todayStart,
                    punchInTime: eventTime,
                    month: monthStr,
                    week: weekNum,
                    attendancePercentage: 0 
                });

                await CheckIn.findByIdAndUpdate(checkInId, {
                    status: "SUCCESS",
                    message: "Welcome! Punch In Successful.",
                    identifiedEmployeeId: targetId,
                    read: false
                });
                
                await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
                await invalidateDashboardCache();
            }
        } 
        else if (type === 'out') {
            if (attendance) {
                attendance.punchOutTime = eventTime;

                // [Safety] Check if post exists before calculating
                if (employeeDetails.post) {
                    const percentage = calculateAttendancePercentage(
                        employeeDetails.post,
                        todayStart,
                        attendance.punchInTime,
                        eventTime,
                        scheduledShift
                    );
                    attendance.attendancePercentage = percentage;
                    await CheckIn.findByIdAndUpdate(checkInId, {
                        status: "SUCCESS",
                        message: `Goodbye! Attendance: ${percentage}%`,
                        identifiedEmployeeId: targetId,
                        read: false
                    });
                } else {
                    // Fallback if no Post assigned
                    attendance.attendancePercentage = 0; 
                    await CheckIn.findByIdAndUpdate(checkInId, {
                        status: "SUCCESS",
                        message: `Goodbye! (No Post assigned for calculation)`,
                        identifiedEmployeeId: targetId,
                        read: false
                    });
                }

                await attendance.save();

                await removeCache(`${CACHE_KEY.PREFIX}${attendance._id}`);
                await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
                await invalidateDashboardCache();

            } else {
                console.log(`⚠️ Corner Case: Punch Out with no In.`);
                
                await Attendance.create({
                    employeeId: targetId,
                    date: todayStart,
                    punchInTime: eventTime, 
                    punchOutTime: eventTime,
                    month: monthStr,
                    week: weekNum,
                    attendancePercentage: 0
                });

                await CheckIn.findByIdAndUpdate(checkInId, {
                    status: "FAILED", 
                    message: "No Check-In found. Recorded as Discrepancy.",
                    identifiedEmployeeId: targetId, 
                    read: false
                });

                await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
            }
        }

    } catch (error) {
        console.error(`[Worker] Job Failed:`, error.message);
        await CheckIn.findByIdAndUpdate(checkInId, {
            status: "FAILED",
            message: error.message
        });

    } finally {
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
    }

}, {
    connection: redis,
    limiter: { max: 10, duration: 10000 }
});