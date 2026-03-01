import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import {
  getOvertimeConfig,
  upsertOvertimeConfig,
  createOvertime,
  getAllOvertime,
  redeemOvertime,
  deleteOvertime
} from "../controllers/overtime.controller.js";

const overtimeRouter = express.Router();

// Configuration Routes
overtimeRouter.get("/config", ClerkExpressRequireAuth(), getOvertimeConfig);
overtimeRouter.post("/config", ClerkExpressRequireAuth(), upsertOvertimeConfig); // Put covers both create and update

// Overtime Record Routes
overtimeRouter.post("/create", ClerkExpressRequireAuth(), createOvertime);
overtimeRouter.get("/getAll", ClerkExpressRequireAuth(), getAllOvertime);
overtimeRouter.delete("/delete/:overtimeId", ClerkExpressRequireAuth(), deleteOvertime);

// Overtime Redemption Route
overtimeRouter.post("/redeem/:overtimeId", ClerkExpressRequireAuth(), redeemOvertime);

export { overtimeRouter };