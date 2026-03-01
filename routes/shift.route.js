import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";

import {
  createShift,
  getAllShifts,
  getShiftById,
  deleteShift,
} from "../controllers/shift.controller.js";

const shiftRouter = express.Router();

shiftRouter.post("/create", ClerkExpressRequireAuth(), createShift); // Create a new shift
shiftRouter.get("/getAll", ClerkExpressRequireAuth(), getAllShifts); // Get all shifts
shiftRouter.get("/get/:shiftId", ClerkExpressRequireAuth(), getShiftById); // Get shift details by ID
shiftRouter.delete("/delete/:shiftId", ClerkExpressRequireAuth(), deleteShift); // Delete a shift

export default shiftRouter;
