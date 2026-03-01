import express from "express";
import multer from "multer";
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { getCheckInStatus, processAttendance } from "../controllers/checkIn.controller.js";

const checkInRouter = express.Router();

// 1. Configure Multer (RAM Storage with Limits)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 3 * 1024 * 1024 // 3MB Limit (Safe for Render Free Tier)
    } 
}); 

// Routes
checkInRouter.post("/attendance", ClerkExpressRequireAuth(), upload.single("image"), processAttendance);
checkInRouter.get("/attendance/status/:id", ClerkExpressRequireAuth(), getCheckInStatus);

export default checkInRouter;