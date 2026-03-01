import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Overtime } from "../models/overtime.model.js";
import { OvertimeConfig } from "../models/overtimeConfig.model.js";
import { LeaveConfig } from "../models/leaveConfig.model.js";
import LeaveLimit from "../models/leaveLimit.model.js";
import { Employee } from "../models/employee.model.js";
import { User } from "../models/user.model.js";

// ==========================================
// OVERTIME CONFIGURATION MANAGEMENT
// ==========================================

export const upsertOvertimeConfig = asyncHandler(async (req, res) => {
    const { configType, quarterDayPercentage, halfDayPercentage, threeQuarterDayPercentage, fullDayPercentage } = req.body;
    const userId = req.auth?.userId;
    const user = await User.findOne({ userId });

    if (!user || user.role !== 'Admin') {
        return res.status(403).json(new ApiResponse(403, {}, "Only Admin can manage OT Config."));
    }

    const thresholds = {
        quarterDayPercentage: quarterDayPercentage || 25,
        halfDayPercentage: halfDayPercentage || 50,
        threeQuarterDayPercentage: threeQuarterDayPercentage || 75,
        fullDayPercentage: fullDayPercentage || 100,
    };

    // Find first, or create if it doesn't exist (Singleton pattern)
    let config = await OvertimeConfig.findOne();
    if (!config) {
        config = await OvertimeConfig.create({ configType, thresholds, updatedBy: user._id });
    } else {
        config.configType = configType || config.configType;
        config.thresholds = { ...config.thresholds, ...thresholds };
        config.updatedBy = user._id;
        await config.save();
    }

    return res.status(200).json(new ApiResponse(200, config, "Overtime configuration updated successfully"));
});

export const getOvertimeConfig = asyncHandler(async (req, res) => {
    let config = await OvertimeConfig.findOne().populate('updatedBy', 'fullName');
    
    // Auto-create default if none exists
    if (!config) {
        config = await OvertimeConfig.create({ configType: 'TIER_2' });
    }
    
    return res.status(200).json(new ApiResponse(200, config, "Overtime config retrieved."));
});

// ==========================================
// OVERTIME RECORDS MANAGEMENT
// ==========================================

// Helper function to calculate earned credit based on percentage and config
const calculateOtCredit = (percentage, config) => {
    const t = config.thresholds;
    if (config.configType === 'TIER_4') {
        if (percentage >= t.fullDayPercentage) return { credit: 1.0, label: 'Full Day' };
        if (percentage >= t.threeQuarterDayPercentage) return { credit: 0.75, label: '3/4 Day' };
        if (percentage >= t.halfDayPercentage) return { credit: 0.5, label: 'Half Day' };
        if (percentage >= t.quarterDayPercentage) return { credit: 0.25, label: '1/4 Day' };
    } else {
        // TIER_2 logic
        if (percentage >= t.fullDayPercentage) return { credit: 1.0, label: 'Full Day' };
        if (percentage >= t.halfDayPercentage) return { credit: 0.5, label: 'Half Day' };
    }
    return { credit: 0, label: null }; // Did not meet minimum OT threshold
};

export const createOvertime = asyncHandler(async (req, res) => {
    const { employeeId, attendanceId, date, month, week, overtimeHours, overtimePercentage } = req.body;

    const config = await OvertimeConfig.findOne();
    if (!config) {
        return res.status(400).json(new ApiResponse(400, {}, "Overtime Config is not set up. Please configure it first."));
    }

    const { credit, label } = calculateOtCredit(overtimePercentage, config);

    // If they didn't work enough OT to trigger the minimum threshold
    if (credit === 0) {
        return res.status(200).json(new ApiResponse(200, {}, "Overtime percentage did not meet the minimum threshold for credit."));
    }

    const newOvertime = await Overtime.create({
        employeeId, attendanceId, date, month, week,
        overtimeHours, overtimePercentage,
        earnedCredit: credit,
        earnedCreditLabel: label
    });

    return res.status(201).json(new ApiResponse(201, newOvertime, "Overtime recorded successfully."));
});

export const getAllOvertime = asyncHandler(async (req, res) => {
    const { employeeId, status, month, week, page = 1, limit = 10 } = req.query;
    const query = {};
    
    if (employeeId) query.employeeId = employeeId;  
    if (status) query.status = status;
    if (month) query.month = month;
    if (week) query.week = week;

    const overtimes = await Overtime.find(query)
        .populate('employeeId', 'firstName lastName employeeId')
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Overtime.countDocuments(query);

    return res.status(200).json(new ApiResponse(200, { overtimes, total, page }, "Overtime records retrieved."));
});

// ==========================================
// REDEMPTION LOGIC (PAID OR COMP-OFF LEAVE)
// ==========================================

export const redeemOvertime = asyncHandler(async (req, res) => {
    const { overtimeId } = req.params;
    const { redemptionType, notes } = req.body; // 'Paid' or 'Leave'
    const userId = req.auth?.userId;

    const user = await User.findOne({ userId });
    if (!user || (user.role !== 'Admin' && user.role !== 'HR Manager')) {
        return res.status(403).json(new ApiResponse(403, {}, "Unauthorized to redeem overtime."));
    }

    const overtime = await Overtime.findById(overtimeId);
    if (!overtime) return res.status(404).json(new ApiResponse(404, {}, "Overtime record not found."));
    if (overtime.status !== 'Pending') {
        return res.status(400).json(new ApiResponse(400, {}, `Overtime is already processed (${overtime.status}).`));
    }

    if (redemptionType === 'Paid') {
        overtime.status = 'Redeemed_Paid';
        overtime.redeemedAt = new Date();
        overtime.redeemedNotes = notes || "Redeemed for payout";
        await overtime.save();
        return res.status(200).json(new ApiResponse(200, overtime, "Overtime successfully redeemed as Paid."));
    } 
    
    if (redemptionType === 'Leave') {
        const employee = await Employee.findById(overtime.employeeId);
        if (!employee) return res.status(404).json(new ApiResponse(404, {}, "Employee not found."));

        const compOffLeaveName = "Compensatory Off";

        // 1. Find or Create LeaveConfig for Comp-Off
        let leaveConfig = await LeaveConfig.findOne({ leaveType: compOffLeaveName, posts: employee.post });
        
        if (!leaveConfig) {
            leaveConfig = await LeaveConfig.create({
                leaveType: compOffLeaveName,
                totalLeaves: 0, // Employees earn it, they don't get a default pool
                carryForwardAllowed: true,
                carryForwardLimit: 24,
                encashmentAllowed: false,
                encashmentLimit: 0,
                isPaidLeave: true,
                posts: employee.post,
                user: user._id
            });
        }

        // 2. Find or Create LeaveLimit for this specific employee
        let leaveLimit = await LeaveLimit.findOne({ employeeId: employee._id });
        if (!leaveLimit) {
            leaveLimit = await LeaveLimit.create({
                employeeId: employee._id,
                postId: employee.post,
                joinDate: employee.dateOfJoining || new Date(),
                lastRefreshed: new Date(),
                leaveDetails: []
            });
        }

        // 3. Update the specific leave balance inside LeaveLimit
        const leaveDetailIndex = leaveLimit.leaveDetails.findIndex(
            (detail) => detail.leaveType.toString() === leaveConfig._id.toString()
        );

        if (leaveDetailIndex > -1) {
            // Add earned credit (e.g., +0.5 or +1.0) to remaining leaves
            leaveLimit.leaveDetails[leaveDetailIndex].remainingLeaves += overtime.earnedCredit;
        } else {
            // Push new leave type into their limits
            leaveLimit.leaveDetails.push({
                leaveType: leaveConfig._id,
                usedLeaves: 0,
                remainingLeaves: overtime.earnedCredit
            });
        }
        await leaveLimit.save();

        // 4. Update Overtime Record
        overtime.status = 'Redeemed_Leave';
        overtime.redeemedAt = new Date();
        overtime.redeemedNotes = notes || `Added ${overtime.earnedCredit} day(s) to Compensatory Off balance.`;
        await overtime.save();

        return res.status(200).json(new ApiResponse(200, overtime, "Overtime successfully redeemed as Compensatory Leave."));
    }

    return res.status(400).json(new ApiResponse(400, {}, "Invalid redemption type. Must be 'Paid' or 'Leave'."));
});

export const deleteOvertime = asyncHandler(async (req, res) => {
    const { overtimeId } = req.params;
    const overtime = await Overtime.findByIdAndDelete(overtimeId);
    if (!overtime) return res.status(404).json(new ApiResponse(404, {}, "Record not found."));
    return res.status(200).json(new ApiResponse(200, {}, "Overtime deleted."));
});