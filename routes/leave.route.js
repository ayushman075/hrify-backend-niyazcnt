import express from 'express';
import { 
  applyForLeave, 
  updateLeaveApplication, 
  deleteLeaveApplication, 
  getLeaveApplicationById, 
  getAllLeaveApplications,
  approveOrDisapproveLeave 
} from '../controllers/leave.controller.js';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';

const leaveApplicationRouter = express.Router();

leaveApplicationRouter.post(
  '/apply',
  ClerkExpressRequireAuth(),
  applyForLeave
);

leaveApplicationRouter.put(
  '/update/:id',
  ClerkExpressRequireAuth(),
  updateLeaveApplication
);

leaveApplicationRouter.delete(
  '/delete/:id',
  ClerkExpressRequireAuth(),
  deleteLeaveApplication
);

leaveApplicationRouter.get(
  '/getById/:id',
  ClerkExpressRequireAuth(),
  getLeaveApplicationById
);

leaveApplicationRouter.get(
  '/getAll',
  ClerkExpressRequireAuth(),
  getAllLeaveApplications
);

leaveApplicationRouter.post(
  '/approveOrDisapprove',
  ClerkExpressRequireAuth(),
  approveOrDisapproveLeave
);

export {leaveApplicationRouter};
