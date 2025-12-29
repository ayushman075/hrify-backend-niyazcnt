import express from "express";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { getAdvanceConfig, updateAdvanceConfig } from "../controllers/advancedPayment.controller.js";

const advancePaymentConfigRouter = express.Router();

advancePaymentConfigRouter.get("/get",ClerkExpressRequireAuth(),getAdvanceConfig)
advancePaymentConfigRouter.put("/update",ClerkExpressRequireAuth(),updateAdvanceConfig)


export {advancePaymentConfigRouter}