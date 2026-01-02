import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Notice } from "../models/notice.model.js";
import { User } from "../models/user.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "notice_",           // Single ID: notice_12345
  LIST_PREFIX: "notice_list_"  // Query lists
};

const createNotice = asyncHandler(async (req, res) => {
  const {
    title,
    content,
    department,
    noticeType,
    validFrom,
    validUntil,
    isActive,
    priority,
    attachments
  } = req.body;

  const userId = req.auth.userId;
  if(!userId){
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  if (!title || !content || !noticeType) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "Some required fields are empty!"));
  }

  const user = await User.findOne({userId});

  if(!user){
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized access", true));
  }

  const notice = await Notice.create({
    title,
    content,
    department,
    noticeType,
    validFrom,
    validUntil,
    isActive,
    priority,
    attachments,
    createdBy: user._id,
  });

  // [CACHE INVALIDATION] New notice added -> Lists are stale
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(201)
    .json(new ApiResponse(201, notice, "Notice created successfully!"));
});

const getAllNotices = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  // [CACHE READ] Create unique key based on all query params
  // Stringifying filters ensures distinct caches for "HR" vs "IT" notices, etc.
  const filterKey = JSON.stringify(filters);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
  
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
      return res.status(200).json(new ApiResponse(200, cachedData, "Notices fetched from Cache"));
  }

  const query = {};
  if (filters.title) {
    query.title = { $regex: filters.title, $options: "i" }; 
  }
  if (filters.department) {
    query.department = { $regex: filters.department, $options: "i" };
  }
  if (filters.noticeType) {
    query.noticeType = { $regex: filters.noticeType, $options: "i" };
  }
  if (filters.isActive !== undefined) {
    query.isActive = filters.isActive;
  }
  if (filters.priority) {
    query.priority = filters.priority;
  }
  if (filters.validFrom) {
    query.validFrom = { $gte: new Date(filters.validFrom) };
  }
  if (filters.validUntil) {
    query.validUntil = { $lte: new Date(filters.validUntil) };
  }

  const notices = await Notice.find(query)
    .populate("createdBy", "fullName")
    .populate("department", "name")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalNotices = await Notice.countDocuments(query);

  const responsePayload = {
      success: true,
      totalNotices,
      totalPages: Math.ceil(totalNotices / limit),
      currentPage: parseInt(page),
      notices,
  };

  // [CACHE WRITE] Save for 1 hour
  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(new ApiResponse(200, responsePayload, "Notices fetched successfully"));
});

const getNotice = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

  // [CACHE READ]
  const cachedNotice = await getCache(cacheKey);
  if (cachedNotice) {
      return res.status(200).json(new ApiResponse(200, cachedNotice, "Notice retrieved from Cache!"));
  }

  const notice = await Notice.findById(id)
    .populate("createdBy", "fullName")
    .populate("department", "name");

  if (!notice) {
    return res.status(404).json(new ApiResponse(404, {}, "Notice not found!"));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, notice, 3600);

  return res
    .status(200)
    .json(new ApiResponse(200, notice, "Notice retrieved successfully!"));
});

const updateNotice = asyncHandler(async (req, res) => {
  const {
    title,
    content,
    department,
    noticeType,
    validFrom,
    validUntil,
    isActive,
    priority,
    attachments
  } = req.body;

  const userId = req.auth.userId;
  if(!userId){
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({userId});
  
  if(!user){
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized access", true));
  }

  const notice = await Notice.findById(req.params.id);

  if (!notice) {
    return res.status(404).json(new ApiResponse(404, {}, "Notice not found!"));
  }

  // Check if user is admin, HR manager or the creator of the notice
  if(!(user.role === 'Admin' || user.role === 'HR Manager' || notice.createdBy.toString() === user._id.toString())){
    return res.status(403).json(new ApiResponse(403, {}, "You don't have permission to update this notice", false));
  }

  notice.title = title || notice.title;
  notice.content = content || notice.content;
  notice.department = department || notice.department;
  notice.noticeType = noticeType || notice.noticeType;
  notice.validFrom = validFrom || notice.validFrom;
  notice.validUntil = validUntil || notice.validUntil;
  notice.isActive = isActive !== undefined ? isActive : notice.isActive;
  notice.priority = priority || notice.priority;
  notice.attachments = attachments || notice.attachments;
  notice.updatedBy = user._id;
  notice.updatedAt = Date.now();

  await notice.save();

  // [CACHE INVALIDATION]
  // 1. Clear specific notice cache
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  // 2. Clear all list caches
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, notice, "Notice updated successfully!"));
});

const toggleNoticeStatus = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  if(!userId){
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({userId});
  
  if(!user || !(user.role === 'Admin' || user.role === 'HR Manager')){
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin or HR Manager can change notice status", false));
  }

  const notice = await Notice.findById(req.params.id);

  if (!notice) {
    return res.status(404).json(new ApiResponse(404, {}, "Notice not found!"));
  }

  notice.isActive = !notice.isActive;
  notice.updatedBy = user._id;
  notice.updatedAt = Date.now();
  
  await notice.save();

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, notice, `Notice ${notice.isActive ? 'activated' : 'deactivated'} successfully!`));
});

const deleteNotice = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  if(!userId){
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({userId});

  if(!user || !(user.role === 'Admin' || user.role === 'HR Manager')){
    return res.status(403).json(new ApiResponse(403, {}, "Only Admin or HR Manager can delete notices", false));
  }

  const notice = await Notice.findById(req.params.id);

  if (!notice) {
    return res.status(404).json(new ApiResponse(404, {}, "Notice not found!"));
  }

  await Notice.findByIdAndDelete(req.params.id);

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Notice deleted successfully!"));
});

export {
  createNotice,
  getAllNotices,
  getNotice,
  updateNotice,
  toggleNoticeStatus,
  deleteNotice
};