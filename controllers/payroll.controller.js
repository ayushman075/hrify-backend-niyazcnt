/**
 * payroll.controller.js
 *
 * Integrated Payroll Engine: Deterministic, Bulk-Optimized, and IST-Strict.
 * Integrates: Attendance, Leaves, Holidays, Overtime, Expenses, and Advances.
 */

import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Employee } from '../models/employee.model.js';
import Attendance from '../models/attendance.model.js';
import { Leave } from '../models/leave.model.js';
import { Holiday } from '../models/holidays.model.js';
import { Overtime } from '../models/overtime.model.js';
import { Expense } from '../models/expense.model.js';
import { AdvancePayment } from '../models/advancedPayment.model.js';
import { Payroll } from '../models/payroll.model.js';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getCache, setCache, removeCache, removeCachePattern } from '../utils/cache.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

dayjs.extend(isoWeek);
dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = 'Asia/Kolkata';

// ─── Cache Keys ──────────────────────────────────────────────────────────────
const CACHE_KEY = {
  PREFIX: 'pay_',
  LIST_PREFIX: 'pay_list_',
};

// ─── Math & Date Utilities ───────────────────────────────────────────────────
const roundToTwo = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

const roundAllValues = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'number' ? roundToTwo(v) : v;
  return out;
};

const getMonthDateRange = (month) => {
  const start = dayjs.tz(month, TIMEZONE).startOf('month').startOf('day');
  const end = dayjs.tz(month, TIMEZONE).endOf('month').endOf('day');
  return { start: start.toDate(), end: end.toDate() };
};

const getWeekDateRange = (weekId) => {
  const week = parseInt(weekId.slice(0, 2), 10);
  const year = 2000 + parseInt(weekId.slice(2, 4), 10);
  const start = dayjs.tz(`${year}-01-01`, TIMEZONE).isoWeek(week).startOf('isoWeek').startOf('day');
  return { start: start.toDate(), end: start.add(6, 'day').endOf('day').toDate() };
};

// ─── CORE ENGINE: Integrated Batch Processing ────────────────────────────────
const runIntegratedPayrollBatch = async (employees, periodData, type, periodId) => {
  const { startDate, endDate, periodKey, periodValue } = periodData;
  const allEmployeeIds = employees.map((e) => e._id);

  // 1. Bulk Fetch Dependencies (O(1) DB Calls)
  let attendanceQuery = { employeeId: { $in: allEmployeeIds } };
  if (periodKey === 'week') attendanceQuery.week = periodValue;
  else if (periodKey === 'month') attendanceQuery.month = periodValue;
  else attendanceQuery.date = { $gte: startDate, $lte: endDate };

  const [
    allAttendance,
    holidayRecords,
    allOvertime,
    allExpenses,
    allAdvances
  ] = await Promise.all([
    Attendance.find(attendanceQuery).populate({
      path: 'leaveId', populate: { path: 'leaveType', model: 'LeaveConfig' },
    }),
    Holiday.find({ date: { $gte: startDate, $lte: endDate }, isActive: true }),
    Overtime.find({ employeeId: { $in: allEmployeeIds }, [periodKey]: periodValue }),
    Expense.find({ employeeId: { $in: allEmployeeIds }, month: periodValue, status: { $in: ['Approved', 'Reimbursed'] } }),
    AdvancePayment.find({ employeeId: { $in: allEmployeeIds }, month: periodValue, status: 'paid' })
  ]);

  // 2. Data Mapping for O(1) Lookups in loop
  const holidaySet = new Set(holidayRecords.map((h) => dayjs(h.date).tz(TIMEZONE).format('YYYY-MM-DD')));
  
  const empDataMap = new Map();
  allEmployeeIds.forEach(id => empDataMap.set(id.toString(), {
    attendance: [], overtime: [], expenses: [], advances: []
  }));

  allAttendance.forEach(a => empDataMap.get(a.employeeId.toString())?.attendance.push(a));
  allOvertime.forEach(o => empDataMap.get(o.employeeId.toString())?.overtime.push(o));
  allExpenses.forEach(e => empDataMap.get(e.employeeId.toString())?.expenses.push(e));
  allAdvances.forEach(ad => empDataMap.get(ad.employeeId.toString())?.advances.push(ad));

  const results = { processed: 0, failed: 0, failedRecords: [] };
  const totalDaysInPeriod = dayjs(endDate).tz(TIMEZONE).diff(dayjs(startDate).tz(TIMEZONE), 'day') + 1;

  // 3. Process Per Employee
  for (const employee of employees) {
    try {
      const eData = empDataMap.get(employee._id.toString());
      const post = employee.post;
      if (!post) throw new Error("Missing active Post/Salary configuration");

      const payrollType = post.payrollType || '';
      const areHolidaysPayable = payrollType.includes('With_Sunday_Holiday');

      // --- ATTENDANCE & LEAVE METRICS ---
    // --- ATTENDANCE & LEAVE METRICS ---
      let totalDaysPresent = 0, weeklyOffAvailed = 0, leaveDuringMonth = 0;
      let paidLeaveDays = 0, unpaidLeaves = 0, absent = 0, holidays = 0;
      let totalLateFraction = 0; // NEW: Track the total fractional days lost to lateness

      const attMap = new Map(eData.attendance.map(a => [dayjs(a.date).tz(TIMEZONE).format('YYYY-MM-DD'), a]));

      for (let i = 0; i < totalDaysInPeriod; i++) {
        const current = dayjs(startDate).tz(TIMEZONE).add(i, 'day');
        const dateStr = current.format('YYYY-MM-DD');

        if (holidaySet.has(dateStr) && areHolidaysPayable) {
          holidays++;
          continue; 
        }

        const record = attMap.get(dateStr);
        if (record) {
          if (record.isWeekOff) {
            weeklyOffAvailed++;
          } else if (record.isLeave) {
            leaveDuringMonth++;
            if (record.leaveId?.leaveType?.isPaidLeave) paidLeaveDays++;
            else unpaidLeaves++;
          } else if (record.punchInTime) {
            totalDaysPresent++; // Counted as 1 full day for gross proration
            
            // LATE PERCENTAGE CALCULATION
            const attPct = record.attendancePercentage !== undefined && record.attendancePercentage !== null ? record.attendancePercentage : 100;
            const latePct = attPct<100?100 - attPct:0;
            
            if (latePct > 0) {
              totalLateFraction += (latePct / 100); // Accumulate the fraction (e.g., 20% late = 0.20 days lost)
            }
          } else {
            absent++;
          }
        } else {
          absent++;
        }
      }


      // Calculations
      const workingDays = totalDaysInPeriod - holidays - weeklyOffAvailed;
      const lossOfPay = unpaidLeaves + absent;
      const holidaysPayableCount = areHolidaysPayable ? holidays : 0;
      const totalDaysPayable = totalDaysPresent + paidLeaveDays + weeklyOffAvailed + holidaysPayableCount;
      const totalDaysNonPayable = lossOfPay;
      const attendancePercentage = workingDays > 0 ? (totalDaysPresent / workingDays) * 100 : 0;

      // --- OVERTIME METRICS ---
      const overtimeDays = eData.overtime.length;
      const overtimeCreditsEarned = eData.overtime.reduce((sum, ot) => sum + ot.earnedCredit, 0);
      const encashedOT = eData.overtime.filter(ot => ot.status === 'Redeemed_Paid');
      const overtimeEncashedCredits = encashedOT.reduce((sum, ot) => sum + ot.earnedCredit, 0);

      // --- EARNINGS & PRORATION ---
      const prorate = (amount) => {
        const base = amount || 0;
        if (type === 'Weekly') return base * (1 / 30) * totalDaysPayable;
        return totalDaysNonPayable <= 0 ? base : base * (totalDaysPayable / totalDaysInPeriod);
      };

      const basicSalary = prorate(post.salary?.basic);
      const houseRentAllowance = prorate(post.salary?.houseRentAllowance);
      const dearnessAllowance = prorate(post.salary?.dearnessAllowance);
      const perquisites = prorate(post.salary?.perquisites);
      
      const bonus = prorate(post.salary?.bonus);
      const variablePay = prorate(post.salary?.variablePay);
      const others = prorate(post.salary?.others);

      const grossSalary = basicSalary + houseRentAllowance + dearnessAllowance + perquisites;

      // Base Gross for Daily Rate calculations (Pre-proration Monthly Gross)
      const fullGrossBase = (post.salary?.basic || 0) + (post.salary?.houseRentAllowance || 0) + (post.salary?.dearnessAllowance || 0) + (post.salary?.perquisites || 0);
      
      // Calculate exact Daily Rate based on Payroll Type
      const dailyRate = type === 'Weekly' ? (fullGrossBase / 30) : (totalDaysInPeriod > 0 ? (fullGrossBase / totalDaysInPeriod) : 0);

      // Overtime Math: Daily Rate * Encashed Credits
      const overtimePay = dailyRate * overtimeEncashedCredits;

      // LATE FINES: Daily Rate * Total Late Fraction
      const lateFines = dailyRate * totalLateFraction;

      const reimbursements = eData.expenses.reduce((sum, exp) => sum + exp.totalApprovedAmount, 0);


      // --- DEDUCTIONS ---
      const advancePayments = eData.advances.reduce((sum, adv) => sum + adv.amount, 0);

      let epfEmployee = 0, epfEmployer = 0, esiEmployee = 0, esiEmployer = 0;
      
      if (post.salary?.providentFund?.employeeContribution > 0) {
        epfEmployee = prorate(post.salary.providentFund.employeeContribution);
        epfEmployer = prorate(post.salary.providentFund.employerContribution || 0);
      } else {
        const pfBasis = Math.min(post.salary?.basic || 0, 15000);
        epfEmployee = prorate(pfBasis * 0.12);
        epfEmployer = prorate(pfBasis * 0.13);
      }

      if (post.isEsiPayable) {
        if (post.salary?.esi?.employeeContribution > 0) {
          esiEmployee = prorate(post.salary.esi.employeeContribution);
          esiEmployer = prorate(post.salary.esi.employerContribution || 0);
        } else {
          esiEmployee = grossSalary * 0.0075;
          esiEmployer = grossSalary * 0.0325;
        }
      }

      const taxes = prorate(post.salary?.taxes || 0);
      const totalDeductions = epfEmployee + esiEmployee + taxes + advancePayments + lateFines + reimbursements;

      // NET SALARY
      const netSalary = grossSalary + bonus + variablePay + others + overtimePay - totalDeductions;

      // 4. Upsert Payroll Record
      const payrollPayload = {
        employee: employee._id,
        month: type === 'Monthly' ? periodId : undefined,
        period: periodId,
        type: type,
        attendance: roundAllValues({
          totalDaysPresent, workingDays, weeklyOffAvailed, leaveDuringMonth, 
          unpaidLeaves, holidays, absent, lossOfPay, totalDaysPayable, 
          totalDaysNonPayable, attendancePercentage, overtimeDays, 
          overtimeCreditsEarned, overtimeEncashedCredits, lateDaysEquivalent: totalLateFraction
        }),
        earnings: roundAllValues({
          basicSalary, houseRentAllowance, dearnessAllowance, perquisites, 
          bonus, variablePay, others, overtimePay, reimbursements, grossSalary
        }),
        deductions: roundAllValues({
          epfEmployee, esiEmployee, taxes, advancePayments, lateFines, totalDeductions
        }),
        employerContributions: roundAllValues({
          epf: epfEmployer, esi: esiEmployer
        }),
        netSalary: roundToTwo(netSalary),
        status: 'processed',
        processedAt: new Date(),
      };

      await Payroll.findOneAndUpdate(
        { employee: employee._id, period: periodId },
        payrollPayload,
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

export const generateMonthlyPayroll = asyncHandler(async (req, res) => {
  const { month } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json(new ApiResponse(400, null, 'month is required in "YYYY-MM" format', false));

  const { start, end } = getMonthDateRange(month);

  const employees = await Employee.find({ status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] } })
    .populate({ path: 'post', match: { payrollType: { $regex: /^Monthly/i } } });
  
  const eligible = employees.filter((e) => e.post !== null);
  if (!eligible.length) return res.status(200).json(new ApiResponse(200, { processed: 0 }, 'No eligible Monthly employees found', true));

  const results = await runIntegratedPayrollBatch(eligible, { startDate: start, endDate: end, periodKey: 'month', periodValue: month }, 'Monthly', month);

  await Promise.allSettled([removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`), invalidateDashboardCache()]);
  return res.status(200).json(new ApiResponse(200, results, 'Monthly payroll processing completed', true));
});

export const generateWeeklyPayroll = asyncHandler(async (req, res) => {
  const { week } = req.body;
  if (!week || !/^\d{4}$/.test(week)) return res.status(400).json(new ApiResponse(400, null, 'week is required in "WWYY" format', false));

  const { start, end } = getWeekDateRange(week);

  const employees = await Employee.find({ status: { $in: ['Active', 'PartTime', 'Contractual', 'Probation'] } })
    .populate({ path: 'post', match: { payrollType: { $regex: /^Weekly/i } } });
  
  const eligible = employees.filter((e) => e.post !== null);
  if (!eligible.length) return res.status(200).json(new ApiResponse(200, { processed: 0 }, 'No eligible Weekly employees found', true));

  const results = await runIntegratedPayrollBatch(eligible, { startDate: start, endDate: end, periodKey: 'week', periodValue: week }, 'Weekly', week);

  await Promise.allSettled([removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`), invalidateDashboardCache()]);
  return res.status(200).json(new ApiResponse(200, results, 'Weekly payroll processing completed', true));
});

export const processEmployeePayroll = asyncHandler(async (req, res) => {
  const { employeeId, month, week } = req.body;
  if (!employeeId) return res.status(400).json(new ApiResponse(400, null, 'employeeId is required', false));

  const employee = await Employee.findById(employeeId).populate('post');
  if (!employee) return res.status(404).json(new ApiResponse(404, null, 'Employee not found', false));

  const payrollType = employee.post?.payrollType ?? '';
  let periodData, type, periodId;

  if (payrollType.startsWith('Monthly')) {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json(new ApiResponse(400, null, 'month (YYYY-MM) is required', false));
    const { start, end } = getMonthDateRange(month);
    periodData = { startDate: start, endDate: end, periodKey: 'month', periodValue: month };
    type = 'Monthly'; periodId = month;
  } else if (payrollType.startsWith('Weekly')) {
    if (!week || !/^\d{4}$/.test(week)) return res.status(400).json(new ApiResponse(400, null, 'week (WWYY) is required', false));
    const { start, end } = getWeekDateRange(week);
    periodData = { startDate: start, endDate: end, periodKey: 'week', periodValue: week };
    type = 'Weekly'; periodId = week;
  } else {
    return res.status(400).json(new ApiResponse(400, null, `Unrecognised payrollType: "${payrollType}"`, false));
  }

  const results = await runIntegratedPayrollBatch([employee], periodData, type, periodId);
  if (results.failed > 0) return res.status(500).json(new ApiResponse(500, results.failedRecords[0], 'Payroll processing failed', false));

  const payroll = await Payroll.findOne({ employee: employee._id, period: periodId });

  await Promise.allSettled([removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`), invalidateDashboardCache()]);
  return res.status(200).json(new ApiResponse(200, payroll, 'Payroll processed successfully', true));
});

export const getPayrollById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Payroll retrieved from cache', true));

  const payroll = await Payroll.findById(id).populate({
    path: 'employee',
    select: 'employeeId firstName lastName',
    populate: [
      { path: 'post', select: 'title department' },
      { path: 'site', select: 'siteName' },
    ],
  });

  if (!payroll) return res.status(404).json(new ApiResponse(404, null, 'Payroll record not found', false));

  await setCache(cacheKey, payroll, 3600);
  return res.status(200).json(new ApiResponse(200, payroll, 'Payroll retrieved successfully', true));
});

export const getFilteredPayroll = asyncHandler(async (req, res) => {
  const { month, employeeId, status, site, sort = 'createdAt', order = 'desc' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);

  const filterKey = JSON.stringify({ month, employeeId, status, site, sort, order, page, limit });
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, 'Data retrieved from cache', true));

  const query = {};
  if (month) query.period = month;
  if (status) query.status = status;

  if (site) {
    const siteEmployees = await Employee.find({ site }).select('_id');
    const siteIds = siteEmployees.map((e) => e._id);
    query.employee = (employeeId && siteIds.some(id => id.toString() === employeeId.toString())) 
      ? employeeId 
      : { $in: siteIds };
  } else if (employeeId) {
    query.employee = employeeId;
  }

  const [payrolls, total] = await Promise.all([
    Payroll.find(query)
      .populate({
        path: 'employee',
        select: 'employeeId firstName lastName status',
        populate: [
          { path: 'post', select: 'title department', populate: { path: 'department', select: 'name' } },
          { path: 'site', select: 'siteName' },
        ],
      })
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Payroll.countDocuments(query),
  ]);

  const payload = { payrolls, totalPages: Math.ceil(total / limit), currentPage: page, total };
  await setCache(cacheKey, payload, 3600);
  return res.status(200).json(new ApiResponse(200, payload, 'Payroll data retrieved successfully', true));
});

export const updatePayroll = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, earnings, deductions, employerContributions, comments } = req.body;

  const payroll = await Payroll.findById(id);
  if (!payroll) return res.status(404).json(new ApiResponse(404, null, 'Payroll record not found', false));

  if (payroll.status === 'paid') {
    return res.status(409).json(new ApiResponse(409, null, 'Cannot edit a payroll that has already been paid', false));
  }

  const updateData = {};
  if (status) updateData.status = status;
  if (comments !== undefined) updateData.comments = comments;

  let finalGross = payroll.earnings.grossSalary;
  let finalDeductions = payroll.deductions.totalDeductions;
  
  let eBonus = payroll.earnings.bonus;
  let eVarPay = payroll.earnings.variablePay;
  let eOthers = payroll.earnings.others;
  let eOvertime = payroll.earnings.overtimePay;
  let eReimburse = payroll.earnings.reimbursements;

  if (earnings) {
    const merged = {
      basicSalary: earnings.basicSalary ?? payroll.earnings.basicSalary,
      houseRentAllowance: earnings.houseRentAllowance ?? payroll.earnings.houseRentAllowance,
      dearnessAllowance: earnings.dearnessAllowance ?? payroll.earnings.dearnessAllowance,
      perquisites: earnings.perquisites ?? payroll.earnings.perquisites,
      bonus: earnings.bonus ?? payroll.earnings.bonus,
      variablePay: earnings.variablePay ?? payroll.earnings.variablePay,
      others: earnings.others ?? payroll.earnings.others,
      overtimePay: earnings.overtimePay ?? payroll.earnings.overtimePay,
      reimbursements: earnings.reimbursements ?? payroll.earnings.reimbursements,
    };

    finalGross = roundToTwo(merged.basicSalary + merged.houseRentAllowance + merged.dearnessAllowance + merged.perquisites);
    
    eBonus = merged.bonus;
    eVarPay = merged.variablePay;
    eOthers = merged.others;
    eOvertime = merged.overtimePay;
    eReimburse = merged.reimbursements;

    updateData['earnings.basicSalary'] = roundToTwo(merged.basicSalary);
    updateData['earnings.houseRentAllowance'] = roundToTwo(merged.houseRentAllowance);
    updateData['earnings.dearnessAllowance'] = roundToTwo(merged.dearnessAllowance);
    updateData['earnings.perquisites'] = roundToTwo(merged.perquisites);
    updateData['earnings.bonus'] = roundToTwo(merged.bonus);
    updateData['earnings.variablePay'] = roundToTwo(merged.variablePay);
    updateData['earnings.others'] = roundToTwo(merged.others);
    updateData['earnings.overtimePay'] = roundToTwo(merged.overtimePay);
    updateData['earnings.reimbursements'] = roundToTwo(merged.reimbursements);
    updateData['earnings.grossSalary'] = finalGross;
  }

  if (deductions) {
    const mergedDed = {
      epfEmployee: deductions.epfEmployee ?? payroll.deductions.epfEmployee,
      esiEmployee: deductions.esiEmployee ?? payroll.deductions.esiEmployee,
      taxes: deductions.taxes ?? payroll.deductions.taxes,
      advancePayments: deductions.advancePayments ?? payroll.deductions.advancePayments,
      lateFines: deductions.lateFines ?? payroll.deductions.lateFines,
    };
    
    finalDeductions = roundToTwo(mergedDed.epfEmployee + mergedDed.esiEmployee + mergedDed.taxes + mergedDed.advancePayments + mergedDed.lateFines);

    updateData['deductions.epfEmployee'] = roundToTwo(mergedDed.epfEmployee);
    updateData['deductions.esiEmployee'] = roundToTwo(mergedDed.esiEmployee);
    updateData['deductions.taxes'] = roundToTwo(mergedDed.taxes);
    updateData['deductions.advancePayments'] = roundToTwo(mergedDed.advancePayments);
    updateData['deductions.lateFines'] = roundToTwo(mergedDed.lateFines);
    updateData['deductions.totalDeductions'] = finalDeductions;
  }
  
  if (employerContributions) {
    if (employerContributions.epf !== undefined) updateData['employerContributions.epf'] = roundToTwo(Number(employerContributions.epf));
    if (employerContributions.esi !== undefined) updateData['employerContributions.esi'] = roundToTwo(Number(employerContributions.esi));
  }

  // Recalculate Net Salary automatically
  if (earnings || deductions) {
    updateData.netSalary = roundToTwo(finalGross + eBonus + eVarPay + eOthers + eOvertime + eReimburse - finalDeductions);
  }

  // Allow explicit override of Net Salary if required by admin
  if (req.body.netSalary !== undefined) {
    updateData.netSalary = roundToTwo(Number(req.body.netSalary));
  }

  updateData.lastModifiedBy = req.user?._id;

  const updatedPayroll = await Payroll.findByIdAndUpdate(id, { $set: updateData }, { new: true })
    .populate({
      path: 'employee',
      select: 'employeeId firstName lastName',
      populate: { path: 'post', select: 'title department' },
    });

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`),
    invalidateDashboardCache(),
  ]);

  return res.status(200).json(new ApiResponse(200, updatedPayroll, 'Payroll updated successfully', true));
});

export const markPayrollAsPaid = asyncHandler(async (req, res) => {
  const { period } = req.body;
  if (!period) return res.status(400).json(new ApiResponse(400, null, 'period (e.g., "YYYY-MM" or "WWYY") is required', false));

  const result = await Payroll.updateMany(
    { period, status: 'processed' },
    { $set: { status: 'paid', paidAt: new Date(), lastModifiedBy: req.user?._id } }
  );

  if (result.modifiedCount === 0) {
    return res.status(200).json(new ApiResponse(200, { modifiedCount: 0 }, 'No processed payrolls found to mark as paid', true));
  }

  await Promise.allSettled([removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`), invalidateDashboardCache()]);
  return res.status(200).json(new ApiResponse(200, { modifiedCount: result.modifiedCount }, `Successfully marked ${result.modifiedCount} payrolls as paid`, true));
});