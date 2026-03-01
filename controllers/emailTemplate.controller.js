import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/user.model.js";
import EmailTemplate from "../models/emailTemplate.model.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "template_",           // Single ID: template_12345
  LIST_PREFIX: "template_list_"  // Query lists
};

const extractTemplateVariables = (templateBody) => {
  if (!templateBody || typeof templateBody !== 'string') {
    return [];
  }

  // Regular expression to match variables like {{variableName}}
  const variableRegex = /\{\{([^{}]+)\}\}/g;
  const variables = [];
  
  // Extract all matches
  let match;
  while ((match = variableRegex.exec(templateBody)) !== null) {
    const variableName = match[1].trim();
    if (!variables.includes(variableName)) {
      variables.push(variableName);
    }
  }
  
  return variables;
};

const createTemplate = asyncHandler(async (req, res) => {
  const { name, subject, body } = req.body;

  const userId = req.auth.userId;
  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user ) {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can create templates", false));
  }

  if (!name || !subject || !body) {
    return res.status(409).json(new ApiResponse(409, {}, "All fields are required"));
  }

  const existingTemplate = await EmailTemplate.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
  if (existingTemplate) {
    return res.status(409).json(new ApiResponse(409, {}, "Template already exists"));
  }

  const variables = extractTemplateVariables(body);
  
  const template = await EmailTemplate.create({
    name,
    subject,
    body,
    variables,
    createdBy: user._id,
  });

  // [CACHE INVALIDATION] New template added -> Clear lists
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(201).json(new ApiResponse(201, template, "Template created successfully!"));
});

const getAllTemplates = asyncHandler(async (req, res) => {
  const { page = 1, limit = 100, search = "" } = req.query;

  // [CACHE READ] Create unique key based on query params
  const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${search}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
      return res.status(200).json(new ApiResponse(200, cachedData, "Templates fetched from Cache"));
  }

  const query = {};
  if (search) {
    query.name = { $regex: search, $options: "i" };
  }

  const templates = await EmailTemplate.find(query)
    .populate("createdBy", "fullName")
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalTemplates = await EmailTemplate.countDocuments(query);

  const responsePayload = {
      totalTemplates,
      totalPages: Math.ceil(totalTemplates / limit),
      currentPage: parseInt(page),
      templates,
  };

  // [CACHE WRITE] Save for 1 hour
  await setCache(cacheKey, responsePayload, 3600);

  return res.status(200).json(new ApiResponse(200, responsePayload, "Templates fetched successfully"));
});

const getTemplate = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `${CACHE_KEY.PREFIX}${id}`;

  // [CACHE READ]
  const cachedTemplate = await getCache(cacheKey);
  if (cachedTemplate) {
      return res.status(200).json(new ApiResponse(200, cachedTemplate, "Template retrieved from Cache!"));
  }

  const template = await EmailTemplate.findById(id)
    .populate("createdBy", "fullName");

  if (!template) {
    return res.status(404).json(new ApiResponse(404, {}, "Template not found!"));
  }

  // [CACHE WRITE]
  await setCache(cacheKey, template, 3600);

  return res.status(200).json(new ApiResponse(200, template, "Template retrieved successfully!"));
});

const updateTemplate = asyncHandler(async (req, res) => {
  const { name, subject, body } = req.body;
  const userId = req.auth.userId;

  if (!userId) {
    return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
  }

  const user = await User.findOne({ userId });
  if (!user || !(user.role === 'Admin')) {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can update templates", false));
  }

  const template = await EmailTemplate.findById(req.params.id);

  if (!template) {
    return res.status(404).json(new ApiResponse(404, {}, "Template not found!"));
  }

  if (name && name !== template.name) {
    const existingTemplate = await EmailTemplate.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      _id: { $ne: template._id }
    });
    if (existingTemplate) {
      return res.status(409).json(new ApiResponse(409, {}, "Template name already exists"));
    }
  }

  // If body changes, we might need to re-extract variables
  if (body && body !== template.body) {
      template.variables = extractTemplateVariables(body);
  }

  template.name = name || template.name;
  template.subject = subject || template.subject;
  template.body = body || template.body;

  await template.save();

  // [CACHE INVALIDATION]
  // 1. Clear this specific template cache
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  // 2. Clear all list caches
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, template, "Template updated successfully!"));
});

const deleteTemplate = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const user = await User.findOne({ userId });

  if (!user || !(user.role === 'Admin')) {
    return res.status(401).json(new ApiResponse(401, {}, "Only Admin can delete templates", false));
  }

  const template = await EmailTemplate.findById(req.params.id);
  if (!template) {
    return res.status(404).json(new ApiResponse(404, {}, "Template not found!"));
  }

  await template.deleteOne();

  // [CACHE INVALIDATION]
  await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
  await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);

  return res.status(200).json(new ApiResponse(200, {}, "Template deleted successfully!"));
});

export {
  createTemplate,
  getAllTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate
};