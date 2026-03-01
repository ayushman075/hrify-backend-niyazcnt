import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Site } from "../models/site.model.js";
import { User } from "../models/user.model.js";
import {
  getCache,
  setCache,
  removeCache,
  removeCachePattern,
} from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "site_",
  LIST_PREFIX: "site_list_",
};

/*
 * CREATE SITE
*/

const createSite = asyncHandler(async (req, res) => {
  const { siteName, location, alisas } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || user.role !== "Admin") {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Only Admin can create sites", false));
  }

  if (!siteName) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "Site name is required"));
  }

  const existingSite = await Site.findOne({
    siteName: { $regex: new RegExp(`^${siteName}$`, "i") },
  });

  if (existingSite) {
    return res
      .status(409)
      .json(new ApiResponse(409, {}, "Site already exists"));
  }

  const site = await Site.create({
    siteName,
    location,
    alisas,
  });

  // Invalidate site lists
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(201)
    .json(new ApiResponse(201, site, "Site created successfully!"));
});

/**
 * GET ALL SITES
 */
const getAllSites = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 100,
    sort = "siteName",
    order = "asc",
    search = "",
  } = req.query;

  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_q${search}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
    return res
      .status(200)
      .json(new ApiResponse(200, cachedData, "Sites fetched from Cache"));
  }

  const query = {};
  if (search) {
    query.siteName = { $regex: search, $options: "i" };
  }

  const sites = await Site.find(query)
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalSites = await Site.countDocuments(query);

  const responsePayload = {
    success: true,
    totalSites,
    totalPages: Math.ceil(totalSites / limit),
    currentPage: parseInt(page),
    sites,
  };

  await setCache(cacheKey, responsePayload, 3600);

  return res
    .status(200)
    .json(new ApiResponse(200, responsePayload, "Sites fetched successfully"));
});

/**
 * GET SINGLE SITE
 */
const getSite = asyncHandler(async (req, res) => {
  const siteId = req.params.id;
  const cacheKey = `${CACHE_KEY.PREFIX}${siteId}`;

  const cachedSite = await getCache(cacheKey);
  if (cachedSite) {
    return res
      .status(200)
      .json(new ApiResponse(200, cachedSite, "Site retrieved from Cache"));
  }

  const site = await Site.findById(siteId);

  if (!site) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Site not found"));
  }

  await setCache(cacheKey, site, 3600);

  return res
    .status(200)
    .json(new ApiResponse(200, site, "Site retrieved successfully"));
});

/**
 * UPDATE SITE
 */
const updateSite = asyncHandler(async (req, res) => {
  const { siteName, location, alisas } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || user.role !== "Admin") {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Only Admin can update sites", false));
  }

  const site = await Site.findById(req.params.id);
  if (!site) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Site not found"));
  }

  if (siteName && siteName !== site.siteName) {
    const existingSite = await Site.findOne({
      siteName: { $regex: new RegExp(`^${siteName}$`, "i") },
      _id: { $ne: site._id },
    });

    if (existingSite) {
      return res
        .status(409)
        .json(new ApiResponse(409, {}, "Site name already exists"));
    }
  }

  site.siteName = siteName || site.siteName;
  site.location = location || site.location;
  site.alisas = alisas || site.alisas;

  await site.save();

  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, site, "Site updated successfully"));
});

/**
 * DELETE SITE
 */
const deleteSite = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;

  const user = await User.findOne({ userId });
  if (!user || user.role !== "Admin") {
    return res
      .status(401)
      .json(new ApiResponse(401, {}, "Only Admin can delete sites", false));
  }

  const site = await Site.findById(req.params.id);
  if (!site) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Site not found"));
  }

  await site.deleteOne();

  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Site deleted successfully"));
});

export {
  createSite,
  getAllSites,
  getSite,
  updateSite,
  deleteSite,
};
