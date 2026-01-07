import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Employee } from '../models/employee.model.js';
import Attendance from '../models/attendance.model.js';
import { Payroll } from '../models/payroll.model.js';
import { Holiday } from '../models/holidays.model.js';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import weekday from 'dayjs/plugin/weekday.js'; // Added for extra safety
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";
import { invalidateDashboardCache } from './dashboard.controller.js';

// Extend dayjs plugins
dayjs.extend(isoWeek);
dayjs.extend(weekday);

// Cache Keys Configuration
const CACHE_KEY = {
    PREFIX: "pay_",
    LIST_PREFIX: "pay_list_"
};

// ------------------------------------------------------------------
// --- HELPER FUNCTIONS ---
// ------------------------------------------------------------------

const getWeekDateRange = (weekId) => {
    // weekId format: "WWYY" e.g., "0225"
    const week = parseInt(weekId.substring(0, 2));
    const yearShort = parseInt(weekId.substring(2, 4));
    const year = 2000 + yearShort;
    
    // 1. Initialize dayjs object with the target year
    // 2. Set the ISO Week number
    // 3. Force the day to be ISO Weekday 1 (Monday)
    // 4. Normalize time to start of day to avoid timezone offsets
    const start = dayjs()
        .year(year)
        .isoWeek(week)
        .isoWeekday(1) 
        .hour(0).minute(0).second(0).millisecond(0);
    
    const end = start.add(6, 'day').endOf('day');
    
    return { 
        start: start.toDate(), 
        end: end.toDate() 
    };
};

const roundToTwo = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
};

const roundAllValues = (obj) => {
    const rounded = {};
    for (const [key, value] of Object.entries(obj)) {
        rounded[key] = typeof value === 'number' ? roundToTwo(value) : value;
    }
    return rounded;
};

const calculateProrated = (amount, daysPayable, dailyRate) => {
    return roundToTwo(amount * daysPayable * dailyRate);
};

const calculateTotalDeductions = (components, taxes) => {
    return roundToTwo(
        components.epfEmployeeContribution +
        components.esiEmployeeContribution +
        (taxes || 0)
    );
};

// ------------------------------------------------------------------
// --- CORE CALCULATION LOGIC ---
// ------------------------------------------------------------------

const calculateAttendanceMetrics = async (attendanceRecords, startDate, endDate, isSundayHoliday) => {
    let workingDays = 0;   
    let presentDays = 0;
    let paidLeaveDays = 0;
    let unpaidLeave = 0;
    let holidays = 0;
    let absent = 0;

    const start = dayjs(startDate);
    const end = dayjs(endDate);
    const totalDays = end.diff(start, 'day') + 1;

    // 1. Fetch Holidays within range (For logic calculation)
    const holidayRecords = await Holiday.find({
        date: { $gte: start.toDate(), $lte: end.toDate() },
        isActive: true
    });
    
    // Format holidays to YYYY-MM-DD for comparison
    const holidaySet = new Set(holidayRecords.map(h => dayjs(h.date).format('YYYY-MM-DD')));

    // 2. Map Attendance Records for O(1) lookup
    // Using Map allows us to robustly match dates even if time components differ slightly
    const attendanceMap = new Map();
    attendanceRecords.forEach(rec => {
        const d = dayjs(rec.date).format('YYYY-MM-DD');
        attendanceMap.set(d, rec);
    });

    // 3. Iterate Day-by-Day (Strict 7 Day Loop for Weekly, ~30 for Monthly)
    for (let i = 0; i < totalDays; i++) {
        const current = start.add(i, 'day');
        const dateString = current.format('YYYY-MM-DD');
        const dayOfWeek = current.day(); // 0 is Sunday, 1 is Monday...
        
        // Priority 1: Check Official Holiday (Global Holidays)
        if (holidaySet.has(dateString)) {
            holidays++;
            continue; 
        } 
        
        // Priority 2: Check Sunday Logic (based on payrollType)
        if (dayOfWeek === 0 && isSundayHoliday) {
            holidays++; 
            continue;
        } 

        // If not a holiday, it is a scheduled working day
        workingDays++;

        // Priority 3: Check Attendance (Fetch from the Map created via Week ID query)
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
            // No record found in the set fetched by Week ID -> Absent
            absent++;
        }
    }

    // 4. Calculate Payables
    const totalDaysPayable = presentDays + paidLeaveDays + holidays;
    const totalDaysNonPayable = unpaidLeave + absent;
    
    const attendancePercentage = workingDays > 0 ? (presentDays / workingDays) * 100 : 0;

    return {
        workingDays: roundToTwo(workingDays),
        presentDays: roundToTwo(presentDays),
        paidLeaveDays: roundToTwo(paidLeaveDays),
        unpaidLeave: roundToTwo(unpaidLeave),
        holidays: roundToTwo(holidays), 
        absent: roundToTwo(absent),
        totalDaysPayable: roundToTwo(totalDaysPayable),
        totalDaysNonPayable: roundToTwo(totalDaysNonPayable),
        attendancePercentage: roundToTwo(attendancePercentage)
    };
};




const calculateSalaryComponents = (post, metrics) => {
    const { totalDaysPayable } = metrics;
    // Standard daily rate assumption (Month = 30 days)
    const dailyRate = 1 / 30; 

    const salaryComponents = {
        basicSalary: calculateProrated(post.salary.basic || 0, totalDaysPayable, dailyRate) || 0,
        houseRentAllowance: calculateProrated(post.salary.houseRentAllowance || 0, totalDaysPayable, dailyRate) || 0,
        dearnessAllowance: calculateProrated(post.salary.dearnessAllowance || 0, totalDaysPayable, dailyRate) || 0,
        perquisites: calculateProrated(post.salary.perquisites || 0, totalDaysPayable, dailyRate) || 0,
        others: calculateProrated(post.salary.others || 0, totalDaysPayable, dailyRate) || 0,
        bonus: post.salary.bonus || 0,
        variablePay: post.salary.variablePay || 0,
    };

    salaryComponents.grossSalary = roundToTwo(
        salaryComponents.basicSalary + 
        salaryComponents.dearnessAllowance + 
        salaryComponents.houseRentAllowance + 
        salaryComponents.perquisites
    ) || 0;

    // --- PF & ESI Logic ---
    if (post.isPfPayable) {
        const pfBasis = Math.min(salaryComponents.basicSalary, 15000);
        salaryComponents.epfEmployeeContribution = roundToTwo(pfBasis * 0.12);
        salaryComponents.epfEmployerContribution = roundToTwo(pfBasis * 0.13);
    } else {
        salaryComponents.epfEmployeeContribution = 0;
        salaryComponents.epfEmployerContribution = 0;
    }

    if (post.isEsiPayable) {
        salaryComponents.esiEmployeeContribution = roundToTwo(salaryComponents.grossSalary * 0.0075); 
        salaryComponents.esiEmployerContribution = roundToTwo(salaryComponents.grossSalary * 0.0325); 
    } else {
        salaryComponents.esiEmployeeContribution = 0;
        salaryComponents.esiEmployerContribution = 0;
    }

    salaryComponents.totalDeductions = calculateTotalDeductions(salaryComponents, post.salary.taxes);

    salaryComponents.netSalary = roundToTwo(
        salaryComponents.grossSalary + 
        salaryComponents.bonus + 
        salaryComponents.variablePay + 
        salaryComponents.others - 
        salaryComponents.totalDeductions
    );

    return roundAllValues(salaryComponents);
};

const calculateEmployeePayrollData = async (employee, periodData) => {
    const payrollType = employee.post.payrollType;
    const isSundayHoliday = payrollType && payrollType.includes('With_Sunday_Holiday');

    // --- UPDATED FETCHING LOGIC ---
    let attendanceQuery = { employeeId: employee._id };
    
    if (periodData.periodKey === 'week') {
        // STRICTLY use the 'week' ID field. 
        // We do NOT use date range to query DB for weekly payroll to ensure consistency.
        attendanceQuery.week = periodData.periodValue; 
    } else if (periodData.periodKey === 'month') {
        attendanceQuery.month = periodData.periodValue;
    } else {
        // Fallback
        attendanceQuery.date = { 
            $gte: periodData.startDate, 
            $lte: periodData.endDate 
        };
    }

    // Fetch records
    const attendanceRecords = await Attendance.find(attendanceQuery).populate({
        path: 'leaveId',
        populate: {
            path: 'leaveType',
            model: 'LeaveConfig',
        },
    });

    // Pass records to calculator
    // Note: We still pass startDate/endDate here because the calculator needs to 
    // iterate through specific calendar days to identify Sundays and Holidays vs Working days.
    const attendanceData = await calculateAttendanceMetrics(
        attendanceRecords,
        periodData.startDate,
        periodData.endDate,
        isSundayHoliday
    );

    const salaryComponents = calculateSalaryComponents(employee.post, attendanceData);

    return { attendanceData, salaryComponents };
};

// ------------------------------------------------------------------
// --- CONTROLLERS ---
// ------------------------------------------------------------------

// 1. Generate MONTHLY Payroll
const generateMonthlyPayroll = asyncHandler(async (req, res) => {
    const { month } = req.body; // YYYY-MM (Site removed as per request)

    if (!month) {
        return res.status(400).json(new ApiResponse(400, null, "Month is required", false));
    }

    const startOfMonth = dayjs(month).startOf('month').toDate();
    const endOfMonth = dayjs(month).endOf('month').toDate();

    // FILTER: Employees with valid working statuses
    const allEmployees = await Employee.find({ 
        status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] } 
    }).populate('post');

    // FILTER: Only keep employees with 'Monthly' payroll types
    const monthlyEmployees = allEmployees.filter(emp => 
        emp.post?.payrollType && emp.post.payrollType.startsWith('Monthly')
    );

    if (monthlyEmployees.length === 0) {
        return res.status(200).json(new ApiResponse(200, { processed: 0 }, "No eligible Monthly employees found", true));
    }

    const results = { processed: 0, failed: 0, failedRecords: [] };

    for (const employee of monthlyEmployees) {
        try {
            const { attendanceData, salaryComponents } = await calculateEmployeePayrollData(employee, {
                startDate: startOfMonth,
                endDate: endOfMonth,
                periodKey: 'month',
                periodValue: month
            });

            const payrollData = {
                employee: employee._id,
                month,
                type: 'Monthly',
                attendance: attendanceData,
                earnings: salaryComponents,
                deductions: {
                    epfEmployee: salaryComponents.epfEmployeeContribution,
                    esiEmployee: salaryComponents.esiEmployeeContribution,
                    taxes: employee.post.salary.taxes || 0,
                    totalDeductions: salaryComponents.totalDeductions
                },
                netSalary: salaryComponents.netSalary,
                status: 'processed',
                processedAt: new Date()
            };

            await Payroll.findOneAndUpdate(
                { employee: employee._id, month },
                payrollData,
                { upsert: true, new: true }
            );

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

    // Calculate range strictly for the "Logic Loop" (to detect holidays/Sundays)
    const { start, end } = getWeekDateRange(week);
    
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
            // We pass periodValue: week. This ensures calculateEmployeePayrollData
            // uses the 'week' ID for the DB query, ensuring 100% consistency with Attendance.
            const { attendanceData, salaryComponents } = await calculateEmployeePayrollData(employee, {
                startDate: start,
                endDate: end,
                periodKey: 'week',
                periodValue: week 
            });

            const payrollData = {
                employee: employee._id,
                month: week, // Storing week ID in the 'month' field as per schema convention or change schema to support 'periodId'
                type: 'Weekly',
                attendance: attendanceData,
                earnings: salaryComponents,
                deductions: {
                    epfEmployee: salaryComponents.epfEmployeeContribution,
                    esiEmployee: salaryComponents.esiEmployeeContribution,
                    taxes: employee.post.salary.taxes || 0,
                    totalDeductions: salaryComponents.totalDeductions
                },
                netSalary: salaryComponents.netSalary,
                status: 'processed',
                processedAt: new Date()
            };

            await Payroll.findOneAndUpdate(
                { employee: employee._id, month: week },
                payrollData,
                { upsert: true, new: true }
            );

            results.processed++;
        } catch (error) {
            results.failed++;
            results.failedRecords.push({ employeeId: employee.employeeId, error: error.message });
        }
    }

    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await invalidateDashboardCache();

    return res.status(200).json(new ApiResponse(200, results, "Weekly payroll processing completed", true));
});

// 3. Process Single Employee
const processEmployeePayroll = asyncHandler(async (req, res) => {
    const { employeeId, month, week } = req.body;

    if (!employeeId) {
        return res.status(400).json(new ApiResponse(400, null, "Employee ID is required", false));
    }

    const employee = await Employee.findById(employeeId).populate('post');
    if (!employee) {
        return res.status(404).json(new ApiResponse(404, null, "Employee not found", false));
    }

    const payrollType = employee.post.payrollType;
    let periodData = {};

    if (payrollType && payrollType.startsWith('Monthly')) {
        if (!month) return res.status(400).json(new ApiResponse(400, null, "Month (YYYY-MM) is required", false));
        periodData = {
            startDate: dayjs(month).startOf('month').toDate(),
            endDate: dayjs(month).endOf('month').toDate(),
            periodKey: 'month',
            periodValue: month
        };
    } else if (payrollType && payrollType.startsWith('Weekly')) {
        if (!week) return res.status(400).json(new ApiResponse(400, null, "Week (WWYY) is required", false));
        const { start, end } = getWeekDateRange(week);
        periodData = {
            startDate: start,
            endDate: end,
            periodKey: 'week',
            periodValue: week
        };
    } else {
        return res.status(400).json(new ApiResponse(400, null, "Invalid Payroll Type", false));
    }

    const { attendanceData, salaryComponents } = await calculateEmployeePayrollData(employee, periodData);

    const payrollData = {
        employee: employee._id,
        month: periodData.periodValue,
        type: payrollType.startsWith('Weekly') ? 'Weekly' : 'Monthly',
        attendance: attendanceData,
        earnings: salaryComponents,
        deductions: {
            epfEmployee: salaryComponents.epfEmployeeContribution,
            esiEmployee: salaryComponents.esiEmployeeContribution,
            taxes: employee.post.salary.taxes || 0,
            totalDeductions: salaryComponents.totalDeductions
        },
        netSalary: salaryComponents.netSalary,
        status: 'processed',
        processedAt: new Date()
    };

    const payroll = await Payroll.findOneAndUpdate(
        { employee: employee._id, month: periodData.periodValue },
        payrollData,
        { upsert: true, new: true }
    );

    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await invalidateDashboardCache();

    return res.status(200).json(new ApiResponse(200, payroll, "Payroll processed successfully", true));
});

// 4. Get Payroll By ID
const getPayrollById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

    // [CACHE READ]
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

    // [CACHE WRITE]
    await setCache(cacheKey, payroll, 3600);

    return res.status(200).json(new ApiResponse(200, payroll, "Payroll retrieved successfully", true));
});

// 5. Get Filtered Payroll
const getFilteredPayroll = asyncHandler(async (req, res) => {
    const { month, employeeId, status, site, sort = "createdAt", order = "desc", page = 1, limit = 10 } = req.query;

    // [CACHE READ]
    const filterKey = JSON.stringify(req.query);
    const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
    
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Payroll data retrieved from Cache", true));
    }

    const query = {};
    if (month) query.month = month; 
    if (status) query.status = status;

    // --- SITE FILTER LOGIC (Kept as required) ---
    if (site) {
        try {
            // Step 1: Find all employees at this site
            const employeesAtSite = await Employee.find({ site }).select('_id');
            const siteEmployeeIds = employeesAtSite.map(emp => emp._id);

            if (employeeId) {
                // If user requests a specific employee AND a site, check if they intersect
                const isEmployeeAtSite = siteEmployeeIds.some(
                    id => id.toString() === employeeId.toString()
                );
                
                if (isEmployeeAtSite) {
                    query.employee = employeeId;
                } else {
                    // Conflict: The specific employee is NOT at the requested site.
                    query.employee = null; // Force empty result
                }
            } else {
                // Step 2: Filter Payroll by list of IDs from that site
                query.employee = { $in: siteEmployeeIds };
            }
        } catch (error) {
            console.error("Error filtering by site in Payroll:", error);
            return res.status(500).json(new ApiResponse(500, null, "Error applying site filter", false));
        }
    } else if (employeeId) {
        // Normal employee filter
        query.employee = employeeId;
    }
    // -------------------------

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const payrolls = await Payroll.find(query)
        .populate({ path: 'employee', populate: { path: 'post', populate: { path: 'department' } } })
        .populate({ path: 'employee', populate: { path: 'site', select: 'siteName' } }) // Populate site info in response
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

    // [CACHE WRITE]
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

    // --- 1. Handle Earnings & Gross Calculation ---
    if (earnings) {
        const earningsUpdate = {};
        
        // Update individual fields if present
        if (earnings.basicSalary !== undefined) earningsUpdate['earnings.basicSalary'] = roundToTwo(earnings.basicSalary);
        if (earnings.houseRentAllowance !== undefined) earningsUpdate['earnings.houseRentAllowance'] = roundToTwo(earnings.houseRentAllowance);
        if (earnings.dearnessAllowance !== undefined) earningsUpdate['earnings.dearnessAllowance'] = roundToTwo(earnings.dearnessAllowance);
        if (earnings.perquisites !== undefined) earningsUpdate['earnings.perquisites'] = roundToTwo(earnings.perquisites);
        if (earnings.others !== undefined) earningsUpdate['earnings.others'] = roundToTwo(earnings.others);
        if (earnings.bonus !== undefined) earningsUpdate['earnings.bonus'] = roundToTwo(Number(earnings.bonus));
        if (earnings.variablePay !== undefined) earningsUpdate['earnings.variablePay'] = roundToTwo(earnings.variablePay);

        // Recalculate Gross Salary
        if (Object.keys(earningsUpdate).length > 0) {
            // Merge existing DB values with incoming updates to get the full picture
            const updatedEarnings = {
                basicSalary: earnings.basicSalary !== undefined ? Number(earnings.basicSalary) : payroll.earnings.basicSalary,
                houseRentAllowance: earnings.houseRentAllowance !== undefined ? Number(earnings.houseRentAllowance) : payroll.earnings.houseRentAllowance,
                dearnessAllowance: earnings.dearnessAllowance !== undefined ? Number(earnings.dearnessAllowance) : payroll.earnings.dearnessAllowance,
                perquisites: earnings.perquisites !== undefined ? Number(earnings.perquisites) : payroll.earnings.perquisites,
                others: earnings.others !== undefined ? Number(earnings.others) : payroll.earnings.others,
                bonus: earnings.bonus !== undefined ? Number(earnings.bonus) : Number(payroll.earnings.bonus),
                variablePay: earnings.variablePay !== undefined ? Number(earnings.variablePay) : payroll.earnings.variablePay
            };
            
            // UPDATED FORMULA: Gross = Basic + HRA + DA + Perquisites + Others + Bonus + Variable Pay
            earningsUpdate['earnings.grossSalary'] = roundToTwo(
                updatedEarnings.basicSalary + 
                updatedEarnings.houseRentAllowance + 
                updatedEarnings.dearnessAllowance + 
                updatedEarnings.perquisites +
                updatedEarnings.others +
                updatedEarnings.bonus +
                updatedEarnings.variablePay
            );
            
            Object.assign(updateData, earningsUpdate);
        }
    }

    // --- 2. Handle Deductions & Total Deductions Calculation ---
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

    // --- 3. Handle Net Salary Calculation ---
    // If Net Salary is manually provided, use it. Otherwise, calculate it based on (Gross - Total Deductions).
    if (netSalary !== undefined) {
        updateData.netSalary = roundToTwo(Number(netSalary));
    } else if (earnings || deductions) {
        // We need the *latest* Gross and *latest* Deductions to calculate Net.
        // Check if we just calculated a new Gross in this request (in updateData), otherwise use DB value.
        const currentPayroll = await Payroll.findById(id); // Re-fetch or use existing variable logic
        
        const finalGrossSalary = updateData['earnings.grossSalary'] !== undefined 
            ? updateData['earnings.grossSalary'] 
            : currentPayroll.earnings.grossSalary;

        const finalTotalDeductions = updateData['deductions.totalDeductions'] !== undefined 
            ? updateData['deductions.totalDeductions'] 
            : currentPayroll.deductions.totalDeductions;

        // UPDATED FORMULA: Net = Gross - Total Deductions
        updateData.netSalary = roundToTwo(
            finalGrossSalary - finalTotalDeductions
        );
    }

    updateData.updatedAt = new Date();
    updateData.lastModifiedBy = req.user?._id;

    const updatedPayroll = await Payroll.findByIdAndUpdate(id, updateData, { new: true })
        .populate('employee', 'employeeId firstName lastName')
        .populate({ path: 'employee', populate: { path: 'post', select: 'title department' } });

    // [CACHE INVALIDATION]
    // 1. Clear this specific payroll record
    await removeCache(`${CACHE_KEY.PREFIX}${id}`);
    // 2. Clear lists
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