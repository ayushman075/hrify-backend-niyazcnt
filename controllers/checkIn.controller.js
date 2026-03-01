import { CheckIn } from "../models/checkIn.model.js";
import { Employee } from "../models/employee.model.js"; 
import { ShiftRoster } from "../models/shiftRoster.model.js"; 
import Attendance from "../models/attendance.model.js"; 
import { OvertimeConfig } from '../models/overtimeConfig.model.js'; 
import { Overtime } from '../models/overtime.model.js';     
import { Holiday } from '../models/holidays.model.js'; 
import { identifyUserFromFace } from "../services/azureFace.service.js"; 
import { removeCache, removeCachePattern } from "../utils/cache.js";
import { invalidateDashboardCache } from "../controllers/dashboard.controller.js";

import fs from "fs/promises"; 
import fsSync from "fs";
import path from "path";
import { v4 as uuidv4 } from 'uuid';
import moment from "moment";

const UPLOAD_DIR = "uploads/face/";
if (!fsSync.existsSync(UPLOAD_DIR)) fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });

// ==========================================
// IST DATE HELPERS (For DB Consistency)
// ==========================================
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

const getWeekId = (input) => {
    const ist = toIST(new Date(input));
    const thursday = new Date(ist);
    thursday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) + 3);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
    const yy = String(thursday.getUTCFullYear()).slice(-2);
    return String(weekNo).padStart(2, '0') + yy;
};

// ==========================================
// TIME PARSING HELPER
// ==========================================
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

// ==========================================
// CORE PERCENTAGE & OVERTIME LOGIC 
// ==========================================
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
            attendancePercentage: 100, 
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
  
      // OVERNIGHT SHIFT FIX
      if (shiftEnd < shiftStart) {
        shiftEnd = new Date(shiftEnd.getTime() + 86_400_000); 
      }
  
      scheduledMinutes = Math.round((shiftEnd - shiftStart) / 60_000); 
    } 
    // COMMENTED OUT as requested
    else if (post?.workingHour > 0) {
      scheduledMinutes = post.workingHour * 60;
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
      if (overtimePercentage >= t.fullDayPercentage) { credit = 1.0; label = 'Full Day'; roundedPercentage = 100; }
      else if (overtimePercentage >= t.threeQuarterDayPercentage) { credit = 0.75; label = '3/4 Day'; roundedPercentage = 75; }
      else if (overtimePercentage >= t.halfDayPercentage) { credit = 0.5; label = 'Half Day'; roundedPercentage = 50; }
      else if (overtimePercentage >= t.quarterDayPercentage) { credit = 0.25; label = '1/4 Day'; roundedPercentage = 25; }
    } else {
      if (overtimePercentage >= t.fullDayPercentage) { credit = 1.0; label = 'Full Day'; roundedPercentage = 100; }
      else if (overtimePercentage >= t.halfDayPercentage) { credit = 0.5; label = 'Half Day'; roundedPercentage = 50; }
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

// ==========================================
// DIRECT CONTROLLER (Face Attendance)
// ==========================================
export const processAttendance = async (req, res) => {
    let tempFilePath = null;

    try {
        const { type, timestamp } = req.body; 
        
        // 1. Validation 
        if (!req.file) return res.status(200).json({ success: false, message: "Image is required" });
        if (!type || !['in', 'out'].includes(type)) return res.status(200).json({ success: false, message: "Invalid type." });

        const eventTime = timestamp ? new Date(timestamp) : new Date();

        // 2. Write File
        const tempFileName = `${uuidv4()}.jpg`; 
        tempFilePath = path.join(UPLOAD_DIR, tempFileName);
        await fs.writeFile(tempFilePath, req.file.buffer);

        // 3. Create Receipt
        const checkIn = await CheckIn.create({
            type,
            status: "PENDING",
            message: "Verifying Face...",
            date: eventTime,
            time: eventTime
        });

        // 4. Identify Face
        const result = await identifyUserFromFace(tempFilePath);
        
        if (!result.identified) {
            checkIn.status = "FAILED";
            checkIn.message = result.reason;
            await checkIn.save();
            return res.status(200).json({ success: false, message: checkIn.message });
        }

        const personId = result.azurePersonId;

        // 5. Find Employee
        const employeeDetails = await Employee.findOne({ azurePersonId: personId }).populate("post");
        if (!employeeDetails) {
            checkIn.status = "FAILED";
            checkIn.message = "Employee record not found for this face.";
            await checkIn.save();
            return res.status(200).json({ success: false, message: checkIn.message });
        }

        const targetId = employeeDetails._id;

        // 6. Context - 22 Hour Rolling Window (Handles long overnight shifts)
        const twentyTwoHoursAgo = new Date(eventTime.getTime() - 22 * 60 * 60 * 1000);
        
        let openSession = await Attendance.findOne({ 
            employeeId: targetId, 
            punchInTime: { $gte: twentyTwoHoursAgo, $lte: eventTime },
            $or: [{ punchOutTime: null }, { punchOutTime: { $exists: false } }]
        }).sort({ punchInTime: -1 });

        // 7. Punch Logic
        let successMessage = "";
        let isFailure = false; 

        if (type === 'in') {
            if (openSession) {
                // --- DUPLICATE ENTRY ---
                isFailure = true;
                successMessage = "You already have an active Check-In. Please Check-Out first.";
            } else {
                const sessionDate = midnightIST(toISTDateString(eventTime));
                const monthStr = toISTMonthString(eventTime);
                const weekNum = getWeekId(eventTime);
                
                const shift = await ShiftRoster.findOne({ employeeId: targetId, date: sessionDate });

                await Attendance.create({ 
                    employeeId: targetId, 
                    date: sessionDate, 
                    punchInTime: eventTime, 
                    isWeekOff: shift?.isWeekOff || false,
                    month: monthStr, 
                    week: weekNum, 
                    attendancePercentage: 0 
                });
                
                successMessage = "Welcome! Punch In Successful.";
                await removeCachePattern(`attendance_list_*`);
                await invalidateDashboardCache();
            }
        } 
        else if (type === 'out') {
            if (openSession) {
                // --- SUCCESSFUL CHECKOUT ---
                openSession.punchOutTime = eventTime;
                const shiftDateStart = openSession.date; 

                // Pre-fetch dependencies
                const [scheduledShift, isExplicitHoliday, otConfig] = await Promise.all([
                    ShiftRoster.findOne({ employeeId: targetId, date: shiftDateStart }).populate("shiftId"),
                    Holiday.exists({ date: shiftDateStart, isActive: true }),
                    OvertimeConfig.findOne()
                ]);
                
                let calcStats = { attendancePercentage: 0, overtimeHours: 0, overtimePercentage: 0, otTrigger: null };
                
                if (employeeDetails.post) {
                    calcStats = calculateAttendanceStats(
                        employeeDetails.post, 
                        shiftDateStart, 
                        openSession.punchInTime, 
                        eventTime, 
                        scheduledShift,
                        !!isExplicitHoliday
                    );
                }
                
                openSession.attendancePercentage = calcStats.attendancePercentage;
                await openSession.save();
                
                await syncOvertimeRecord(openSession, calcStats, otConfig);

                successMessage = `Goodbye! Attendance: ${calcStats.attendancePercentage}%`;
                
                await removeCache(`attendance_${openSession._id}`);
                await removeCachePattern(`attendance_list_*`);
                await invalidateDashboardCache();
            } else {
                // --- OUT WITHOUT IN ---
                isFailure = true;
                successMessage = "No active Check-In found within the last 22 hours. Cannot Check-Out.";
            }
        }

        // 8. Update Receipt
        checkIn.status = isFailure ? "FAILED" : "SUCCESS";
        checkIn.message = successMessage;
        checkIn.identifiedEmployeeId = targetId;
        await checkIn.save();

        // 9. Response
        return res.status(200).json({
            success: !isFailure,
            message: successMessage,
            identifiedEmployee: {
                _id: employeeDetails._id,
                fullName: `${employeeDetails.firstName} ${employeeDetails.lastName || ""}`,
                email: employeeDetails.email
            },
            checkInId: checkIn._id
        });

    } catch (error) {
        console.error("Face Attendance Error:", error);
        return res.status(500).json({ success: false, message: `System Error: ${error.message}` });

    } finally {
        if (tempFilePath && fsSync.existsSync(tempFilePath)) {
            try { await fs.unlink(tempFilePath); } catch (e) {}
        }
    }
};

export const getCheckInStatus = async (req, res) => {
    try {
        const { id } = req.params;
        
        const record = await CheckIn.findById(id)
            .populate('identifiedEmployeeId', 'fullName email employeeId'); 

        if (!record) return res.status(404).json({ message: "Record not found" });

        res.status(200).json({
            status: record.status,
            message: record.message,
            read: record.read,
            identifiedEmployee: record.identifiedEmployeeId?.fullName || null
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};