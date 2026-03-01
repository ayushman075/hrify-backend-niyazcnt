import express from "express";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";

import {
  finalizeRoster,
} from "../controllers/shiftRosterFinalization.controller.js";

const shiftRosterFinalizationRouter = express.Router();

shiftRosterFinalizationRouter.post("/finalize", ClerkExpressRequireAuth(), finalizeRoster); // Finalize a month's roster


export {shiftRosterFinalizationRouter};
