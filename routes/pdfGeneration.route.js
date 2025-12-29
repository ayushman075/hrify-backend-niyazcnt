import express from "express";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { generateExperienceLetter, generateJoiningLetter, generateOfferLetter, generatePayrollSlip, getAllPDFLogs, getPDFById } from "../controllers/pdfGeneration.controller.js";

const pdfRouter = express.Router();

pdfRouter.post("/generateOfferLetter/:candidateId",ClerkExpressRequireAuth(),generateOfferLetter)
pdfRouter.post("/generateJoiningLetter/:employeeId",ClerkExpressRequireAuth(),generateJoiningLetter)
pdfRouter.post("/generateExperienceLetter/:employeeId",ClerkExpressRequireAuth(),generateExperienceLetter)
pdfRouter.post("/generatePayroll/:employeeId",ClerkExpressRequireAuth(),generatePayrollSlip)
pdfRouter.get("/getAll",ClerkExpressRequireAuth(),getAllPDFLogs)
pdfRouter.get("/getById",ClerkExpressRequireAuth(),getPDFById)

export {pdfRouter}
