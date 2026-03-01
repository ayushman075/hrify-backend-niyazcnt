import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import { 
    getEmployeeDashboardStats, 
    getHRDashboardStats,
    getDetailedSiteAttendance,
    getDetailedAttendance,
    getDetailedPayroll,
    getDetailedLeaves
} from "../controllers/dashboard.controller.js";

const dashboardRouter = express.Router();

// --- Main Dashboard Stats ---
dashboardRouter.get("/getHRDashboardStats", ClerkExpressRequireAuth(), getHRDashboardStats);
dashboardRouter.get("/getEmployeeDashboardStats", ClerkExpressRequireAuth(), getEmployeeDashboardStats);

// --- Detailed HR Lists ---
dashboardRouter.get("/detailed-attendance", ClerkExpressRequireAuth(), getDetailedAttendance);
dashboardRouter.get("/detailed-payroll", ClerkExpressRequireAuth(), getDetailedPayroll);
dashboardRouter.get("/detailed-leaves", ClerkExpressRequireAuth(), getDetailedLeaves);

// --- Site Specific Detailed Stats ---
// Uses :siteId as a URL parameter to fetch the nested departmental/post aggregation
dashboardRouter.get("/site-attendance/:siteId", ClerkExpressRequireAuth(), getDetailedSiteAttendance);

export { dashboardRouter };