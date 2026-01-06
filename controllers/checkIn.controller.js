// import { CheckIn } from "../models/checkIn.model.js";
// import { attendanceQueue } from "../config/queue.js"; 

import { attendanceQueue } from "../db/redis.config.js";
import { CheckIn } from "../models/checkIn.model.js";

// ==========================================
// 1. Process Attendance (Punch In/Out)
// ==========================================
export const processAttendance = async (req, res) => {
    try {
        // 1. Extract Data
        const { type, timestamp } = req.body; 
        
        // 2. Determine Punch Time
        // If frontend sends a time, use it. Otherwise, use NOW.
        const punchTime = timestamp ? new Date(timestamp) : new Date();

        // 3. Validation
        if (!req.file) {
            return res.status(400).json({ message: "Image is required" });
        }
        if (!type || !['in', 'out'].includes(type)) {
            return res.status(400).json({ message: "Invalid type. Must be 'in' or 'out'." });
        }

        // 4. Create a Receipt (Status: PENDING) with the correct Time
        const receipt = await CheckIn.create({
            type: type,
            status: "PENDING",
            message: "Processing face data...",
            date: punchTime, // Store the specific date selected
            time: punchTime  // Store the specific time selected
        });

        // 5. Add Job to Queue
        await attendanceQueue.add('verify-face', {
            filePath: req.file.path,
            checkInId: receipt._id,
            type: type,
            timestamp: punchTime // <--- PASS THIS TO WORKER
        });

        // 6. Fast Response
        res.status(202).json({
            success: true,
            message: "Request accepted. Processing...",
            checkInId: receipt._id
        });

    } catch (error) {
        console.error("Controller Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 2. Poll Status Endpoint (Unchanged)
// ==========================================
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
            identifiedEmployee: record.identifiedEmployeeId || null
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};