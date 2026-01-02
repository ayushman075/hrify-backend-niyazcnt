import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Department } from "../models/department.model.js";
import { User } from "../models/user.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "dept_",
  LIST_PREFIX: "dept_list_"
};

const createDepartment = asyncHandler(async (req, res) => {
  const { name, description } = req.body;

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user) {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can create departments", false));
  }

  if (!name) {
    return res.status(409).json(new ApiResponse(409, {}, "Department name is required"));
  }

  // Check if department already exists
  const existingDepartment = await Department.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
  if (existingDepartment) {
    return res.status(409).json(new ApiResponse(409, {}, "Department already exists"));
  }

  const department = await Department.create({
    name,
    description,
    createdBy: user._id,
  });

  // [CACHE INVALIDATION] New data added, clear all lists
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(201).json(new ApiResponse(201, department, "Department created successfully!"));
});

const getAllDepartments = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 100,
    sort = "name",
    order = "asc",
    search = ""
  } = req.query;

  // [CACHE READ] Create a unique key based on query parameters
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_q${search}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Departments fetched from Cache"));
  }

  const query = {};
  if (search) {
    query.name = { $regex: search, $options: "i" };
  }

  const departments = await Department.find(query)
    .populate("createdBy", "fullName")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalDepartments = await Department.countDocuments(query);

  const responsePayload = {
    success: true,
    totalDepartments,
    totalPages: Math.ceil(totalDepartments / limit),
    currentPage: parseInt(page),
    departments,
  };

  // [CACHE WRITE] Save result for 1 hour
  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(new ApiResponse(200, responsePayload, "Departments fetched successfully"));
});

const getDepartment = asyncHandler(async (req, res) => {
  const departmentId = req.params.id;
  const cacheKey = `${CACHE_KEY.PREFIX}${departmentId}`;

  // [CACHE READ]
  const cachedDepartment = await getCache(cacheKey);
  if (cachedDepartment) {
    return res.status(200).json(new ApiResponse(200, cachedDepartment, "Department retrieved from Cache!"));
  }

  const department = await Department.findById(departmentId)
    .populate("createdBy", "fullName");

  if (!department) {
    return res.status(404).json(new ApiResponse(404, {}, "Department not found!"));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, department, 3600);

  return res.status(200).json(new ApiResponse(200, department, "Department retrieved successfully!"));
});

const updateDepartment = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin')) {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can update departments", false));
  }

  const department = await Department.findById(req.params.id);

  if (!department) {
    return res.status(404).json(new ApiResponse(404, {}, "Department not found!"));
  }

  // If name is being updated, check for duplicates
  if (name && name !== department.name) {
    const existingDepartment = await Department.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      _id: { $ne: department._id }
    });
    if (existingDepartment) {
      return res.status(409).json(new ApiResponse(409, {}, "Department name already exists"));
    }
  }

  department.name = name || department.name;
  department.description = description || department.description;

  await department.save();

  // [CACHE INVALIDATION]
  // 1. Remove the specific department cache (so next fetch gets new data)
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  // 2. Remove list caches (because names/descriptions changed, affecting search/lists)
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, department, "Department updated successfully!"));
});

const deleteDepartment = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;

  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin')) {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can delete departments", false));
  }

  const department = await Department.findById(req.params.id);

  if (!department) {
    return res.status(404).json(new ApiResponse(404, {}, "Department not found!"));
  }

  await department.deleteOne();

  // [CACHE INVALIDATION]
  // 1. Remove the specific department cache
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  // 2. Remove list caches (because total count changed)
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, {}, "Department deleted successfully!"));
});

export {
  createDepartment,
  getAllDepartments,
  getDepartment,
  updateDepartment,
  deleteDepartment
};