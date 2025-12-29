import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import { generateMonthlyPayroll, generateWeeklyPayroll, getFilteredPayroll, getPayrollById, processEmployeePayroll, updatePayroll } from "../controllers/payroll.controller.js";


const payrollRouter = express.Router();

payrollRouter.post("/generateMonthly", ClerkExpressRequireAuth(), generateMonthlyPayroll);

payrollRouter.post("/generateWeekly", ClerkExpressRequireAuth(), generateWeeklyPayroll);


payrollRouter.post("/processEmployee", ClerkExpressRequireAuth(), processEmployeePayroll);

payrollRouter.put("/update/:id", ClerkExpressRequireAuth(), updatePayroll);


payrollRouter.get("/get/:id", ClerkExpressRequireAuth(), getPayrollById);

payrollRouter.get("/getAll", ClerkExpressRequireAuth(), getFilteredPayroll);

export { payrollRouter };