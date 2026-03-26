// routes/sync.routes.js
// FINAL VERSION: With plan limitations + trial user restrictions

import express from "express";
import { authenticateToken, authenticateMiddleware } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireFeature } from "../middleware/featureAuth.js";
import { requireFullUser } from "../middleware/trialUser.js";  // ← NEW IMPORT
import * as syncController from "../controllers/sync.controller.js";

const router = express.Router();

// ============================================
// TALLY MIDDLEWARE ENDPOINT (Feature-Gated)
// ============================================
// Tally sync is only available in Business and Enterprise plans
// Trial users cannot use Tally sync
router.post("/tally-clients", 
  authenticateMiddleware,
  requireFeature('tallySync'),
  asyncHandler(syncController.syncTallyClients)
);

// ============================================
// TALLY CLIENT GUIDS
// ============================================
router.get("/tally-clients/guids", 
  authenticateMiddleware,
  asyncHandler(syncController.getClientGuids)
);

// ============================================
// GET SYNC STATUS
// ============================================
// Allow all users to view sync status (shows "not available" if disabled)
router.get("/status", 
  authenticateToken,
  asyncHandler(syncController.getSyncStatus)
);

// ============================================
// GET LATEST SYNC
// ============================================
// Allow all users to view latest sync
router.get("/latest", 
  authenticateToken,
  asyncHandler(syncController.getLatestSync)
);

// ============================================
// TRIGGER MANUAL SYNC
// ============================================
// Requires Tally feature + full user (trial users blocked)
router.post("/trigger", 
  authenticateToken,
  requireFeature('tallySync'),
  requireFullUser,  // ← NEW: Block trial users
  asyncHandler(syncController.triggerSync)
);

export default router;