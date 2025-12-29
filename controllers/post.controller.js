import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Post } from "../models/post.model.js";
import { User } from "../models/user.model.js";

// Helper to sanitize salary and set defaults
const sanitizeSalary = (inputSalary) => {
  if (!inputSalary) return null;
  return {
    basic: inputSalary.basic,
    gross: inputSalary.gross,
    total: inputSalary.total,
    houseRentAllowance: inputSalary.houseRentAllowance || 0,
    dearnessAllowance: inputSalary.dearnessAllowance || 0,
    perquisites: inputSalary.perquisites || 0,
    others: inputSalary.others || 0,
    bonus: inputSalary.bonus || 0,
    variablePay: inputSalary.variablePay || 0,
    taxes: inputSalary.taxes || 0,
    providentFund: {
      employerContribution: inputSalary.providentFund?.employerContribution || 0,
      employeeContribution: inputSalary.providentFund?.employeeContribution || 0
    },
    esi: {
      employerContribution: inputSalary.esi?.employerContribution || 0,
      employeeContribution: inputSalary.esi?.employeeContribution || 0
    }
  };
};

const createPost = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    department,
    salary,
    workingHour,
    isHiring,
    location,
    requirements,
    shiftTimings,
    lateAttendanceMetrics,
    payrollType, // Added payrollType,
    isPfPayable
  } = req.body;

  const userId = req.auth.userId;
  
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  // VALIDATION: Location removed, PayrollType added.
  // Salary Check: Ensure mandatory fields exist.
  if (
    !title ||
    !department ||
    !payrollType ||
    !salary?.basic ||
    !salary?.total ||
    !salary?.gross
  ) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "Required fields (Title, Dept, Desc, PayrollType, Basic/Gross/Total Salary) are missing!"));
  }

  const user = await User.findOne({ userId }); // Changed to findOne

  if (!user) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized access", true));
  }

  // Construct salary object with defaults
  const finalSalary = sanitizeSalary(salary);

  const post = await Post.create({
    title,
    description,
    department,
    isPfPayable, // Added here
    salary: finalSalary,
    payrollType, // Added here
    isHiring,
    workingHour,
    location, 
    requirements,
    shiftTimings,
    lateAttendanceMetrics,
    createdBy: user._id,
  });

  return res
    .status(201)
    .json(new ApiResponse(201, post, "Post created successfully!"));
});

const getAllPosts = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  const query = {};
  if (filters.title) {
    query.title = { $regex: filters.title, $options: "i" };
  }
  if (filters.department) {
    query.department = filters.department;
  }
  if (filters.location) {
    query.location = { $regex: filters.location, $options: "i" };
  }
  if (filters.status) {
    query.status = filters.status;
  }
  if (filters.isHiring) {
    query.isHiring = filters.isHiring;
  }
  if (filters.payrollType) { // Added filter for payrollType
    query.payrollType = filters.payrollType;
  }

  const posts = await Post.find(query)
    .populate("createdBy", "fullName")
    .populate("department", "name")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalPosts = await Post.countDocuments(query);

  return res.status(200).json(new ApiResponse(200, {
    success: true,
    totalPosts,
    totalPages: Math.ceil(totalPosts / limit),
    currentPage: page,
    posts,
  }, "Post fetched successfully"));
});

const getPost = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id)
    .populate("createdBy", "fullname")
    .populate("department", "name"); // Usually good to populate department name too

  if (!post) {
    return res.status(404).json(new ApiResponse(404, {}, "Post not found!"));
  }

  return res
    .status(200)
    .json(new ApiResponse(200, post, "Post retrieved successfully!"));
});

const updatePost = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    department,
    salary,
    isHiring,
    workingHour,
    location,
    requirements,
    status,
    shiftTimings,
    lateAttendanceMetrics,
    isPfPayable,
    payrollType // Added payrollType
  } = req.body;

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const post = await Post.findById(req.params.id);

  if (!post) {
    return res.status(404).json(new ApiResponse(404, {}, "Post not found!"));
  }

  post.title = title || post.title;
  post.description = description || post.description;
  post.department = department || post.department;
  post.isPfPayable = isPfPayable !== undefined ? isPfPayable : post.isPfPayable; // boolean check fix
  
  // Update salary only if provided, applying defaults to the new object
  if (salary) {
    post.salary = sanitizeSalary(salary);
  }

  post.workingHour = workingHour || post.workingHour;
  post.location = location || post.location;
  post.requirements = requirements || post.requirements;
  post.status = status || post.status;
  post.isHiring = isHiring !== undefined ? isHiring : post.isHiring; // boolean check fix
  post.shiftTimings = shiftTimings || post.shiftTimings;
  post.lateAttendanceMetrics = lateAttendanceMetrics || post.lateAttendanceMetrics;
  post.payrollType = payrollType || post.payrollType; // Update payrollType

  await post.save();

  return res
    .status(200)
    .json(new ApiResponse(200, post, "Post updated successfully!"));
});

const approvePost = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }
  
  // Fixed: Use findOne and await
  const user = await User.findOne({ userId });
  
  // Fixed: Role check logic
  if (!user || user.role !== "Admin") {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can approve the post."));
  }

  const post = await Post.findById(req.params.id);

  if (!post) {
    return res.status(404).json(new ApiResponse(404, {}, "Post not found!"));
  }

  post.status = 'Open';
  await post.save();

  return res
    .status(200)
    .json(new ApiResponse(200, post, "Post approved successfully!"));
});

const disapprovePost = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  
  // Fixed: Use findOne and await
  const user = await User.findOne({ userId });

  // Fixed: Role check logic
  if (!user || user.role !== "Admin") {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can disapprove the post."));
  }

  const post = await Post.findById(req.params.id);

  if (!post) {
    return res.status(404).json(new ApiResponse(404, {}, "Post not found!"));
  }

  post.status = 'Closed';
  await post.save();

  return res
    .status(200)
    .json(new ApiResponse(200, post, "Post disapproved successfully!"));
});

const deletePost = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;

  const user = await User.findOne({ userId });

  if (!user || !(user.role == 'Admin' || user.role == 'HR Manager')) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized access", true));
  }

  const post = await Post.findById(req.params.id);

  if (!post) {
    return res.status(404).json(new ApiResponse(404, {}, "Post not found!"));
  }

  // Note: remove() is deprecated in newer Mongoose versions, prefer deleteOne()
  await post.deleteOne(); 

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Post deleted successfully!"));
});

export {
  createPost,
  getAllPosts,
  getPost,
  updatePost,
  approvePost,
  disapprovePost,
  deletePost,
};