import express from "express";
import multer from "multer";
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { getCheckInStatus, processAttendance } from "../controllers/checkIn.controller.js";

const checkInRouter = express.Router();

// 1. Configure Multer (Temp Storage)
const upload = multer({ dest: "uploads/face/" }); 

// 2. Define Routes
// Protect routes if needed, e.g., checkInRouter.use(ClerkExpressRequireAuth());

// POST: Upload image -> Returns { checkInId: "..." }
checkInRouter.post("/attendance", ClerkExpressRequireAuth(), upload.single("image"), processAttendance);

// GET: Poll status -> Returns { status: "SUCCESS", identifiedEmployee: { fullName: "..." } }
checkInRouter.get("/attendance/status/:id", ClerkExpressRequireAuth(), getCheckInStatus);

export default checkInRouter;