import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Department } from "../models/department.model.js";
import { User } from "../models/user.model.js";

const createDepartment = asyncHandler(async (req, res) => {
  const { name, description } = req.body;

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user ) {
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

  return res.status(200).json(new ApiResponse(200, {
    success: true,
    totalDepartments,
    totalPages: Math.ceil(totalDepartments / limit),
    currentPage: parseInt(page),
    departments,
  }, "Departments fetched successfully"));
});

const getDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findById(req.params.id)
    .populate("createdBy", "fullName");

  if (!department) {
    return res.status(404).json(new ApiResponse(404, {}, "Department not found!"));
  }

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

  return res.status(200).json(new ApiResponse(200, {}, "Department deleted successfully!"));
});

export {
  createDepartment,
  getAllDepartments,
  getDepartment,
  updateDepartment,
  deleteDepartment
};