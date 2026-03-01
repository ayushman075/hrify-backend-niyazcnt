import express from "express";
import {
  createNotice,
  getAllNotices,
  getNotice,
  updateNotice,
  toggleNoticeStatus,
  deleteNotice
} from "../controllers/notice.controller.js";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";

const noticeRouter = express.Router();

noticeRouter.post("/create", ClerkExpressRequireAuth(), createNotice);
noticeRouter.get("/get", ClerkExpressRequireAuth(), getAllNotices);
noticeRouter.get("/getById/:id", ClerkExpressRequireAuth(), getNotice);
noticeRouter.put("/update/:id", ClerkExpressRequireAuth(), updateNotice);
noticeRouter.patch("/toggle/:id", ClerkExpressRequireAuth(), toggleNoticeStatus);
noticeRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteNotice);

export { noticeRouter };