import express from "express";
import { uploadDocument, getEmployeeVault, deleteDocument } from "../controllers/employeeDocument.controller.js";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import { upload } from "../middlewares/multer.middleware.js"; // Standard multer setup

const documentVaultRouter = express.Router();

// Upload a document (Handles PDF and Images via Multer)
documentVaultRouter.post(
    "/upload", 
    ClerkExpressRequireAuth(), 
    upload.single("documentFile"), // 'documentFile' is the form-data key
    uploadDocument
);

// Get all documents for a specific employee
documentVaultRouter.get(
    "/vault/:employeeId", 
    ClerkExpressRequireAuth(), 
    getEmployeeVault
);

// Delete a document by its ID
documentVaultRouter.delete(
    "/delete/:documentId", 
    ClerkExpressRequireAuth(), 
    deleteDocument
);

export { documentVaultRouter };