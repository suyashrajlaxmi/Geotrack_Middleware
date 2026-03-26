// routes/quickVisits.routes.js
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { blockTrialUserWrites, enforceTrialUserLimits } from "../middleware/trialUser.js";
import * as quickVisitsController from "../controllers/quickVisits.controller.js";

const router = express.Router();

// Create quick visit (blocked for trial users)
router.post("/", 
  authenticateToken,
  blockTrialUserWrites,
  asyncHandler(quickVisitsController.createQuickVisit)
);

// Get my quick visits (allow trial users)
router.get("/my-visits", 
  authenticateToken,
  enforceTrialUserLimits,
  asyncHandler(quickVisitsController.getMyQuickVisits)
);

// Get quick visits for a specific client (allow trial users)
router.get("/client/:clientId", 
  authenticateToken,
  enforceTrialUserLimits,
  asyncHandler(quickVisitsController.getClientQuickVisits)
);

export default router;