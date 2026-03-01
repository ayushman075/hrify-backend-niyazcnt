import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { EmployeeDocument } from "../models/employeeDocument.model.js";
import { Employee } from "../models/employee.model.js";
import { User } from "../models/user.model.js";
import { uploadFileOnCloudinary, deleteFileFromCloudinary, uploadFileOnCloudinaryNew } from "../utils/cloudinary.js";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";
import fs from "fs";

const CACHE_KEY = {
    VAULT_PREFIX: "emp_vault_", // e.g., emp_vault_{employeeId}
};

const uploadDocument = asyncHandler(async (req, res) => {
    const { employeeId, documentType, title, description } = req.body;
    const userId = req.auth.userId;

    if (!employeeId || !documentType || !title) {
        if (req.file) fs.unlinkSync(req.file.path); // Cleanup temp file
        return res.status(400).json(new ApiResponse(400, {}, "Employee ID, Document Type, and Title are required."));
    }

    const localFilePath = req.file?.path;
    if (!localFilePath) {
        return res.status(400).json(new ApiResponse(400, {}, "Document file is required."));
    }

    // Verify User and Employee exist
    const [user, employee] = await Promise.all([
        User.findOne({ userId }),
        Employee.findById(employeeId)
    ]);

    if (!user) {
        fs.unlinkSync(localFilePath);
        return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request"));
    }
    if (!employee) {
        fs.unlinkSync(localFilePath);
        return res.status(404).json(new ApiResponse(404, {}, "Employee not found."));
    }

    // Upload to Cloudinary
    const cloudinaryResponse = await uploadFileOnCloudinaryNew(localFilePath);
    
    if (!cloudinaryResponse || !cloudinaryResponse.url) {
        return res.status(500).json(new ApiResponse(500, {}, "Error uploading file to storage."));
    }

    const newDocument = await EmployeeDocument.create({
        employee: employeeId,
        documentType,
        title,
        description,
        fileUrl: cloudinaryResponse.url,
        publicId: cloudinaryResponse.publicId, // Save for future deletion
        fileFormat: cloudinaryResponse.format,
        uploadedBy: user._id
    });

    // [CACHE INVALIDATION] Clear this employee's vault cache
    await removeCache(`${CACHE_KEY.VAULT_PREFIX}${employeeId}`);

    // Prevent publicId from being sent to the client
    newDocument.publicId = undefined;

    return res.status(201).json(new ApiResponse(201, newDocument, "Document uploaded successfully."));
});

const getEmployeeVault = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { documentType } = req.query;

    if (!employeeId) {
        return res.status(400).json(new ApiResponse(400, {}, "Employee ID is required."));
    }

    // Cache logic tailored to the employee and optional type filter
    const cacheKey = `${CACHE_KEY.VAULT_PREFIX}${employeeId}_t_${documentType || 'all'}`;
    const cachedVault = await getCache(cacheKey);

    if (cachedVault) {
        return res.status(200).json(new ApiResponse(200, cachedVault, "Vault retrieved from cache", true));
    }

    const query = { employee: employeeId };
    if (documentType!="all") {
        query.documentType = documentType;
    }

    const documents = await EmployeeDocument.find(query)
        .populate("uploadedBy", "fullName email") // Show who uploaded it
        .sort({ createdAt: -1 });

    await setCache(cacheKey, documents, 3600); // Cache for 1 hour

    return res.status(200).json(new ApiResponse(200, documents, "Employee documents retrieved successfully."));
});

const deleteDocument = asyncHandler(async (req, res) => {
    const { documentId } = req.params;
    const userId = req.auth.userId;

    const user = await User.findOne({ userId });
    if (!user || (user.role !== 'Admin' && user.role !== 'HR Manager')) {
        return res.status(403).json(new ApiResponse(403, {}, "Only Admin or HR can delete documents."));
    }

    // Need to explicitly select publicId as it is hidden by default in the schema
    const document = await EmployeeDocument.findById(documentId).select("+publicId");

    if (!document) {
        return res.status(404).json(new ApiResponse(404, {}, "Document not found."));
    }

    // 1. Delete from Cloudinary
    await deleteFileFromCloudinary(document.publicId);

    // 2. Delete from Database
    await document.deleteOne();

    // 3. [CACHE INVALIDATION] Clear the employee's vault cache
    await removeCachePattern(`${CACHE_KEY.VAULT_PREFIX}${document.employee}*`);

    return res.status(200).json(new ApiResponse(200, {}, "Document deleted successfully."));
});

export {
    uploadDocument,
    getEmployeeVault,
    deleteDocument
};