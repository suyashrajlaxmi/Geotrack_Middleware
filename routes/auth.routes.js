// routes/auth.routes.js
// UPDATED: Added domain-based signup and trial user conversion

import express from "express";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import * as authController from "../controllers/auth.controller.js";

const router = express.Router();

// ============================================
// PUBLIC ROUTES
// ============================================
router.post("/login", asyncHandler(authController.login));

// Signup now handles domain-based company assignment automatically
router.post("/signup", asyncHandler(authController.signup));

router.post("/forgot-password", asyncHandler(authController.forgotPassword));
router.post("/reset-password", asyncHandler(authController.resetPassword));

// Trial status (no auth required)
router.get("/trial-status", asyncHandler(authController.getTrialStatus));

// ============================================
// PROTECTED ROUTES
// ============================================
router.post("/logout", authenticateToken, asyncHandler(authController.logout));
router.get("/profile", authenticateToken, asyncHandler(authController.getProfile));
router.put("/profile", authenticateToken, asyncHandler(authController.updateProfile));
router.post("/clear-pincode", authenticateToken, asyncHandler(authController.clearPincode));
router.get("/verify", authenticateToken, asyncHandler(authController.verifyToken));

// ============================================
// NEW: TRIAL USER CONVERSION
// ============================================
// Convert trial user (generic email) to full user (company email)
router.post("/convert-trial-user", 
  authenticateToken, 
  asyncHandler(authController.convertTrialUser)
);

// ============================================
// ADMIN-ONLY ROUTES
// ============================================
router.get("/trial-stats", authenticateToken, requireAdmin, asyncHandler(authController.getTrialStats));
router.post("/block-device", authenticateToken, requireAdmin, asyncHandler(authController.blockDevice));
router.post("/unblock-device", authenticateToken, requireAdmin, asyncHandler(authController.unblockDevice));

export default router;