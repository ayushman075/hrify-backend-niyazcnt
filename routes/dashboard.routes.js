import express from "express";

import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { getEmployeeDashboardStats, getHRDashboardStats } from "../controllers/dashboard.controller.js";

const dashboardRouter = express.Router();

dashboardRouter.get("/getHRDashboardStats", ClerkExpressRequireAuth(), getHRDashboardStats);

dashboardRouter.get("/getEmployeeDashboardStats", ClerkExpressRequireAuth(), getEmployeeDashboardStats);

export { dashboardRouter };