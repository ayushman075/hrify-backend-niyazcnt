import express from "express";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { createTemplate, deleteTemplate, getAllTemplates, getTemplate, updateTemplate } from "../controllers/emailTemplate.controller.js";

const emailTemplateRouter = express.Router();

emailTemplateRouter.post("/create",ClerkExpressRequireAuth(),createTemplate)
emailTemplateRouter.get("/get/:id",ClerkExpressRequireAuth(),getTemplate)
emailTemplateRouter.get("/getAll",ClerkExpressRequireAuth(),getAllTemplates);
emailTemplateRouter.put("/update/:id",ClerkExpressRequireAuth(),updateTemplate)
emailTemplateRouter.delete("/delete/:id",ClerkExpressRequireAuth(),deleteTemplate)


export {emailTemplateRouter}
