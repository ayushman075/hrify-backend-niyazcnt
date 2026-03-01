import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";

import {
  createHoliday,
  getAllHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday
} from "../controllers/holidays.controller.js";

const holidayRouter = express.Router();

// Create a new holiday
holidayRouter.post("/create", ClerkExpressRequireAuth(), createHoliday);

// Get all holidays with optional filters
holidayRouter.get("/getAll", ClerkExpressRequireAuth(), getAllHolidays);

// Get holiday details by ID
holidayRouter.get("/get/:id", ClerkExpressRequireAuth(), getHolidayById);

// Update an existing holiday
holidayRouter.patch("/update/:id", ClerkExpressRequireAuth(), updateHoliday);

// Delete a holiday
holidayRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteHoliday);

export  {holidayRouter};