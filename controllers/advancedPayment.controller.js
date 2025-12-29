import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Employee } from '../models/employee.model.js';
import Attendance from '../models/attendance.model.js';
import { AdvancePaymentConfig } from '../models/advancedPaymentConfig.model.js';
import { AdvancePayment } from '../models/advancedPayment.model.js';
import { User } from '../models/user.model.js';
import dayjs from 'dayjs';

// --- HELPER: Validate Eligibility & Calculate Amount ---
const validateAdvanceEligibility = async (employeeId, amountRequested) => {
  // 1. Check Configuration
  const config = await AdvancePaymentConfig.findOne();
  if (!config || !config.isEnabled) {
    return { isValid: false, message: 'Advance payments are currently disabled by the administrator.', statusCode: 403 };
  }

  const employee = await Employee.findById(employeeId).populate('post');
  if (!employee) {
    return { isValid: false, message: 'Employee not found.', statusCode: 404 };
  }

  // 2. Check Service Duration
  const joiningDate = dayjs(employee.dateOfJoining || employee.joiningDate); 
  const monthsOfService = dayjs().diff(joiningDate, 'month', true); 

  if (monthsOfService < config.minServiceMonths) {
    return { 
      isValid: false, 
      message: `Not eligible: Minimum ${config.minServiceMonths} months of service required. Current: ${monthsOfService.toFixed(1)} months.`, 
      statusCode: 400 
    };
  }

  const currentMonth = dayjs().format('YYYY-MM');

  // 3. Fetch Existing Advances (Approved/Paid) for this Month
  const existingAdvances = await AdvancePayment.find({
    employeeId: employee._id,
    month: currentMonth,
    status: { $in: ['approved', 'paid'] }
  });

  // Calculate Frequency & Total Amount Taken
  const approvedAdvancesCount = existingAdvances.length;
  
  const totalAmountTaken = existingAdvances.reduce((sum, record) => sum + record.amount, 0);

  // Check Frequency Limit
  // Note: If we are approving a pending request, it isn't counted in 'existingAdvances' yet, 
  // so (approvedAdvancesCount + 1) would be the new count.
  // However, usually frequency limits apply to *how many times you can take it*.
  if (approvedAdvancesCount >= config.maxAdvanceFrequency) {
    return { 
      isValid: false, 
      message: `Limit reached: Maximum ${config.maxAdvanceFrequency} advance(s) allowed per month. You have already taken ${approvedAdvancesCount}.`, 
      statusCode: 400 
    };
  }

  // 4. Calculate Maximum Eligible Limit (Policy Cap)
  let maxPolicyLimit = 0;
  const monthlyGross = employee.post?.salary?.gross || 0;

  if (config.allowWorkingDaysOnly) {
    // Logic: (Gross / 30) * Present Days
    const attendanceRecords = await Attendance.find({
      employeeId: employee._id,
      month: currentMonth
    });

    const presentDays = attendanceRecords.reduce((total, record) => {
      if (record.punchInTime) {
        return total + (record.attendancePercentage || 100) / 100;
      }
      return total;
    }, 0);

    const dailyRate = monthlyGross / 30;
    maxPolicyLimit = dailyRate * presentDays;
  } else {
    // Logic: Percentage of Monthly Gross
    maxPolicyLimit = (monthlyGross * config.maxAdvancePercentage) / 100;
  }

  // Round Policy Limit
  maxPolicyLimit = Math.round((maxPolicyLimit + Number.EPSILON) * 100) / 100;

  // 5. Final Amount Check (Cumulative)
  const totalProjectedAmount = totalAmountTaken + amountRequested;

  if (totalProjectedAmount > maxPolicyLimit) {
    const remainingLimit = Math.max(0, maxPolicyLimit - totalAmountTaken);
    return { 
      isValid: false, 
      message: `Limit Exceeded. 
        Total Eligible: ₹${maxPolicyLimit}. 
        Already Taken: ₹${totalAmountTaken}. 
        Requesting ₹${amountRequested} would exceed the limit. 
        Remaining eligible amount: ₹${remainingLimit}.`, 
      statusCode: 400 
    };
  }

  // Success
  return { 
    isValid: true, 
    data: { employee, maxEligibleAmount: maxPolicyLimit, currentMonth } 
  };
};


// ------------------------------------------------------------------
// --- CONTROLLERS ---
// ------------------------------------------------------------------

// 1. Update Config
const updateAdvanceConfig = asyncHandler(async (req, res) => {
  const {
    maxAdvancePercentage,
    allowWorkingDaysOnly,
    isEnabled,
    minServiceMonths,
    maxAdvanceFrequency,
  } = req.body;

  const config = await AdvancePaymentConfig.findOneAndUpdate(
    {},
    {
      maxAdvancePercentage,
      allowWorkingDaysOnly,
      isEnabled,
      minServiceMonths,
      maxAdvanceFrequency,
    },
    { upsert: true, new: true }
  );

  return res.status(200).json(
    new ApiResponse(200, config, "Advance payment configuration updated", true)
  );
});

// 2. Get Config
const getAdvanceConfig = asyncHandler(async (req, res) => {
  const config = await AdvancePaymentConfig.findOne();
  return res.status(200).json(
    new ApiResponse(200, config, "Advance payment configuration retrieved", true)
  );
});

// 3. Apply for Advance
const applyForAdvance = asyncHandler(async (req, res) => {
  const { amount, reason, employeeId } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized access", false));
  }

  // Validate Eligibility (Check total of existing + new request)
  const validation = await validateAdvanceEligibility(employeeId, Number(amount));

  if (!validation.isValid) {
    return res.status(validation.statusCode).json(
      new ApiResponse(validation.statusCode, {}, validation.message, false)
    );
  }

  const { currentMonth } = validation.data;

  // Create Request
  const advancePayment = await AdvancePayment.create({
    employeeId,
    amount,
    reason,
    month: currentMonth,
    status: 'pending',
    requestedBy: userId
  });

  return res.status(201).json(
    new ApiResponse(201, advancePayment, "Advance payment request submitted successfully", true)
  );
});

// 4. Update Status (Approve/Reject)
const updateAdvanceStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, remarks } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user) {
    return res.status(401).json(new ApiResponse(401, {}, "User not found", false));
  }

  const advancePayment = await AdvancePayment.findById(id);
  if (!advancePayment) {
    return res.status(404).json(new ApiResponse(404, null, "Request not found", false));
  }

  // --- CRITICAL RE-VALIDATION ---
  // If approving, we must check if (Current Approved Total + This Request) <= Limit
  if (status === 'approved' && advancePayment.status !== 'approved') {
    // Note: The logic inside validateAdvanceEligibility sums up 'approved'/'paid' requests.
    // Since this request is currently 'pending', it won't be in that sum yet.
    // So logic works perfectly: (Sum of Approved) + (This Pending Request Amount) vs Limit.
    
    const validation = await validateAdvanceEligibility(advancePayment.employeeId, advancePayment.amount);
    
    if (!validation.isValid) {
      return res.status(validation.statusCode).json(
        new ApiResponse(validation.statusCode, {}, `Cannot Approve: ${validation.message}`, false)
      );
    }
  }

  // Proceed with update
  const updatedRequest = await AdvancePayment.findByIdAndUpdate(
    id,
    {
      status,
      remarks,
      approvedBy: user._id,
      approvedAt: status === 'approved' ? new Date() : undefined
    },
    { new: true }
  );

  return res.status(200).json(
    new ApiResponse(200, updatedRequest, `Advance payment request ${status}`, true)
  );
});

// 5. Get Single Record
const getAdvanceById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const advancePayment = await AdvancePayment.findById(id)
    .populate('employeeId', 'employeeId firstName lastName')
    .populate('approvedBy', 'firstName lastName');

  if (!advancePayment) {
    return res.status(404).json(
      new ApiResponse(404, null, "Advance payment record not found", false)
    );
  }

  return res.status(200).json(
    new ApiResponse(200, advancePayment, "Record retrieved", true)
  );
});

// 6. Get All Records (Filtered)
const getAdvanceRecords = asyncHandler(async (req, res) => {
  const {
    month,
    status,
    employeeId,
    sort = "createdAt",
    order = "desc",
    page = 1,
    limit = 10
  } = req.query;

  const query = {};
  if (month) query.month = month;
  if (status) query.status = status;
  if (employeeId) query.employeeId = employeeId;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  const advances = await AdvancePayment.find(query)
    .populate('employeeId', 'employeeId firstName lastName')
    .populate('approvedBy', 'firstName lastName')
    .sort({ [sort]: order === "asc" ? 1 : -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum);

  const total = await AdvancePayment.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(200, {
      advances,
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      total
    }, "Advance payment records retrieved", true)
  );
});

// 7. Delete Request
const deleteAdvanceRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const advancePayment = await AdvancePayment.findById(id);
  if (!advancePayment) {
    return res.status(404).json(
      new ApiResponse(404, null, "Request not found", false)
    );
  }

  if (advancePayment.status !== 'pending') {
    return res.status(400).json(
      new ApiResponse(400, null, "Only pending requests can be deleted", false)
    );
  }

  await AdvancePayment.findByIdAndDelete(id);

  return res.status(200).json(
    new ApiResponse(200, null, "Request deleted successfully", true)
  );
});

export {
  updateAdvanceConfig,
  getAdvanceConfig,
  applyForAdvance,
  updateAdvanceStatus,
  getAdvanceById,
  getAdvanceRecords,
  deleteAdvanceRequest
};