// routes/services.routes.js
// FINAL VERSION: With plan limitations + trial user restrictions

import express from "express";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { 
  requireFeature, 
  checkServiceCreationLimit 
} from "../middleware/featureAuth.js";
import { 
  requireFullUser,
  enforceTrialUserLimits 
} from "../middleware/trialUser.js";  // ← NEW IMPORT
import * as servicesController from "../controllers/services.controller.js";

const router = express.Router();

// ============================================
// FEATURE GATE: Services Module
// ============================================
// Services are only available in Professional+ plans
// Trial users are COMPLETELY BLOCKED from services
router.use(
  authenticateToken,
  requireFeature('services'),  // Block if plan doesn't have services
  requireFullUser              // ← NEW: Block trial users completely
);

// ============================================
// GET ALL SERVICES (Advanced Analytics Required)
// ============================================
router.get(
  "/all",
  requireRole(['admin', 'editor']),
  requireFeature('advancedAnalytics'),
  asyncHandler(servicesController.getAllServices)
);

// ============================================
// GET EXPIRING SERVICES
// ============================================
router.get(
  "/expiring",
  requireRole(['admin', 'editor']),
  asyncHandler(servicesController.getExpiringServices)
);

// ============================================
// GET SERVICES FOR ONE CLIENT
// ============================================
router.get(
  "/client/:clientId",
  requireRole(['admin', 'editor']),
  asyncHandler(servicesController.getClientServices)
);

// ============================================
// CREATE SERVICE (With Limits)
// ============================================
// Professional: Max 10 services per client
// Business: Max 50 services per client
// Enterprise: UNLIMITED
router.post(
  "/client/:clientId",
  requireRole(['admin', 'editor']),
  checkServiceCreationLimit,
  asyncHandler(servicesController.createService)
);

// ============================================
// UPDATE SERVICE
// ============================================
router.put(
  "/:serviceId",
  requireRole(['admin', 'editor']),
  asyncHandler(servicesController.updateService)
);

// ============================================
// DELETE SERVICE (Admin Only)
// ============================================
router.delete(
  "/:serviceId",
  requireRole(['admin']),
  asyncHandler(servicesController.deleteService)
);

// ============================================
// SERVICE HISTORY (Feature-Gated)
// ============================================
// Available in: Business, Enterprise
router.get(
  "/:serviceId/history",
  requireRole(['admin', 'editor']),
  requireFeature('servicesHistory'),
  asyncHandler(servicesController.getServiceHistory)
);

export default router;