import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Candidate } from "../models/candidate.model.js";
import { uploadFileOnCloudinary } from "../utils/cloudinary.js";
import fs from 'fs';
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "candidate_",         // For single items: candidate_12345
  LIST_PREFIX: "candidate_list_" // For query lists: candidate_list_page1_...
};

const createCandidate = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    contactNo,
    post,
    applicationStatus,
    applicationDate,
    interviewDate,
    appointmentDate,
    resumeUrl,
  } = req.body;

  if (!name || !email || !contactNo || !post) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "Some required fields are empty!"));
  }

  const candidate = await Candidate.create({
    name,
    email,
    contactNo,
    post,
    applicationDate,
    applicationStatus,
    interviewDate,
    appointmentDate,
    resumeUrl
  });

  // [CACHE INVALIDATION] New candidate added -> All lists are potentially stale
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(201)
    .json(new ApiResponse(201, candidate, "Candidate created successfully!"));
});

const getAllCandidates = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  // [CACHE READ] Unique key based on all query params including filters
  const filterKey = JSON.stringify(filters);
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;

  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    return res.status(200).json(new ApiResponse(200, cachedData, "Candidates retrieved from Cache!", true));
  }

  const query = {};

  // Apply filters
  if (filters.name) {
    query.name = { $regex: filters.name, $options: "i" };
  }
  if (filters.email) {
    query.email = { $regex: filters.email, $options: "i" };
  }
  if (filters.contact) {
    query.contact = { $regex: filters.contact, $options: "i" };
  }
  if (filters.applicationStatus) {
    query.applicationStatus = filters.applicationStatus;
  }
  if (filters.post) {
    query.post = filters.post;
  }

  // Fetch candidates
  const candidates = await Candidate.find(query)
    .populate("post", "title")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalCandidates = await Candidate.countDocuments(query);

  const responsePayload = {
    success: true,
    totalCandidates,
    totalPages: Math.ceil(totalCandidates / limit),
    currentPage: parseInt(page),
    candidates,
  };

  // [CACHE WRITE] Save for 1 hour
  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(new ApiResponse(200, responsePayload, "Candidates retrieved successfully!", true));
});

const getCandidate = asyncHandler(async (req, res) => {
  const candidateId = req.params.id;
  const cacheKey = `${CACHE_KEY.PREFIX}${candidateId}`;

  // [CACHE READ]
  const cachedCandidate = await getCache(cacheKey);
  if (cachedCandidate) {
    return res.status(200).json(new ApiResponse(200, cachedCandidate, "Candidate retrieved from Cache!"));
  }

  const candidate = await Candidate.findById(candidateId)
    .populate("post", "title");

  if (!candidate) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Candidate not found!"));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, candidate, 3600);

  return res
    .status(200)
    .json(new ApiResponse(200, candidate, "Candidate retrieved successfully!"));
});

const getLatestCandidateId = asyncHandler(async (req, res) => {
  // NOTE: We do NOT cache this. It requires realtime accuracy to prevent duplicate IDs.
  const latestCandidate = await Candidate.findOne().sort({ candidateId: -1 });

  const latestId = latestCandidate ? latestCandidate.candidateId : null;

  return res.status(200).json(
    new ApiResponse(200, { candidateId: latestId }, "Latest Candidate ID retrieved successfully!")
  );
});

const uploadResume = asyncHandler(async (req, res) => {
  // NOTE: No caching needed for file uploads
  const imageLocalPath = req.file?.path;

  let images;

  if (imageLocalPath) {
    const imgUrl = await uploadFileOnCloudinary(imageLocalPath);
    images = imgUrl;
    fs.unlinkSync(imageLocalPath);
  }
  if (!imageLocalPath) {
    return res.status(200).json(
      new ApiResponse(200, { resumeUrl: images }, "Resume not selected!")
    );
  }

  return res.status(200).json(
    new ApiResponse(200, { resumeUrl: images }, "Resume uploaded successfully!")
  );
});

const updateCandidate = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    contactNo,
    appliedPost,
    applicationStatus,
    applicationDate,
    interviewDate,
    appointmentDate,
    resumeUrl,
  } = req.body;

  const candidate = await Candidate.findById(req.params.id);

  if (!candidate) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Candidate not found!"));
  }

  candidate.name = name || candidate.name;
  candidate.email = email || candidate.email;
  candidate.contactNo = contactNo || candidate.contactNo;
  candidate.appliedPost = appliedPost || candidate.appliedPost;
  candidate.applicationStatus = applicationStatus || candidate.applicationStatus;
  candidate.applicationDate = applicationDate || candidate.applicationDate;
  candidate.interviewDate = interviewDate || candidate.interviewDate;
  candidate.appointmentDate = appointmentDate || candidate.appointmentDate;
  candidate.resumeUrl = resumeUrl || candidate.resumeUrl;

  await candidate.save();

  // [CACHE INVALIDATION]
  // 1. Clear specific candidate cache
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  // 2. Clear all lists (filtering/sorting might have changed)
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, candidate, "Candidate updated successfully!"));
});

const deleteCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findByIdAndDelete(req.params.id);

  if (!candidate) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Candidate not found!"));
  }

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Candidate deleted successfully!"));
});

export {
  createCandidate,
  getAllCandidates,
  getCandidate,
  getLatestCandidateId,
  updateCandidate,
  deleteCandidate,
  uploadResume
};