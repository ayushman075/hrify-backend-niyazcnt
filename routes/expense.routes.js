import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import {
  createExpenseClaim,
  getAllExpenses,
  getExpenseById,
  processExpenseClaim,
  markAsReimbursed,
  deleteExpenseClaim
} from "../controllers/expense.controller.js";

const expenseRouter = express.Router();

// General Routes
expenseRouter.post("/create", ClerkExpressRequireAuth(), createExpenseClaim);
expenseRouter.get("/get", ClerkExpressRequireAuth(), getAllExpenses);
expenseRouter.get("/get/:id", ClerkExpressRequireAuth(), getExpenseById);

// Employee actions
expenseRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteExpenseClaim);

// Admin / HR Management routes
expenseRouter.patch("/process/:id", ClerkExpressRequireAuth(), processExpenseClaim);
expenseRouter.patch("/reimburse/:id", ClerkExpressRequireAuth(), markAsReimbursed);

export { expenseRouter };