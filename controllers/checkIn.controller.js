import { CheckIn } from "../models/checkIn.model.js";
import { Employee } from "../models/employee.model.js"; 
import { ShiftRoster } from "../models/shiftRoster.model.js"; 
import Attendance from "../models/attendance.model.js"; 
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

// [Keep your helper functions: calculateAttendancePercentage, getWeekId unchanged]
// ... (Insert them here) ...
const calculateAttendancePercentage = (post, date, punchInTime, punchOutTime, scheduledShift) => {
    if (!punchOutTime || !punchInTime) return 0;
    let scheduledMinutes = 0;
    if (scheduledShift && scheduledShift.shiftId) {
        const s = scheduledShift.shiftId.startTime;
        const e = scheduledShift.shiftId.endTime;
        const d = new Date(date).toDateString();
        scheduledMinutes = Math.floor((new Date(`${d} ${e}`) - new Date(`${d} ${s}`)) / 60000);
    } else if (post && post.workingHour) scheduledMinutes = post.workingHour * 60; 
    
    if (scheduledMinutes <= 0) return 0;
    const workedMinutes = Math.floor((new Date(punchOutTime) - new Date(punchInTime)) / 60000);
    if (workedMinutes >= scheduledMinutes) return Math.round((workedMinutes / scheduledMinutes) * 100);

    const absDifference = scheduledMinutes - workedMinutes;
    const thresholds = post?.lateAttendanceMetrics || [];
    const sorted = thresholds.sort((a, b) => b.allowedMinutes - a.allowedMinutes);
    const largest = sorted.length > 0 ? sorted[0] : null;
    if (!largest || absDifference > largest.allowedMinutes) return Math.round((workedMinutes / scheduledMinutes) * 100);

    let pct = 100;
    const penalty = sorted.find(m => absDifference > m.allowedMinutes);
    if (penalty) pct -= penalty.attendanceDeductionPercent;
    return Math.max(0, Math.round(pct));
};

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

// ==========================================
// DIRECT CONTROLLER (200 OK Logic)
// ==========================================
export const processAttendance = async (req, res) => {
    let tempFilePath = null;

    try {
        const { type, timestamp } = req.body; 
        
        // 1. Validation (Strict Errors 400/500 are okay here, but let's make 200 for Client friendliness if image missing)
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
        // The service now handles 500s internally and returns objects for 200s
        const result = await identifyUserFromFace(tempFilePath);
        
        if (!result.identified) {
            checkIn.status = "FAILED";
            checkIn.message = result.reason;
            await checkIn.save();
            // ✅ RETURN 200 OK (But Success False)
            return res.status(200).json({ success: false, message: checkIn.message });
        }

        const personId = result.azurePersonId;

        // 5. Find Employee
        const employeeDetails = await Employee.findOne({ azurePersonId: personId }).populate("post");
        if (!employeeDetails) {
            checkIn.status = "FAILED";
            checkIn.message = "Employee record not found for this face.";
            await checkIn.save();
            // ✅ RETURN 200 OK (But Success False)
            return res.status(200).json({ success: false, message: checkIn.message });
        }

        const targetId = employeeDetails._id;

        // 6. Context
        const todayStart = moment(eventTime).startOf('day').toDate();
        const monthStr = moment(eventTime).format('YYYY-MM'); 
        const weekNum = getWeekId(eventTime);
        let attendance = await Attendance.findOne({ employeeId: targetId, date: { $gte: todayStart } });

        // 7. Punch Logic
        let successMessage = "";
        let isFailure = false; 

        if (type === 'in') {
            if (attendance) {
                // --- DUPLICATE ENTRY (Logic Fail) ---
                isFailure = true;
                successMessage = "Already clocked in today.";
            } else {
                await Attendance.create({ employeeId: targetId, date: todayStart, punchInTime: eventTime, month: monthStr, week: weekNum, attendancePercentage: 0 });
                successMessage = "Welcome! Punch In Successful.";
                await removeCachePattern(`attendance_list_*`);
                await invalidateDashboardCache();
            }
        } 
        else if (type === 'out') {
            if (attendance) {
                if (attendance.punchOutTime) {
                    // --- DUPLICATE EXIT (Logic Fail) ---
                    isFailure = true;
                    successMessage = "Already clocked out today.";
                } else {
                    attendance.punchOutTime = eventTime;
                    const scheduledShift = await ShiftRoster.findOne({ employeeId: targetId, date: { $gte: todayStart, $lt: moment(todayStart).add(1, 'day').toDate() } }).populate("shiftId");
                    
                    let pct = 0;
                    if (employeeDetails.post) pct = calculateAttendancePercentage(employeeDetails.post, todayStart, attendance.punchInTime, eventTime, scheduledShift);
                    attendance.attendancePercentage = pct;
                    successMessage = `Goodbye! Attendance: ${pct}%`;
                    
                    await attendance.save();
                    await removeCache(`attendance_${attendance._id}`);
                    await removeCachePattern(`attendance_list_*`);
                    await invalidateDashboardCache();
                }
            } else {
                // --- OUT WITHOUT IN (Logic Fail) ---
                isFailure = true;
                successMessage = "No Check-In found. Cannot Check-Out.";
            }
        }

        // 8. Update Receipt
        checkIn.status = isFailure ? "FAILED" : "SUCCESS";
        checkIn.message = successMessage;
        checkIn.identifiedEmployeeId = targetId;
        await checkIn.save();

        // 9. Response
        // ✅ ALWAYS RETURN 200 OK (Unless System Crash)
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
        console.error("Direct Attendance Error:", error);
        
        // ⚠️ ONLY HERE WE RETURN 500
        // This only happens if DB is down, AWS keys are invalid, or Code crashed
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
            identifiedEmployee: record.identifiedEmployeeId.fullName || null
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};