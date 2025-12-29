import express from "express";
import {
  createCandidate,
  getAllCandidates,
  getCandidate,
  updateCandidate,
  deleteCandidate,
  getLatestCandidateId,
  uploadResume,
} from "../controllers/candidate.controller.js";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";
import { upload } from "../middlewares/multer.middleware.js";


const candidateRouter = express.Router();

candidateRouter.post("/create", ClerkExpressRequireAuth(),createCandidate);
candidateRouter.post("/uploadResume",ClerkExpressRequireAuth(), upload.single('resume'), uploadResume)
candidateRouter.get("/get", ClerkExpressRequireAuth(), getAllCandidates);
candidateRouter.get("/getById", ClerkExpressRequireAuth(), getLatestCandidateId);
candidateRouter.get("/getById/:id", ClerkExpressRequireAuth(), getCandidate);
candidateRouter.put("/update/:id", ClerkExpressRequireAuth(), updateCandidate);
candidateRouter.delete("/delete/:id", ClerkExpressRequireAuth(), deleteCandidate);

export {candidateRouter};
