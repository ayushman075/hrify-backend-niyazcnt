// leaveConfigRoutes.js

import express from 'express';
import { createLeaveConfig, getAllLeaveConfigs, getLeaveConfigById, updateLeaveConfig, deleteLeaveConfig } from '../controllers/leaveConfig.controller.js';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';    
const leaveConfigRouter = express.Router();

// Create Leave Config - Only Admin and HR Manager can create leave config
leaveConfigRouter.post(
  '/create',
  ClerkExpressRequireAuth(),
  createLeaveConfig
);

// Get all Leave Configurations
leaveConfigRouter.get(
  '/getAll',
  ClerkExpressRequireAuth(),
  getAllLeaveConfigs
);

// Get a Leave Configuration by ID
leaveConfigRouter.get(
  '/get/:id',
  ClerkExpressRequireAuth(),
  getLeaveConfigById
);

// Update Leave Config - Only Admin and HR Manager can update leave config
leaveConfigRouter.put(
  '/update/:id',
  ClerkExpressRequireAuth(),
  updateLeaveConfig
);

// Delete Leave Config - Only Admin and HR Manager can delete leave config
leaveConfigRouter.delete(
  '/delete/:id',
  ClerkExpressRequireAuth(),
  deleteLeaveConfig
);

export default leaveConfigRouter;
