import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Employee } from '../models/employee.model.js';
import Attendance from '../models/attendance.model.js';
import { Payroll } from '../models/payroll.model.js';
import { Holiday } from '../models/holidays.model.js';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";
import { invalidateDashboardCache } from './dashboard.controller.js';

// Extend dayjs with ISO Week plugin for accurate Monday-start calculations
dayjs.extend(isoWeek);

// Cache Keys Configuration
const CACHE_KEY = {
    PREFIX: "pay_",          // Single ID: pay_12345
    LIST_PREFIX: "pay_list_" // Query lists
};

// ------------------------------------------------------------------
// --- HELPER FUNCTIONS ---
// ------------------------------------------------------------------

/**
 * Calculates the exact date boundaries for a given period.
 * For Weekly: Strict ISO 8601 logic (Monday - Sunday).
 * For Monthly: First day - Last day of month.
 */
const getPeriodBoundaries = (periodKey, periodValue) => {
    if (periodKey === 'month') {
        // periodValue format: "YYYY-MM"
        const start = dayjs(periodValue).startOf('month');
        return { 
            start, 
            end: start.endOf('month'), 
            totalDays: start.daysInMonth() 
        };
    } else {
        // periodValue format: "WWYY" e.g., "0225"
        const week = parseInt(periodValue.substring(0, 2));
        const yearShort = parseInt(periodValue.substring(2, 4));
        const year = 2000 + yearShort;
        
        // strict ISO week: Monday start
        const start = dayjs().year(year).isoWeek(week).startOf('isoWeek'); 
        
        return { 
            start, 
            end: start.endOf('isoWeek'), 
            totalDays: 7 
        };
    }
};

const roundToTwo = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
};

const calculateProrated = (amount, daysPayable, dailyRate = (1/30)) => {
    return roundToTwo(amount * daysPayable * dailyRate);
};

// ------------------------------------------------------------------
// --- CORE CALCULATION LOGIC ---
// ------------------------------------------------------------------

const calculateAttendanceMetrics = async (attendanceRecords, boundaries, isSundayHoliday) => {
    const { start, end, totalDays } = boundaries;
    
    let presentDays = 0;
    let paidLeaveDays = 0;
    let unpaidLeave = 0;
    let holidaysCount = 0;
    let absent = 0;

    // 1. Fetch Holidays within range (Database Lookup)
    // We use .toDate() here because Mongo stores dates as ISODate objects
    const holidayRecords = await Holiday.find({
        date: { $gte: start.toDate(), $lte: end.toDate() },
        isActive: true
    });
    
    // Create Set for O(1) lookup using YYYY-MM-DD strings to avoid time issues
    const holidaySet = new Set(holidayRecords.map(h => dayjs(h.date).format('YYYY-MM-DD')));

    // 2. Map Attendance Records for O(1) lookup
    const attendanceMap = new Map();
    attendanceRecords.forEach(rec => {
        const d = dayjs(rec.date).format('YYYY-MM-DD');
        attendanceMap.set(d, rec);
    });

    // 3. Iterate Day-by-Day (Single Pass)
    // We loop through the expected days (7 or 30/31) to find gaps (absents)
    let workingDays = 0;
    
    for (let i = 0; i < totalDays; i++) {
        const current = start.add(i, 'day');
        const dateString = current.format('YYYY-MM-DD');
        const dayOfWeek = current.day(); // 0 is Sunday, 1 is Monday...

        // Priority 1: Check Official Holiday OR Paid Sunday
        const isHoliday = holidaySet.has(dateString);
        const isPaidSunday = (dayOfWeek === 0 && isSundayHoliday);

        if (isHoliday || isPaidSunday) {
            holidaysCount++;
            continue; // Skip rest of loop, it's a holiday
        }

        // If not a holiday, it is a scheduled working day
        workingDays++;

        // Priority 2: Check Attendance Record
        const record = attendanceMap.get(dateString);

        if (record) {
            if (record.isLeave) {
                // Check if Leave Type is Paid
                if (record.leaveId?.leaveType?.isPaidLeave) {
                    paidLeaveDays++;
                } else {
                    unpaidLeave++;
                }
            } else if (record.punchInTime) {
                // Add fractional day based on attendance percentage
                presentDays += (record.attendancePercentage || 0) / 100;
            }
        } else {
            // No record on a working day -> Absent
            absent++;
        }
    }

    // 4. Calculate Payables
    const totalDaysPayable = presentDays + paidLeaveDays + holidaysCount;
    const totalDaysNonPayable = unpaidLeave + absent;
    
    // Attendance % (Present / Scheduled Working Days)
    const attendancePercentage = workingDays > 0 ? (presentDays / workingDays) * 100 : 0;

    return {
        workingDays: roundToTwo(workingDays),
        presentDays: roundToTwo(presentDays),
        paidLeaveDays: roundToTwo(paidLeaveDays),
        unpaidLeave: roundToTwo(unpaidLeave),
        holidays: roundToTwo(holidaysCount), 
        absent: roundToTwo(absent),
        totalDaysPayable: roundToTwo(totalDaysPayable),
        totalDaysNonPayable: roundToTwo(totalDaysNonPayable),
        attendancePercentage: roundToTwo(attendancePercentage)
    };
};

const calculateSalaryComponents = (post, metrics) => {
    const { totalDaysPayable } = metrics;
    // Standard daily rate assumption (Month = 30 days) for consistency
    const dailyRate = 1 / 30; 

    // Calculate prorated amounts based on Payable Days
    const earnings = {
        basicSalary: calculateProrated(post.salary.basic || 0, totalDaysPayable, dailyRate),
        houseRentAllowance: calculateProrated(post.salary.houseRentAllowance || 0, totalDaysPayable, dailyRate),
        dearnessAllowance: calculateProrated(post.salary.dearnessAllowance || 0, totalDaysPayable, dailyRate),
        perquisites: calculateProrated(post.salary.perquisites || 0, totalDaysPayable, dailyRate),
        others: calculateProrated(post.salary.others || 0, totalDaysPayable, dailyRate),
        bonus: post.salary.bonus || 0,
        variablePay: post.salary.variablePay || 0,
    };

    earnings.grossSalary = roundToTwo(
        earnings.basicSalary + 
        earnings.dearnessAllowance + 
        earnings.houseRentAllowance + 
        earnings.perquisites
    );

    // --- Deductions Logic ---
    let epfEmployee = 0;
    let epfEmployer = 0;
    let esiEmployee = 0;
    let esiEmployer = 0;

    // PF Calculation
    if (post.isPfPayable) {
        const pfBasis = Math.min(earnings.basicSalary, 15000);
        epfEmployee = roundToTwo(pfBasis * 0.12);
        epfEmployer = roundToTwo(pfBasis * 0.13);
    }

    // ESI Calculation
    if (post.isEsiPayable) {
        esiEmployee = roundToTwo(earnings.grossSalary * 0.0075); // 0.75%
        esiEmployer = roundToTwo(earnings.grossSalary * 0.0325); // 3.25%
    }

    const taxes = post.salary.taxes || 0;
    const totalDeductions = roundToTwo(epfEmployee + esiEmployee + taxes);

    // Net Salary
    const netSalary = roundToTwo(
        earnings.grossSalary + 
        earnings.bonus + 
        earnings.variablePay + 
        earnings.others - 
        totalDeductions
    );

    return {
        earnings: roundToTwo(earnings), // Helper to round all fields inside object if needed
        deductions: {
            epfEmployee,
            epfEmployer,
            esiEmployee,
            esiEmployer,
            taxes,
            totalDeductions
        },
        netSalary
    };
};

// Internal Processor to handle both Week and Month logic centrally
const generatePayrollInternal = async (employee, periodKey, periodValue) => {
    // 1. Determine Boundaries for the loop (Monday-Sunday or Month Start-End)
    const boundaries = getPeriodBoundaries(periodKey, periodValue);
    
    const isSundayHoliday = employee.post?.payrollType && employee.post.payrollType.includes('With_Sunday_Holiday');

    // 2. Query Attendance DIRECTLY using the stored field
    // This removes the "Tuesday" bug because we fetch exactly what is stored.
    const query = { employeeId: employee._id };
    if (periodKey === 'month') {
        query.month = periodValue; 
    } else {
        query.week = periodValue; // e.g. "0225"
    }

    const attendanceRecords = await Attendance.find(query).populate({
        path: 'leaveId',
        populate: {
            path: 'leaveType',
            model: 'LeaveConfig',
        },
    });

    // 3. Calculate Metrics
    const attendanceData = await calculateAttendanceMetrics(
        attendanceRecords,
        boundaries,
        isSundayHoliday
    );

    // 4. Calculate Salary
    const { earnings, deductions, netSalary } = calculateSalaryComponents(employee.post, attendanceData);

    // 5. Construct Payroll Object
    const payrollData = {
        employee: employee._id,
        month: periodValue, // Stores either "YYYY-MM" or "WWYY"
        type: periodKey === 'week' ? 'Weekly' : 'Monthly',
        attendance: attendanceData,
        earnings,
        deductions,
        netSalary,
        status: 'processed',
        processedAt: new Date()
    };

    // 6. Save/Update Payroll
    const savedPayroll = await Payroll.findOneAndUpdate(
        { employee: employee._id, month: periodValue },
        payrollData,
        { upsert: true, new: true }
    );

    return savedPayroll;
};


// ------------------------------------------------------------------
// --- CONTROLLERS ---
// ------------------------------------------------------------------

// 1. Generate MONTHLY Payroll
const generateMonthlyPayroll = asyncHandler(async (req, res) => {
    const { month } = req.body; // YYYY-MM

    if (!month) {
        return res.status(400).json(new ApiResponse(400, null, "Month is required", false));
    }

    // Fetch Eligible Monthly Employees
    const allEmployees = await Employee.find({ 
        status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] } 
    }).populate('post');

    const monthlyEmployees = allEmployees.filter(emp => 
        emp.post?.payrollType && emp.post.payrollType.startsWith('Monthly')
    );

    if (monthlyEmployees.length === 0) {
        return res.status(200).json(new ApiResponse(200, { processed: 0 }, "No eligible Monthly employees found", true));
    }

    const results = { processed: 0, failed: 0, failedRecords: [] };

    for (const employee of monthlyEmployees) {
        try {
            await generatePayrollInternal(employee, 'month', month);
            results.processed++;
        } catch (error) {
            results.failed++;
            results.failedRecords.push({ employeeId: employee.employeeId, error: error.message });
        }
    }

    // [CACHE INVALIDATION]
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await invalidateDashboardCache();

    return res.status(200).json(new ApiResponse(200, results, "Monthly payroll processing completed", true));
});


// 2. Generate WEEKLY Payroll
const generateWeeklyPayroll = asyncHandler(async (req, res) => {
    const { week } = req.body; // WWYY

    if (!week || !/^\d{4}$/.test(week)) {
        return res.status(400).json(new ApiResponse(400, null, "Valid Week (WWYY) is required", false));
    }

    // Fetch Eligible Weekly Employees
    const allEmployees = await Employee.find({ 
        status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] } 
    }).populate('post');

    const weeklyEmployees = allEmployees.filter(emp => 
        emp.post?.payrollType && emp.post.payrollType.startsWith('Weekly')
    );

    if (weeklyEmployees.length === 0) {
        return res.status(200).json(new ApiResponse(200, { processed: 0 }, "No eligible Weekly employees found", true));
    }

    const results = { processed: 0, failed: 0, failedRecords: [] };

    for (const employee of weeklyEmployees) {
        try {
            await generatePayrollInternal(employee, 'week', week);
            results.processed++;
        } catch (error) {
            results.failed++;
            results.failedRecords.push({ employeeId: employee.employeeId, error: error.message });
        }
    }

    // [CACHE INVALIDATION]
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await invalidateDashboardCache();

    return res.status(200).json(new ApiResponse(200, results, "Weekly payroll processing completed", true));
});


// 3. Process Single Employee (Unified)
const processEmployeePayroll = asyncHandler(async (req, res) => {
    const { employeeId, month, week } = req.body;

    if (!employeeId) {
        return res.status(400).json(new ApiResponse(400, null, "Employee ID is required", false));
    }

    const employee = await Employee.findById(employeeId).populate('post');
    if (!employee) {
        return res.status(404).json(new ApiResponse(404, null, "Employee not found", false));
    }

    const payrollType = employee.post.payrollType || "";
    let periodKey = "";
    let periodValue = "";

    if (payrollType.startsWith('Monthly')) {
        if (!month) return res.status(400).json(new ApiResponse(400, null, "Month (YYYY-MM) is required", false));
        periodKey = 'month';
        periodValue = month;
    } else if (payrollType.startsWith('Weekly')) {
        if (!week) return res.status(400).json(new ApiResponse(400, null, "Week (WWYY) is required", false));
        periodKey = 'week';
        periodValue = week;
    } else {
        return res.status(400).json(new ApiResponse(400, null, "Invalid Payroll Type configuration on employee", false));
    }

    const payroll = await generatePayrollInternal(employee, periodKey, periodValue);

    // [CACHE INVALIDATION]
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await invalidateDashboardCache();

    return res.status(200).json(new ApiResponse(200, payroll, "Payroll processed successfully", true));
});


// 4. Get Payroll By ID (Standard)
const getPayrollById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Payroll retrieved from Cache", true));
    }

    const payroll = await Payroll.findById(id)
        .populate('employee', 'employeeId firstName lastName')
        .populate('employee.post', 'title department');

    if (!payroll) {
        return res.status(404).json(new ApiResponse(404, null, "Payroll record not found", false));
    }

    await setCache(cacheKey, payroll, 3600);

    return res.status(200).json(new ApiResponse(200, payroll, "Payroll retrieved successfully", true));
});


// 5. Get Filtered Payroll (Standard)
const getFilteredPayroll = asyncHandler(async (req, res) => {
    const { month, employeeId, status, site, sort = "createdAt", order = "desc", page = 1, limit = 10 } = req.query;

    const filterKey = JSON.stringify(req.query);
    const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
    
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Payroll data retrieved from Cache", true));
    }

    const query = {};
    // Note: 'month' in DB stores both YYYY-MM and WWYY. 
    // If frontend sends ?month=0225, it works for weekly too.
    if (month) query.month = month; 
    if (status) query.status = status;

    // Site Filter Logic
    if (site) {
        try {
            const employeesAtSite = await Employee.find({ site }).select('_id');
            const siteEmployeeIds = employeesAtSite.map(emp => emp._id);

            if (employeeId) {
                const isEmployeeAtSite = siteEmployeeIds.some(
                    id => id.toString() === employeeId.toString()
                );
                if (isEmployeeAtSite) {
                    query.employee = employeeId;
                } else {
                    query.employee = null; // Conflict -> Empty result
                }
            } else {
                query.employee = { $in: siteEmployeeIds };
            }
        } catch (error) {
            console.error("Error filtering by site in Payroll:", error);
            return res.status(500).json(new ApiResponse(500, null, "Error applying site filter", false));
        }
    } else if (employeeId) {
        query.employee = employeeId;
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const payrolls = await Payroll.find(query)
        .populate({ path: 'employee', populate: { path: 'post', populate: { path: 'department' } } })
        .populate({ path: 'employee', populate: { path: 'site', select: 'siteName' } })
        .sort({ [sort]: order === "asc" ? 1 : -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum);

    const total = await Payroll.countDocuments(query);

    const responsePayload = {
        payrolls,
        totalPages: Math.ceil(total / limitNum),
        currentPage: pageNum,
        total
    };

    await setCache(cacheKey, responsePayload, 3600);

    return res.status(200).json(new ApiResponse(200, responsePayload, "Payroll data retrieved successfully", true));
});


// 6. Update Payroll (Manual Override)
const updatePayroll = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, earnings, deductions, netSalary, comments } = req.body;

    const payroll = await Payroll.findById(id);
    if (!payroll) {
        return res.status(404).json(new ApiResponse(404, null, "Payroll record not found", false));
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (comments) updateData.comments = comments;

    // --- Recalculate Logic if Manual Edits are provided ---
    // (Kept same as your previous logic for data integrity)
    if (earnings) {
        const earningsUpdate = {};
        if (earnings.basicSalary !== undefined) earningsUpdate['earnings.basicSalary'] = roundToTwo(earnings.basicSalary);
        if (earnings.houseRentAllowance !== undefined) earningsUpdate['earnings.houseRentAllowance'] = roundToTwo(earnings.houseRentAllowance);
        if (earnings.dearnessAllowance !== undefined) earningsUpdate['earnings.dearnessAllowance'] = roundToTwo(earnings.dearnessAllowance);
        if (earnings.perquisites !== undefined) earningsUpdate['earnings.perquisites'] = roundToTwo(earnings.perquisites);
        if (earnings.others !== undefined) earningsUpdate['earnings.others'] = roundToTwo(earnings.others);
        if (earnings.bonus !== undefined) earningsUpdate['earnings.bonus'] = roundToTwo(Number(earnings.bonus));
        if (earnings.variablePay !== undefined) earningsUpdate['earnings.variablePay'] = roundToTwo(earnings.variablePay);

        if (Object.keys(earningsUpdate).length > 0) {
            const updatedEarnings = {
                basicSalary: earnings.basicSalary !== undefined ? Number(earnings.basicSalary) : payroll.earnings.basicSalary,
                houseRentAllowance: earnings.houseRentAllowance !== undefined ? Number(earnings.houseRentAllowance) : payroll.earnings.houseRentAllowance,
                dearnessAllowance: earnings.dearnessAllowance !== undefined ? Number(earnings.dearnessAllowance) : payroll.earnings.dearnessAllowance,
                perquisites: earnings.perquisites !== undefined ? Number(earnings.perquisites) : payroll.earnings.perquisites,
                others: earnings.others !== undefined ? Number(earnings.others) : payroll.earnings.others,
                bonus: earnings.bonus !== undefined ? Number(earnings.bonus) : Number(payroll.earnings.bonus),
                variablePay: earnings.variablePay !== undefined ? Number(earnings.variablePay) : payroll.earnings.variablePay
            };
            
            earningsUpdate['earnings.grossSalary'] = roundToTwo(
                updatedEarnings.basicSalary + 
                updatedEarnings.houseRentAllowance + 
                updatedEarnings.dearnessAllowance + 
                updatedEarnings.perquisites +
                updatedEarnings.others + // Include Others in Gross if that's your policy
                updatedEarnings.bonus +
                updatedEarnings.variablePay
            );
            
            Object.assign(updateData, earningsUpdate);
        }
    }

    if (deductions) {
        const deductionsUpdate = {};
        if (deductions.epfEmployee !== undefined) deductionsUpdate['deductions.epfEmployee'] = roundToTwo(Number(deductions.epfEmployee));
        if (deductions.esiEmployee !== undefined) deductionsUpdate['deductions.esiEmployee'] = roundToTwo(Number(deductions.esiEmployee));
        if (deductions.taxes !== undefined) deductionsUpdate['deductions.taxes'] = roundToTwo(deductions.taxes);

        if (Object.keys(deductionsUpdate).length > 0) {
            const updatedDeductions = {
                epfEmployee: deductions.epfEmployee !== undefined ? Number(deductions.epfEmployee) : Number(payroll.deductions.epfEmployee),
                esiEmployee: deductions.esiEmployee !== undefined ? Number(deductions.esiEmployee) : Number(payroll.deductions.esiEmployee),
                taxes: deductions.taxes !== undefined ? Number(deductions.taxes) : Number(payroll.deductions.taxes)
            };
            
            deductionsUpdate['deductions.totalDeductions'] = roundToTwo(
                updatedDeductions.epfEmployee +
                updatedDeductions.esiEmployee +
                updatedDeductions.taxes
            );
            
            Object.assign(updateData, deductionsUpdate);
        }
    }

    if (netSalary !== undefined) {
        updateData.netSalary = roundToTwo(Number(netSalary));
    } else if (earnings || deductions) {
        const currentPayroll = await Payroll.findById(id);
        
        const finalGrossSalary = updateData['earnings.grossSalary'] !== undefined 
            ? updateData['earnings.grossSalary'] 
            : currentPayroll.earnings.grossSalary;

        const finalTotalDeductions = updateData['deductions.totalDeductions'] !== undefined 
            ? updateData['deductions.totalDeductions'] 
            : currentPayroll.deductions.totalDeductions;

        updateData.netSalary = roundToTwo(finalGrossSalary - finalTotalDeductions);
    }

    updateData.updatedAt = new Date();
    updateData.lastModifiedBy = req.user?._id;

    const updatedPayroll = await Payroll.findByIdAndUpdate(id, updateData, { new: true })
        .populate('employee', 'employeeId firstName lastName')
        .populate({ path: 'employee', populate: { path: 'post', select: 'title department' } });

    // [CACHE INVALIDATION]
    await removeCache(`${CACHE_KEY.PREFIX}${id}`);
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await invalidateDashboardCache();

    return res.status(200).json(new ApiResponse(200, updatedPayroll, "Payroll record updated successfully", true));
});

export {
    generateMonthlyPayroll,
    generateWeeklyPayroll,
    processEmployeePayroll,
    getPayrollById,
    getFilteredPayroll,
    updatePayroll
};