import express from "express";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { getEmailDetails, getEmailLogs, sendTemplateEmail } from "../controllers/emailLog.controller.js";

const emailLogRouter = express.Router();

emailLogRouter.post("/send",ClerkExpressRequireAuth(),sendTemplateEmail)
emailLogRouter.get("/getEmail/:emailId",ClerkExpressRequireAuth(),getEmailDetails)
emailLogRouter.get("/getAll",ClerkExpressRequireAuth(),getEmailLogs);

export {emailLogRouter}
