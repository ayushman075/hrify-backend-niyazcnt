import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";

import {
  createShiftRoster,
  deleteShiftRoster,
  getPostShiftRoster,
  getEmployeeShiftRoster,
  getRoasterById,
} from "../controllers/shift.controller.js";

const shiftRosterRouter = express.Router();

shiftRosterRouter.post("/create", ClerkExpressRequireAuth(), createShiftRoster); // Create a shift roster entry
shiftRosterRouter.get("/post", ClerkExpressRequireAuth(), getPostShiftRoster); // Get department roster for a month
shiftRosterRouter.get("/employee", ClerkExpressRequireAuth(), getEmployeeShiftRoster); // Get employee roster for a month
shiftRosterRouter.get("/get/:rosterId", ClerkExpressRequireAuth(), getRoasterById); // Get roster entry by ID
shiftRosterRouter.delete("/delete", ClerkExpressRequireAuth(), deleteShiftRoster); // Delete a roster entry

export  {shiftRosterRouter};
