import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/user.model.js";
import EmailTemplate from "../models/emailTemplate.model.js";


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
    // match[1] contains the variable name without the curly braces
    // Trim to remove any whitespace
    const variableName = match[1].trim();
    
    // Only add if it's not already in the array
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

  // Extract variables from the template body
  const variables = extractTemplateVariables(body);
  
  const template = await EmailTemplate.create({
    name,
    subject,
    body,
    variables,
    createdBy: user._id,
  });

  return res.status(201).json(new ApiResponse(201, template, "Template created successfully!"));
});

const getAllTemplates = asyncHandler(async (req, res) => {
  const { page = 1, limit = 100, search = "" } = req.query;

  const query = {};
  if (search) {
    query.name = { $regex: search, $options: "i" };
  }

  const templates = await EmailTemplate.find(query)
    .populate("createdBy", "fullName")
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalTemplates = await EmailTemplate.countDocuments(query);

  return res.status(200).json(new ApiResponse(200, {
    totalTemplates,
    totalPages: Math.ceil(totalTemplates / limit),
    currentPage: parseInt(page),
    templates,
  }, "Templates fetched successfully"));
});

const getTemplate = asyncHandler(async (req, res) => {
  const template = await EmailTemplate.findById(req.params.id)
    .populate("createdBy", "fullName");

  if (!template) {
    return res.status(404).json(new ApiResponse(404, {}, "Template not found!"));
  }

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
    const existingTemplate = await Template.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      _id: { $ne: template._id }
    });
    if (existingTemplate) {
      return res.status(409).json(new ApiResponse(409, {}, "Template name already exists"));
    }
  }

  template.name = name || template.name;
  template.subject = subject || template.subject;
  template.body = body || template.body;

  await template.save();

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

  return res.status(200).json(new ApiResponse(200, {}, "Template deleted successfully!"));
});

export {
  createTemplate,
  getAllTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate
};
