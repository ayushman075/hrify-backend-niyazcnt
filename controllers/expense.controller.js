import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Expense } from "../models/expense.model.js";
import { Employee } from "../models/employee.model.js";
import { User } from "../models/user.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

const CACHE_KEY = {
  PREFIX: "expense_",
  LIST_PREFIX: "expense_list_",
};

/**
 * POST /expenses
 * Submit a new expense claim
 */
export const createExpenseClaim = asyncHandler(async (req, res) => {
  const { employeeId, month, title, items } = req.body;

  if (!employeeId || !month || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json(new ApiResponse(400, {}, "Employee ID, Month, and at least one Expense Item are required."));
  }

  const employee = await Employee.findById(employeeId);
  if (!employee) {
    return res.status(404).json(new ApiResponse(404, {}, "Employee not found."));
  }

  const expense = await Expense.create({
    employeeId,
    month,
    title,
    items
  });

  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(201).json(new ApiResponse(201, expense, "Expense claim submitted successfully."));
});

/**
 * GET /expenses
 * Get expenses with pagination and filters
 */
export const getAllExpenses = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, sort = "createdAt", order = "desc", filters = {} } = req.query;

  let parsedFilters = filters;
  if (typeof filters === 'string') {
    try { parsedFilters = JSON.parse(filters); } 
    catch (e) { return res.status(400).json(new ApiResponse(400, {}, "Invalid JSON in filters.")); }
  }

  const filterKey = JSON.stringify(parsedFilters);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;

  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, "Expenses retrieved from cache.", true));

  const query = {};
  if (parsedFilters.employeeId) query.employeeId = parsedFilters.employeeId;
  if (parsedFilters.month) query.month = parsedFilters.month;
  if (parsedFilters.status) query.status = parsedFilters.status;

  const [expenses, total] = await Promise.all([
    Expense.find(query)
      .populate('employeeId', 'firstName lastName employeeId department')
      .populate('approvedBy', 'fullName')
      .sort({ [sort]: order === "desc" ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit)),
    Expense.countDocuments(query)
  ]);

  const payload = {
    success: true,
    totalExpenses: total,
    totalPages: Math.ceil(total / limit),
    currentPage: parseInt(page),
    expenses,
  };

  await setCache(cacheKey, payload, 3600);
  return res.status(200).json(new ApiResponse(200, payload, "Expenses retrieved successfully.", true));
});

/**
 * GET /expenses/:id
 */
export const getExpenseById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.status(200).json(new ApiResponse(200, cached, "Expense retrieved from cache.", true));

  const expense = await Expense.findById(id)
    .populate('employeeId', 'firstName lastName employeeId')
    .populate('approvedBy', 'fullName');

  if (!expense) return res.status(404).json(new ApiResponse(404, {}, "Expense claim not found."));

  await setCache(cacheKey, expense, 3600);
  return res.status(200).json(new ApiResponse(200, expense, "Expense retrieved successfully.", true));
});

/**
 * PATCH /expenses/:id/process
 * Admin/HR reviews the claim: Approve or Reject
 */
export const processExpenseClaim = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, totalApprovedAmount, rejectionReason, adminComments } = req.body;
  const userId = req.auth.userId;

  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json(new ApiResponse(400, {}, "Status must be 'Approved' or 'Rejected'."));
  }

  const user = await User.findOne({ userId });
  if (!user || (user.role !== 'Admin' && user.role !== 'HR Manager')) {
    return res.status(403).json(new ApiResponse(403, {}, "Unauthorized. Only Admin or HR can process expenses."));
  }

  const expense = await Expense.findById(id);
  if (!expense) return res.status(404).json(new ApiResponse(404, {}, "Expense claim not found."));
  if (expense.status !== 'Pending') {
    return res.status(400).json(new ApiResponse(400, {}, `Cannot process. Claim is already ${expense.status}.`));
  }

  if (status === 'Approved') {
    expense.status = 'Approved';
    // If Admin doesn't specify a partial amount, assume full claimed amount is approved
    expense.totalApprovedAmount = totalApprovedAmount !== undefined ? totalApprovedAmount : expense.totalClaimedAmount;
  } else if (status === 'Rejected') {
    if (!rejectionReason) return res.status(400).json(new ApiResponse(400, {}, "Rejection reason is required."));
    expense.status = 'Rejected';
    expense.totalApprovedAmount = 0;
    expense.rejectionReason = rejectionReason;
  }

  expense.adminComments = adminComments;
  expense.approvedBy = user._id;
  expense.processedAt = new Date();

  await expense.save();

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`)
  ]);

  return res.status(200).json(new ApiResponse(200, expense, `Expense claim ${status.toLowerCase()} successfully.`));
});

/**
 * PATCH /expenses/:id/mark-reimbursed
 * Accounts marks the money as sent
 */
export const markAsReimbursed = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.auth.userId;

  const user = await User.findOne({ userId });
  if (!user || (user.role !== 'Admin' && user.role !== 'HR Manager')) { // Adjust roles to 'Accounts' if applicable
    return res.status(403).json(new ApiResponse(403, {}, "Unauthorized."));
  }

  const expense = await Expense.findById(id);
  if (!expense) return res.status(404).json(new ApiResponse(404, {}, "Expense claim not found."));
  if (expense.status !== 'Approved') {
    return res.status(400).json(new ApiResponse(400, {}, "Only Approved expenses can be marked as Reimbursed."));
  }

  expense.status = 'Reimbursed';
  expense.reimbursedAt = new Date();
  await expense.save();

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`)
  ]);

  return res.status(200).json(new ApiResponse(200, expense, "Expense marked as reimbursed."));
});

/**
 * DELETE /expenses/:id
 * Employee can delete a claim if it hasn't been processed yet
 */
export const deleteExpenseClaim = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const expense = await Expense.findById(id);
  if (!expense) return res.status(404).json(new ApiResponse(404, {}, "Expense claim not found."));

  if (expense.status !== 'Pending') {
    return res.status(400).json(new ApiResponse(400, {}, `Cannot delete a claim that is currently ${expense.status}.`));
  }

  await expense.deleteOne();

  await Promise.allSettled([
    removeCache(`${CACHE_KEY.PREFIX}${id}`),
    removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`)
  ]);

  return res.status(200).json(new ApiResponse(200, {}, "Expense claim deleted successfully."));
});