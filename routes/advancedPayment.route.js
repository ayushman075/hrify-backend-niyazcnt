import express from "express";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { applyForAdvance, deleteAdvanceRequest, getAdvanceById, getAdvanceRecords, updateAdvanceStatus } from "../controllers/advancedPayment.controller.js";

const advancePaymentRouter = express.Router();

advancePaymentRouter.post("/apply",ClerkExpressRequireAuth(),applyForAdvance)
advancePaymentRouter.put("/update/:id",ClerkExpressRequireAuth(),updateAdvanceStatus)
advancePaymentRouter.get("/getById/:id",ClerkExpressRequireAuth(),getAdvanceById)
advancePaymentRouter.get("/getAll",ClerkExpressRequireAuth(),getAdvanceRecords)
advancePaymentRouter.delete("/delete/:id",ClerkExpressRequireAuth(),deleteAdvanceRequest)


export {advancePaymentRouter}