import express from "express";
import {
  createDepartment,
  getAllDepartments,
  getDepartment,
  updateDepartment,
  deleteDepartment
} from "../controllers/department.controller.js";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";

const departmentRouter = express.Router();

departmentRouter.post("/create", ClerkExpressRequireAuth(), createDepartment);
departmentRouter.get("/get", ClerkExpressRequireAuth(), getAllDepartments);
departmentRouter.get("/getById/:id", ClerkExpressRequireAuth(), getDepartment);
departmentRouter.put("/update/:id", ClerkExpressRequireAuth(), updateDepartment);
departmentRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteDepartment);

export { departmentRouter };