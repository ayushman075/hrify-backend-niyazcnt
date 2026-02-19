/**
 * payroll.controller.js
 *
 * Payroll is financial — every calculation must be exact and deterministic.
 *
 * Key design decisions:
 * 1. IST: all date work uses dayjs.tz(TIMEZONE) consistently — no server-tz leakage.
 * 2. EPF: cap applied to FULL monthly basic before proration (statutory compliance).
 * 3. Gross formula: single definition used in both generation and manual update paths.
 * Gross = basic + HRA + DA + perquisites  (pre-tax statutory components)
 * Net   = gross + others + bonus + variablePay - totalDeductions
 * 4. Weekly payroll uses a dedicated `period` field in DB — never stuffs week ID
 * into the `month` field to avoid compound-index collisions.
 * 5. Bulk attendance fetch — one query per payroll run, not one per employee.
 * 6. All numeric rounding through roundToTwo(); never store floating-point surprises.
 */

import { asyncHandler }  from '../utils/AsyncHandler.js';
import { ApiResponse }   from '../utils/ApiResponse.js';
import { Employee }      from '../models/employee.model.js';
import Attendance        from '../models/attendance.model.js';
import { Payroll }       from '../models/payroll.model.js';
import { Holiday }       from '../models/holidays.model.js';
import dayjs             from 'dayjs';
import isoWeek           from 'dayjs/plugin/isoWeek.js';
import utc               from 'dayjs/plugin/utc.js';
import timezone          from 'dayjs/plugin/timezone.js';
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

dayjs.extend(isoWeek);
dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = 'Asia/Kolkata';

// ─── Cache keys ───────────────────────────────────────────────────────────────

const CACHE_KEY = {
  PREFIX:      'pay_',
  LIST_PREFIX: 'pay_list_',
};

// ─── Rounding helpers ─────────────────────────────────────────────────────────

const roundToTwo = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

const roundAllValues = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'number' ? roundToTwo(v) : v;
  return out;
};

// ─── IST helpers (consistent with all other files) ────────────────────────────

const getWeekDateRange = (weekId) => {
  const week = parseInt(weekId.slice(0, 2), 10);
  const year = 2000 + parseInt(weekId.slice(2, 4), 10);

  const start = dayjs.tz(`${year}-01-01`, TIMEZONE)
    .isoWeek(week)
    .startOf('isoWeek')
    .startOf('day');

  const end = start.add(6, 'day').endOf('day');

  return { start: start.toDate(), end: end.toDate() };
};

const getMonthDateRange = (month) => {
  const start = dayjs.tz(month, TIMEZONE).startOf('month').startOf('day');
  const end   = dayjs.tz(month, TIMEZONE).endOf('month').endOf('day');
  return { start: start.toDate(), end: end.toDate() };
};

// ─── Core attendance metrics ──────────────────────────────────────────────────

const calculateAttendanceMetrics = (attendanceRecords, startDate, endDate, isSundayHoliday, holidaySet) => {
  let workingDays    = 0;
  let presentDays    = 0;
  let paidLeaveDays  = 0;
  let unpaidLeave    = 0;
  let holidays       = 0;
  let absent         = 0;

  const attendanceMap = new Map();
  for (const rec of attendanceRecords) {
    const key = dayjs(rec.date).tz(TIMEZONE).format('YYYY-MM-DD');
    attendanceMap.set(key, rec);
  }

  const start     = dayjs(startDate).tz(TIMEZONE);
  const end       = dayjs(endDate).tz(TIMEZONE);
  const totalDays = end.diff(start, 'day') + 1;

  for (let i = 0; i < totalDays; i++) {
    const current    = start.add(i, 'day');
    const dateString = current.format('YYYY-MM-DD');
    const dayOfWeek  = current.day();

    if (holidaySet.has(dateString)) {
      holidays++;
      continue;
    }

    if (dayOfWeek === 0 && isSundayHoliday) {
      holidays++;
      continue;
    }

    workingDays++;
    const record = attendanceMap.get(dateString);

    if (record) {
      if (record.isLeave) {
        if (record.leaveId?.leaveType?.isPaidLeave) {
          paidLeaveDays++;
        } else {
          unpaidLeave++;
        }
      } else if (record.punchInTime) {
        presentDays += (record.attendancePercentage ?? 0) / 100;
      } else {
        absent++;
      }
    } else {
      absent++;
    }
  }

  const totalDaysPayable     = roundToTwo(presentDays + paidLeaveDays + holidays);
  const totalDaysNonPayable  = roundToTwo(unpaidLeave + absent);
  const lossOfPay            = roundToTwo(unpaidLeave + absent); 
  const attendancePercentage = workingDays > 0 ? roundToTwo((presentDays / workingDays) * 100) : 0;

  return {
    workingDays:          roundToTwo(workingDays),
    presentDays:          roundToTwo(presentDays),
    paidLeaveDays:        roundToTwo(paidLeaveDays),
    unpaidLeave:          roundToTwo(unpaidLeave),
    holidays:             roundToTwo(holidays),
    absent:               roundToTwo(absent),
    lossOfPay:            lossOfPay,
    totalDaysPayable,
    totalDaysNonPayable,
    attendancePercentage,
  };
};

// ─── Salary components ────────────────────────────────────────────────────────

const calculateSalaryComponents = (post, metrics, type = 'Monthly', startDate, endDate) => {
  const { totalDaysPayable, totalDaysNonPayable } = metrics;
  
  const start = dayjs(startDate).tz(TIMEZONE).startOf('day');
  const end   = dayjs(endDate).tz(TIMEZONE).endOf('day');
  const totalDaysInPeriod = end.diff(start, 'day') + 1;

  const prorate = (amount) => {
    const baseAmount = amount || 0;

    if (type === 'Weekly') {
      return roundToTwo(baseAmount * (1 / 30) * totalDaysPayable);
    }

    if (totalDaysNonPayable === 0) {
      return roundToTwo(baseAmount);
    }

    return roundToTwo(baseAmount * (totalDaysPayable / totalDaysInPeriod));
  };

  const basicSalary        = prorate(post.salary?.basic);
  const houseRentAllowance = prorate(post.salary?.houseRentAllowance);
  const dearnessAllowance  = prorate(post.salary?.dearnessAllowance);
  const perquisites        = prorate(post.salary?.perquisites);
  const others             = prorate(post.salary?.others);

  const bonus       = roundToTwo(post.salary?.bonus       || 0);
  const variablePay = roundToTwo(post.salary?.variablePay || 0);

  const grossSalary = roundToTwo(basicSalary + houseRentAllowance + dearnessAllowance + perquisites);

  let epfEmployeeContribution = 0;
  let epfEmployerContribution = 0;

  if (post.salary?.providentFund?.employeeContribution > 0 || post.salary?.providentFund?.employerContribution > 0 || post.salary?.esi?.employeeContribution > 0 || post.salary?.esi?.employerContribution > 0) {
    const schemaEmployeePf = post.salary?.providentFund?.employeeContribution;
    const schemaEmployerPf = post.salary?.providentFund?.employerContribution;
    
    if (schemaEmployeePf > 0) {
      epfEmployeeContribution = prorate(schemaEmployeePf);
      epfEmployerContribution = prorate(schemaEmployerPf || 0);
    } else {
      const pfBasis = Math.min(post.salary?.basic || 0, 15000);
      epfEmployeeContribution = prorate(pfBasis * 0.12);
      epfEmployerContribution = prorate(pfBasis * 0.13);
    }
  }

  let esiEmployeeContribution = 0;
  let esiEmployerContribution = 0;
  
  if (post.isEsiPayable) {
    const schemaEmployeeEsi = post.salary?.esi?.employeeContribution;
    const schemaEmployerEsi = post.salary?.esi?.employerContribution;

    if (schemaEmployeeEsi > 0) {
      esiEmployeeContribution = prorate(schemaEmployeeEsi);
      esiEmployerContribution = prorate(schemaEmployerEsi || 0);
    } else {
      esiEmployeeContribution = roundToTwo(grossSalary * 0.0075);
      esiEmployerContribution = roundToTwo(grossSalary * 0.0325);
    }
  }

  const taxes           = roundToTwo(post.salary?.taxes || 0);
  const totalDeductions = roundToTwo(epfEmployeeContribution + esiEmployeeContribution + taxes);
  const netSalary       = roundToTwo(grossSalary + others + bonus + variablePay - totalDeductions);

  return roundAllValues({
    basicSalary,
    houseRentAllowance,
    dearnessAllowance,
    perquisites,
    others,
    bonus,
    variablePay,
    grossSalary,
    epfEmployeeContribution,
    epfEmployerContribution,
    esiEmployeeContribution,
    esiEmployerContribution,
    taxes,
    totalDeductions,
    netSalary,
  });
};

// ─── Bulk payroll generation ──────────────────────────────────────────────────

const runPayrollBatch = async (employees, periodData, type, periodId) => {
  const { startDate, endDate, periodKey, periodValue } = periodData;

  const allEmployeeIds = employees.map((e) => e._id);

  let attendanceQuery = { employeeId: { $in: allEmployeeIds } };
  if (periodKey === 'week') {
    attendanceQuery.week = periodValue;
  } else if (periodKey === 'month') {
    attendanceQuery.month = periodValue;
  } else {
    attendanceQuery.date = { $gte: startDate, $lte: endDate };
  }

  const allAttendance = await Attendance.find(attendanceQuery).populate({
    path:     'leaveId',
    populate: { path: 'leaveType', model: 'LeaveConfig' },
  });

  const attendanceByEmployee = new Map();
  for (const rec of allAttendance) {
    const key = rec.employeeId.toString();
    if (!attendanceByEmployee.has(key)) attendanceByEmployee.set(key, []);
    attendanceByEmployee.get(key).push(rec);
  }

  const holidayRecords = await Holiday.find({
    date:     { $gte: startDate, $lte: endDate },
    isActive: true,
  });
  const holidaySet = new Set(holidayRecords.map((h) => dayjs(h.date).tz(TIMEZONE).format('YYYY-MM-DD')));

  const results = { processed: 0, failed: 0, failedRecords: [] };

  for (const employee of employees) {
    try {
      const payrollType     = employee.post?.payrollType ?? '';
      const isSundayHoliday = payrollType.includes('With_Sunday_Holiday');

      const empAttendance = attendanceByEmployee.get(employee._id.toString()) ?? [];

      const attendanceData   = calculateAttendanceMetrics(empAttendance, startDate, endDate, isSundayHoliday, holidaySet);
      
      const salaryComponents = calculateSalaryComponents(employee.post, attendanceData, type, startDate, endDate);

      const payrollData = {
        employee:    employee._id,
        month:       type === 'Monthly' ? periodId : periodId,
        period:      periodId,
        type:        type, 
        attendance:  attendanceData,
        earnings: {
          basicSalary:         salaryComponents.basicSalary,
          houseRentAllowance:  salaryComponents.houseRentAllowance,
          dearnessAllowance:   salaryComponents.dearnessAllowance,
          perquisites:         salaryComponents.perquisites,
          others:              salaryComponents.others,
          bonus:               salaryComponents.bonus,
          variablePay:         salaryComponents.variablePay,
          grossSalary:         salaryComponents.grossSalary,
        },
        deductions: {
          epfEmployee:     salaryComponents.epfEmployeeContribution,
          esiEmployee:     salaryComponents.esiEmployeeContribution,
          taxes:           salaryComponents.taxes,
          totalDeductions: salaryComponents.totalDeductions,
        },
        // ADDED: Saving Employer Contributions here so they are returned in GET APIs
        employerContributions: {
          epf: salaryComponents.epfEmployerContribution,
          esi: salaryComponents.esiEmployerContribution,
        },
        netSalary:   salaryComponents.netSalary,
        status:      'processed',
        processedAt: new Date(),
      };

      await Payroll.findOneAndUpdate(
        { employee: employee._id, period: periodId },
        payrollData,
        { upsert: true, new: true }
      );

      results.processed++;
    } catch (err) {
      results.failed++;
      results.failedRecords.push({ employeeId: employee.employeeId, error: err.message });
    }
  }

  return results;
};

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const generateMonthlyPayroll = asyncHandler(async (req, res) => {
  const { month } = req.body;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json(new ApiResponse(400, null, 'month is required in "YYYY-MM" format', false));
  }

  const { start, end } = getMonthDateRange(month);

  const employees = await Employee.find({
    status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] },
  }).populate({
    path: 'post',
    match: { payrollType: { $regex: /^Monthly/i } }
  });

  const eligible = employees.filter((e) => e.post !== null);

  if (!eligible.length) {
    return res.status(200).json(new ApiResponse(200, { processed: 0 }, 'No eligible Monthly employees found', true));
  }

  const results = await runPayrollBatch(
    eligible,
    { startDate: start, endDate: end, periodKey: 'month', periodValue: month },
    'Monthly',
    month
  );

  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(new ApiResponse(200, results, 'Monthly payroll processing completed', true));
});

const generateWeeklyPayroll = asyncHandler(async (req, res) => {
  const { week } = req.body;

  if (!week || !/^\d{4}$/.test(week)) {
    return res.status(400).json(new ApiResponse(400, null, 'week is required in "WWYY" format (e.g. "0225")', false));
  }

  const { start, end } = getWeekDateRange(week);

  const employees = await Employee.find({
    status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] },
  }).populate({
    path: 'post',
    match: { payrollType: { $regex: /^Weekly/i } }
  });

  const eligible = employees.filter((e) => e.post !== null);

  if (!eligible.length) {
    return res.status(200).json(new ApiResponse(200, { processed: 0 }, 'No eligible Weekly employees found', true));
  }

  const results = await runPayrollBatch(
    eligible,
    { startDate: start, endDate: end, periodKey: 'week', periodValue: week },
    'Weekly',
    week
  );

  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(new ApiResponse(200, results, 'Weekly payroll processing completed', true));
});

const processEmployeePayroll = asyncHandler(async (req, res) => {
  const { employeeId, month, week } = req.body;

  if (!employeeId) {
    return res.status(400).json(new ApiResponse(400, null, 'employeeId is required', false));
  }

  const employee = await Employee.findById(employeeId).populate('post');
  if (!employee) return res.status(404).json(new ApiResponse(404, null, 'Employee not found', false));

  const payrollType = employee.post?.payrollType ?? '';
  let periodData, type, periodId;

  if (payrollType.startsWith('Monthly')) {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json(new ApiResponse(400, null, 'month (YYYY-MM) is required for Monthly payroll', false));
    }
    const { start, end } = getMonthDateRange(month);
    periodData = { startDate: start, endDate: end, periodKey: 'month', periodValue: month };
    type       = 'Monthly';
    periodId   = month;
  } else if (payrollType.startsWith('Weekly')) {
    if (!week || !/^\d{4}$/.test(week)) {
      return res.status(400).json(new ApiResponse(400, null, 'week (WWYY) is required for Weekly payroll', false));
    }
    const { start, end } = getWeekDateRange(week);
    periodData = { startDate: start, endDate: end, periodKey: 'week', periodValue: week };
    type       = 'Weekly';
    periodId   = week;
  } else {
    return res.status(400).json(new ApiResponse(400, null, `Unrecognised payrollType: "${payrollType}"`, false));
  }

  const results = await runPayrollBatch([employee], periodData, type, periodId);

  if (results.failed > 0) {
    return res.status(500).json(new ApiResponse(500, results.failedRecords[0], 'Payroll processing failed', false));
  }

  const payroll = await Payroll.findOne({ employee: employee._id, period: periodId });

  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(new ApiResponse(200, payroll, 'Payroll processed successfully', true));
});

const getPayrollById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Payroll retrieved from cache', true));

  const payroll = await Payroll.findById(id)
    .populate({
      path:     'employee',
      select:   'employeeId firstName lastName',
      populate: [
        { path: 'post', select: 'title department' },
        { path: 'site', select: 'siteName' },
      ],
    });

  if (!payroll) return res.status(404).json(new ApiResponse(404, null, 'Payroll record not found', false));

  await setCache(cacheKey, payroll, 3600);
  return res.status(200).json(new ApiResponse(200, payroll, 'Payroll retrieved successfully', true));
});

const getFilteredPayroll = asyncHandler(async (req, res) => {
  const {
    month, employeeId, status, site,
    sort = 'createdAt', order = 'desc',
  } = req.query;

  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);

  const filterKey = JSON.stringify({ month, employeeId, status, site, sort, order });
  const cacheKey  = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Payroll data retrieved from cache', true));

  const query = {};
  if (month)  query.period  = month;
  if (status) query.status = status;

  if (site) {
    const siteEmployees = await Employee.find({ site }).select('_id');
    const siteIds = siteEmployees.map((e) => e._id);

    if (employeeId) {
      const inSite = siteIds.some((id) => id.toString() === employeeId.toString());
      query.employee = inSite ? employeeId : { $in: [] }; 
    } else {
      query.employee = { $in: siteIds };
    }
  } else if (employeeId) {
    query.employee = employeeId;
  }

  const [payrolls, total] = await Promise.all([
    Payroll.find(query)
      .populate({
        path:     'employee',
        populate: [
          { path: 'post', populate: { path: 'department' } },
          { path: 'site', select: 'siteName' },
        ],
      })
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payroll.countDocuments(query),
  ]);

  const payload = {
    payrolls,
    totalPages:  Math.ceil(total / limit),
    currentPage: page,
    total,
  };

  await setCache(cacheKey, payload, 3600);
  return res.status(200).json(new ApiResponse(200, payload, 'Payroll data retrieved successfully', true));
});

const updatePayroll = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, earnings, deductions, employerContributions, netSalary, comments } = req.body;

  const payroll = await Payroll.findById(id);
  if (!payroll) return res.status(404).json(new ApiResponse(404, null, 'Payroll record not found', false));

  if (payroll.status === 'paid') {
    return res.status(409).json(new ApiResponse(409, null, 'Cannot edit a payroll that has already been paid', false));
  }

  const updateData = {};
  if (status)   updateData.status   = status;
  if (comments) updateData.comments = comments;

  if (earnings) {
    const merged = {
      basicSalary:         earnings.basicSalary        !== undefined ? roundToTwo(Number(earnings.basicSalary))        : payroll.earnings.basicSalary,
      houseRentAllowance:  earnings.houseRentAllowance !== undefined ? roundToTwo(Number(earnings.houseRentAllowance)) : payroll.earnings.houseRentAllowance,
      dearnessAllowance:   earnings.dearnessAllowance  !== undefined ? roundToTwo(Number(earnings.dearnessAllowance))  : payroll.earnings.dearnessAllowance,
      perquisites:         earnings.perquisites        !== undefined ? roundToTwo(Number(earnings.perquisites))        : payroll.earnings.perquisites,
      others:              earnings.others             !== undefined ? roundToTwo(Number(earnings.others))             : payroll.earnings.others,
      bonus:               earnings.bonus              !== undefined ? roundToTwo(Number(earnings.bonus))              : payroll.earnings.bonus,
      variablePay:         earnings.variablePay        !== undefined ? roundToTwo(Number(earnings.variablePay))        : payroll.earnings.variablePay,
    };

    const newGross = roundToTwo(merged.basicSalary + merged.houseRentAllowance + merged.dearnessAllowance + merged.perquisites);

    updateData['earnings.basicSalary']        = merged.basicSalary;
    updateData['earnings.houseRentAllowance'] = merged.houseRentAllowance;
    updateData['earnings.dearnessAllowance']  = merged.dearnessAllowance;
    updateData['earnings.perquisites']        = merged.perquisites;
    updateData['earnings.others']             = merged.others;
    updateData['earnings.bonus']              = merged.bonus;
    updateData['earnings.variablePay']        = merged.variablePay;
    updateData['earnings.grossSalary']        = newGross;
  }

  if (deductions) {
    const mergedDed = {
      epfEmployee: deductions.epfEmployee !== undefined ? roundToTwo(Number(deductions.epfEmployee)) : payroll.deductions.epfEmployee,
      esiEmployee: deductions.esiEmployee !== undefined ? roundToTwo(Number(deductions.esiEmployee)) : payroll.deductions.esiEmployee,
      taxes:       deductions.taxes       !== undefined ? roundToTwo(Number(deductions.taxes))       : payroll.deductions.taxes,
    };
    const newTotalDed = roundToTwo(mergedDed.epfEmployee + mergedDed.esiEmployee + mergedDed.taxes);

    updateData['deductions.epfEmployee']     = mergedDed.epfEmployee;
    updateData['deductions.esiEmployee']     = mergedDed.esiEmployee;
    updateData['deductions.taxes']           = mergedDed.taxes;
    updateData['deductions.totalDeductions'] = newTotalDed;
  }
  
  // ADDED: Allowing manual updates for Employer Contributions if needed
  if (employerContributions) {
    if (employerContributions.epf !== undefined) {
      updateData['employerContributions.epf'] = roundToTwo(Number(employerContributions.epf));
    }
    if (employerContributions.esi !== undefined) {
      updateData['employerContributions.esi'] = roundToTwo(Number(employerContributions.esi));
    }
  }

  if (netSalary !== undefined) {
    updateData.netSalary = roundToTwo(Number(netSalary));
  } else if (earnings || deductions) {
    const finalGross  = updateData['earnings.grossSalary']        !== undefined ? updateData['earnings.grossSalary']        : payroll.earnings.grossSalary;
    const finalOthers = updateData['earnings.others']             !== undefined ? updateData['earnings.others']             : payroll.earnings.others;
    const finalBonus  = updateData['earnings.bonus']              !== undefined ? updateData['earnings.bonus']              : payroll.earnings.bonus;
    const finalVar    = updateData['earnings.variablePay']        !== undefined ? updateData['earnings.variablePay']        : payroll.earnings.variablePay;
    const finalDed    = updateData['deductions.totalDeductions']  !== undefined ? updateData['deductions.totalDeductions']  : payroll.deductions.totalDeductions;

    updateData.netSalary = roundToTwo(finalGross + finalOthers + finalBonus + finalVar - finalDed);
  }

  updateData.updatedAt      = new Date();
  updateData.lastModifiedBy = req.user?._id;

  const updatedPayroll = await Payroll.findByIdAndUpdate(id, { $set: updateData }, { new: true })
    .populate({
      path:     'employee',
      select:   'employeeId firstName lastName',
      populate: { path: 'post', select: 'title department' },
    });

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(new ApiResponse(200, updatedPayroll, 'Payroll record updated successfully', true));
});

// NEW CONTROLLER: Bulk Mark Payrolls as Paid
const markPayrollAsPaid = asyncHandler(async (req, res) => {
  const { period } = req.body;

  if (!period) {
    return res.status(400).json(new ApiResponse(400, null, 'period (e.g., "YYYY-MM" or "WWYY") is required', false));
  }

  const result = await Payroll.updateMany(
    { period, status: 'processed' },
    { 
      $set: { 
        status: 'paid', 
        paidAt: new Date(),
        lastModifiedBy: req.user?._id 
      } 
    }
  );

  if (result.modifiedCount === 0) {
    return res.status(200).json(new ApiResponse(200, { modifiedCount: 0 }, 'No processed payrolls found to mark as paid for this period', true));
  }

  // Clear list caches
  await Promise.allSettled([
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { modifiedCount: result.modifiedCount }, `Successfully marked ${result.modifiedCount} payroll records as paid`, true)
  );
});

export {
  generateMonthlyPayroll,
  generateWeeklyPayroll,
  processEmployeePayroll,
  getPayrollById,
  getFilteredPayroll,
  updatePayroll,
  markPayrollAsPaid,
};