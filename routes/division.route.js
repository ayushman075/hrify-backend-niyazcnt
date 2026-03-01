import express from "express";
import {
  createDivision,
  getAllDivisions,
  getDivision,
  updateDivision,
  deleteDivision
} from "../controllers/division.controller.js";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";

const divisionRouter = express.Router();

divisionRouter.post("/create", ClerkExpressRequireAuth(), createDivision);
divisionRouter.get("/get", ClerkExpressRequireAuth(), getAllDivisions);
divisionRouter.get("/getById/:id", ClerkExpressRequireAuth(), getDivision);
divisionRouter.put("/update/:id", ClerkExpressRequireAuth(), updateDivision);
divisionRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteDivision);

export { divisionRouter };