import {Router} from "express";
import {clerkWebhookListener,updateUserProfile,getUserProfile,getAllUsers, createUser, deleteUser} from "../controllers/user.controller.js";
import { ClerkExpressRequireAuth, ClerkExpressWithAuth } from "@clerk/clerk-sdk-node";

const userRouter = Router()

userRouter.route("/webhook/clerk").post(clerkWebhookListener)

userRouter.route("/updateDetails").post(
  ClerkExpressRequireAuth(),
  updateUserProfile
)

userRouter.route("/getCurrent").get(
  ClerkExpressRequireAuth(),
  getUserProfile)

  userRouter.route("/getAllUser").get(
    ClerkExpressRequireAuth(),
    getAllUsers)

  userRouter.route("/createUser").post(
    ClerkExpressRequireAuth(),
    createUser)

    userRouter.route("/deleteUser/:id").delete(
      ClerkExpressRequireAuth(),
      deleteUser)


export {userRouter}