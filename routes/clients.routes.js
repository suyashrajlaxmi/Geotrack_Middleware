// routes/clients.routes.js
// FINAL VERSION: With plan limitations + trial user restrictions

import express from "express";
import multer from "multer";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { 
  checkClientCreationLimit, 
  validateImportBatchSize,
  requireFeature
} from "../middleware/featureAuth.js";
import { 
  blockTrialUserWrites, 
  enforceTrialUserLimits 
} from "../middleware/trialUser.js";  // ← NEW IMPORT
import * as clientsController from "../controllers/clients.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// EXCEL IMPORT
// ============================================
// Blocked for trial users
router.post("/upload-excel", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  upload.single("file"),
  validateImportBatchSize,
  asyncHandler(clientsController.uploadExcel)
);

// ============================================
// CREATE CLIENT
// ============================================
// Blocked for trial users
router.post("/", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  checkClientCreationLimit,
  asyncHandler(clientsController.createClient)
);

// ============================================
// GET CLIENTS
// ============================================
// Allow trial users but with read limits
router.get("/", 
  authenticateToken,
  enforceTrialUserLimits,  // ← NEW: Allow trial users with limits
  asyncHandler(clientsController.getClients)
);

// ============================================
// GET SINGLE CLIENT
// ============================================
// Allow trial users
router.get("/:id", 
  authenticateToken,
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(clientsController.getClientById)
);

// ============================================
// UPDATE CLIENT
// ============================================
// Blocked for trial users
router.put("/:id", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(clientsController.updateClient)
);

// ============================================
// DELETE CLIENT
// ============================================
// Blocked for trial users
router.delete("/:id", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(clientsController.deleteClient)
);

// ============================================
// ADVANCED SEARCH (Feature-Gated)
// ============================================
// Requires Professional+ plan, allow trial users with limits
router.get("/search/advanced",
  authenticateToken,
  requireFeature('advancedSearch'),
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(async (req, res) => {
    // TODO: Implement advanced search
    res.json({ 
      message: "Advanced search endpoint",
      filters: req.query 
    });
  })
);

// ============================================
// BULK OPERATIONS (Feature-Gated)
// ============================================
// Requires Business+ plan, blocked for trial users
router.post("/bulk/update",
  authenticateToken,
  requireFeature('bulkOperations'),
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(async (req, res) => {
    // TODO: Implement bulk update
    res.json({ 
      message: "Bulk update endpoint",
      affectedClients: req.body.clientIds?.length || 0
    });
  })
);

router.post("/bulk/delete",
  authenticateToken,
  requireFeature('bulkOperations'),
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(async (req, res) => {
    // TODO: Implement bulk delete
    res.json({ 
      message: "Bulk delete endpoint",
      affectedClients: req.body.clientIds?.length || 0
    });
  })
);

export default router;