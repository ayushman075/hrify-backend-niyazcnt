import { Holiday } from "../models/holidays.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import { User } from "../models/user.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "holiday_",           // Single ID: holiday_12345
  LIST_PREFIX: "holiday_list_"  // Query lists
};

// Create a new holiday
export const createHoliday = asyncHandler(async (req, res) => {
  const { name, description, date, type } = req.body;
  const userId = req.auth.userId;

  // Validate required fields
  if (!name ||  !date  ) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Required fields are missing", false));
  }

  // Validate user authorization
  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin' || user.role === 'HR Manager')) {
    return res
      .status(403)
      .json(new ApiResponse(403, {}, "Unauthorized access", false));
  }

  // Check for duplicate holiday
  const existingHoliday = await Holiday.findOne({
    date: new Date(date),
    name: name
  });

  if (existingHoliday) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "Holiday already exists for this date", false));
  }
  const month = `${new Date(date).getFullYear()}-${String(new Date(date).getMonth() + 1).padStart(2, '0')}`;
  const holiday = new Holiday({
    name,
    description,
    date: new Date(date),
    month,
    type,
  });

  await holiday.save();

  // [CACHE INVALIDATION] New holiday -> Clear all lists (calendars need update)
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(201)
    .json(new ApiResponse(201, holiday, "Holiday created successfully", true));
});

// Update a holiday
export const updateHoliday = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, date,  type,  isActive } = req.body;
  const userId = req.auth.userId;
  
  // Validate user authorization
  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin' || user.role === 'HR Manager')) {
    return res
      .status(403)
      .json(new ApiResponse(403, {}, "Unauthorized access", false));
  }

  const holiday = await Holiday.findById(id);
  if (!holiday) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Holiday not found", false));
  }

  // Update fields if provided
  if (name) holiday.name = name;
  if (description) holiday.description = description;
  if (date) {
    holiday.date = new Date(date);
    holiday.month = `${new Date(date).getFullYear()}-${String(new Date(date).getMonth() + 1).padStart(2, '0')}`;
  }
  if (type) holiday.type = type;
  if (typeof isActive === 'boolean') holiday.isActive = isActive;

  const updatedHoliday = await holiday.save();

  // [CACHE INVALIDATION]
  // 1. Clear specific holiday cache
  await removeCache(`${CACHE_KEY.PREFIX}${id}`);
  // 2. Clear all list caches (dates/active status changed)
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, updatedHoliday, "Holiday updated successfully", true));
});

// Delete a holiday
export const deleteHoliday = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.auth.userId;

  // Validate user authorization
  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin' || user.role === 'HR Manager')) {
    return res
      .status(403)
      .json(new ApiResponse(403, {}, "Unauthorized access", false));
  }

  const holiday = await Holiday.findById(id);
  if (!holiday) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Holiday not found", false));
  }

  await Holiday.findByIdAndDelete(id);

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Holiday deleted successfully", true));
});

// Get a single holiday by ID
export const getHolidayById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

  // [CACHE READ]
  const cachedHoliday = await getCache(cacheKey);
  if (cachedHoliday) {
      return res.status(200).json(new ApiResponse(200, cachedHoliday, "Holiday retrieved from Cache", true));
  }

  const holiday = await Holiday.findById(id);
  if (!holiday) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Holiday not found", false));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, holiday, 86400); // 24 hours TTL (holidays don't change often)

  return res
    .status(200)
    .json(new ApiResponse(200, holiday, "Holiday retrieved successfully", true));
});

// Get all holidays with filters and pagination
export const getAllHolidays = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sortBy = 'date',
    sortOrder = 'asc',
    month,
    type,
    year,
    isActive
  } = req.query;

  // [CACHE READ] Unique key based on all filters
  // Stringify req.query ensures distinct caches for different months/years
  const filterKey = JSON.stringify(req.query);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}${filterKey}`;
  
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
      return res.status(200).json(new ApiResponse(200, cachedData, "Holidays retrieved from Cache", true));
  }

  const pageNumber = parseInt(page, 1);
  const pageLimit = parseInt(limit, 10);
  const sortOrderValue = sortOrder === 'desc' ? -1 : 1;

  const filterConditions = {};

  // Add optional filters
  if (month) filterConditions.month = month.split("-")[1]+"-"+month.split("-")[0];
  if (type) filterConditions.type = type;
  if (typeof isActive === 'boolean') filterConditions.isActive = isActive;
  if (year) filterConditions.observanceYear = parseInt(year, 10);

  const holidays = await Holiday.find(filterConditions)
    .skip((pageNumber - 1) * pageLimit)
    .limit(pageLimit)
    .sort({ [sortBy]: sortOrderValue });

  const totalHolidays = await Holiday.countDocuments(filterConditions);
  const totalPages = Math.ceil(totalHolidays / pageLimit);

  const responsePayload = {
      holidays,
      totalPages,
      currentPage: pageNumber,
      totalHolidays
  };

  // [CACHE WRITE] Save for 24 hours
  await setCache(cacheKey, responsePayload, 86400);

  return res.status(200).json(
    new ApiResponse(
      200,
      responsePayload,
      "Holidays retrieved successfully",
      true
    )
  );
});