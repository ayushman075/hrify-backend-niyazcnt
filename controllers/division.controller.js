import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Department } from "../models/department.model.js";
import { Division } from "../models/division.model.js";
import { User } from "../models/user.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "div_",
  LIST_PREFIX: "div_list_"
};

const createDivision = asyncHandler(async (req, res) => {
  const { name, description, departmentId } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || user.role !== 'Admin') {
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin can create divisions", false));
  }

  if (!name || !departmentId) {
    return res.status(400).json(new ApiResponse(400, {}, "Division name and parent Department ID are required"));
  }

  // Verify parent department exists
  const parentDepartment = await Department.findById(departmentId);
  if (!parentDepartment) {
    return res.status(404).json(new ApiResponse(404, {}, "Parent Department not found"));
  }

  // Check if division already exists WITHIN the same department
  const existingDivision = await Division.findOne({ 
    name: { $regex: new RegExp(`^${name}$`, 'i') },
    department: departmentId 
  });
  
  if (existingDivision) {
    return res.status(409).json(new ApiResponse(409, {}, "Division already exists in this department"));
  }

  const division = await Division.create({
    name,
    department: departmentId,
    description,
    createdBy: user._id,
  });

  // [CACHE INVALIDATION] Clear division lists
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(201).json(new ApiResponse(201, division, "Division created successfully!"));
});

const getAllDivisions = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 100,
    sort = "name",
    order = "asc",
    search = "",
    departmentId = "" // Filter by parent department
  } = req.query;

  // [CACHE READ] Include departmentId in the cache key
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_q${search}_d${departmentId}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Divisions fetched from Cache"));
  }

  const query = {};
  if (search) {
    query.name = { $regex: search, $options: "i" };
  }
  if (departmentId) {
    query.department = departmentId;
  }

  const divisions = await Division.find(query)
    .populate("department", "name")
    .populate("createdBy", "fullName")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalDivisions = await Division.countDocuments(query);

  const responsePayload = {
    success: true,
    totalDivisions,
    totalPages: Math.ceil(totalDivisions / limit),
    currentPage: parseInt(page),
    divisions,
  };

  // [CACHE WRITE] Save result for 1 hour
  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(new ApiResponse(200, responsePayload, "Divisions fetched successfully"));
});

const getDivision = asyncHandler(async (req, res) => {
  const divisionId = req.params.id;
  const cacheKey = `${CACHE_KEY.PREFIX}${divisionId}`;

  // [CACHE READ]
  const cachedDivision = await getCache(cacheKey);
  if (cachedDivision) {
    return res.status(200).json(new ApiResponse(200, cachedDivision, "Division retrieved from Cache!"));
  }

  const division = await Division.findById(divisionId)
    .populate("department", "name")
    .populate("createdBy", "fullName");

  if (!division) {
    return res.status(404).json(new ApiResponse(404, {}, "Division not found!"));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, division, 3600);

  return res.status(200).json(new ApiResponse(200, division, "Division retrieved successfully!"));
});

const updateDivision = asyncHandler(async (req, res) => {
  const { name, description, departmentId } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || user.role !== 'Admin') {
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin can update divisions", false));
  }

  const division = await Division.findById(req.params.id);

  if (!division) {
    return res.status(404).json(new ApiResponse(404, {}, "Division not found!"));
  }

  const targetDepartmentId = departmentId || division.department;

  // If changing parent department, ensure the new one exists
  if (departmentId && departmentId.toString() !== division.department.toString()) {
    const parentDepartment = await Department.findById(departmentId);
    if (!parentDepartment) {
      return res.status(404).json(new ApiResponse(404, {}, "New Parent Department not found"));
    }
  }

  // If name or department is updating, check for duplicates in the target department
  if ((name && name !== division.name) || (departmentId && departmentId.toString() !== division.department.toString())) {
    const existingDivision = await Division.findOne({
      name: { $regex: new RegExp(`^${name || division.name}$`, 'i') },
      department: targetDepartmentId,
      _id: { $ne: division._id }
    });
    
    if (existingDivision) {
      return res.status(409).json(new ApiResponse(409, {}, "Division name already exists in this department"));
    }
  }

  division.name = name || division.name;
  division.description = description !== undefined ? description : division.description;
  division.department = targetDepartmentId;

  await division.save();

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, division, "Division updated successfully!"));
});

const deleteDivision = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;

  const user = await User.findOne({ userId });
  if (!user || user.role !== 'Admin') {
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin can delete divisions", false));
  }

  const division = await Division.findById(req.params.id);

  if (!division) {
    return res.status(404).json(new ApiResponse(404, {}, "Division not found!"));
  }

  await division.deleteOne();

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, {}, "Division deleted successfully!"));
});

export {
  createDivision,
  getAllDivisions,
  getDivision,
  updateDivision,
  deleteDivision
};