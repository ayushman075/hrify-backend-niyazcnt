import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import { 
    getOfferLetterData, 
    getJoiningLetterData, 
    getExperienceLetterData, 
    getPayrollSlipData 
} from "../controllers/pdfGeneration.controller.js";

const pdfRouter = express.Router();

// Changed from 'generate...' to specific data endpoints
// We use POST here because we are sending body parameters (dates, specific overrides) 
// to customize the data response.

pdfRouter.post("/offer-letter/:candidateId", ClerkExpressRequireAuth(), getOfferLetterData);
pdfRouter.post("/joining-letter/:employeeId", ClerkExpressRequireAuth(), getJoiningLetterData);
pdfRouter.post("/experience-letter/:employeeId", ClerkExpressRequireAuth(), getExperienceLetterData);
pdfRouter.post("/payroll-slip/:employeeId", ClerkExpressRequireAuth(), getPayrollSlipData);

// REMOVED: getAll and getById routes 
// (Since we are no longer saving PDF logs to the database)

export { pdfRouter };