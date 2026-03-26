// routes/expenses.routes.js
// FINAL VERSION: With plan limitations + trial user restrictions

import express from "express";
import multer from "multer";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { checkExpenseReceiptUpload } from "../middleware/featureAuth.js";
import { 
  blockTrialUserWrites, 
  enforceTrialUserLimits 
} from "../middleware/trialUser.js";  // ← NEW IMPORT
import * as expensesController from "../controllers/expenses.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// CREATE EXPENSE
// ============================================
// Blocked for trial users
router.post("/", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(expensesController.createExpense)
);

// ============================================
// GET MY TOTAL EXPENSES
// ============================================
// Allow trial users with limits
router.get("/my-total", 
  authenticateToken,
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(expensesController.getMyTotal)
);

// ============================================
// GET MY EXPENSES
// ============================================
// Allow trial users with limits
router.get("/my-expenses", 
  authenticateToken,
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(expensesController.getMyExpenses)
);

// ============================================
// UPLOAD RECEIPT
// ============================================
// Blocked for trial users
router.post("/receipts", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  upload.single("file"),
  checkExpenseReceiptUpload,
  asyncHandler(expensesController.uploadReceipt)
);

// ============================================
// GET EXPENSE BY ID
// ============================================
// Allow trial users with limits
router.get("/:id", 
  authenticateToken,
  enforceTrialUserLimits,  // ← NEW: Allow trial users
  asyncHandler(expensesController.getExpenseById)
);

// ============================================
// UPDATE EXPENSE
// ============================================
// Blocked for trial users
router.put("/:id", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(expensesController.updateExpense)
);

// ============================================
// DELETE EXPENSE
// ============================================
// Blocked for trial users
router.delete("/:id", 
  authenticateToken,
  blockTrialUserWrites,  // ← NEW: Block trial users
  asyncHandler(expensesController.deleteExpense)
);

export default router;