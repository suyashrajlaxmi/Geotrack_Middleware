// routes/manualClient.routes.js
// FINAL VERSION: With plan limitations + trial user restrictions

import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { 
  checkClientCreationLimit,
  requireFeature 
} from "../middleware/featureAuth.js";
import { 
  blockTrialUserWrites, 
  enforceTrialUserLimits 
} from "../middleware/trialUser.js";  // ← NEW IMPORT
import * as manualClientController from "../controllers/manualClient.controller.js";

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// ============================================
// CREATE CLIENT
// ============================================
// Blocked for trial users
router.post("/", 
  blockTrialUserWrites,  // ← NEW: Block trial users
  checkClientCreationLimit,
  asyncHandler(manualClientController.createClient)
);

// ============================================
// GET ALL CLIENTS
// ============================================
// Allow trial users with limits
router.get("/", 
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(manualClientController.getClients)
);

// ============================================
// GET SINGLE CLIENT BY ID
// ============================================
// Allow trial users
router.get("/:id", 
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(manualClientController.getClientById)
);

// ============================================
// UPDATE CLIENT
// ============================================
// Blocked for trial users
router.put("/:id", 
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(manualClientController.updateClient)
);

// ============================================
// DELETE CLIENT
// ============================================
// Blocked for trial users
router.delete("/:id", 
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(manualClientController.deleteClient)
);

// ============================================
// BASIC SEARCH
// ============================================
// Allow trial users with limits
router.get("/search", 
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(manualClientController.searchClients)
);

// ============================================
// ADVANCED SEARCH (Feature-Gated)
// ============================================
// Requires Professional+ plan, allow trial users with limits
router.get("/search/advanced",
  requireFeature('advancedSearch'),
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(async (req, res) => {
    // TODO: Implement advanced search with filters
    res.json({ 
      message: "Advanced search with filters",
      filters: req.query 
    });
  })
);

export default router;