import express from "express";
import {
  createSite,
  getAllSites,
  getSite,
  updateSite,
  deleteSite
} from "../controllers/site.controller.js";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";

const siteRouter = express.Router();

siteRouter.post("/create", ClerkExpressRequireAuth(), createSite);
siteRouter.get("/get", ClerkExpressRequireAuth(), getAllSites);
siteRouter.get("/getById/:id", ClerkExpressRequireAuth(), getSite);
siteRouter.put("/update/:id", ClerkExpressRequireAuth(), updateSite);
siteRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteSite);

export { siteRouter };