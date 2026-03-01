import express from 'express';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { initializeLeaveLimit, getLeaveLimit, getLeaveLimits, updateLeaveUsage, refreshLeaveLimits, manualUpdateLeaveBalance } from '../controllers/leaveLimit.controller.js';


const leaveLimitRouter = express.Router();

leaveLimitRouter.post(
  '/create',
  ClerkExpressRequireAuth(),
  initializeLeaveLimit
);

leaveLimitRouter.put(
  '/update/:id',
  ClerkExpressRequireAuth(),
  updateLeaveUsage
);




leaveLimitRouter.post(
    '/refreshLeaveLimit',
    ClerkExpressRequireAuth(),

    refreshLeaveLimits
  );
  
  leaveLimitRouter.get(
    '/getLeaveStat',
    ClerkExpressRequireAuth(),
    getLeaveLimit
  )

  leaveLimitRouter.get(
    '/getAll',
    ClerkExpressRequireAuth(),
    getLeaveLimits
  )

  leaveLimitRouter.patch(
  '/manual-update/:leaveLimitId',
  ClerkExpressRequireAuth(),
  manualUpdateLeaveBalance
);
export default leaveLimitRouter;
