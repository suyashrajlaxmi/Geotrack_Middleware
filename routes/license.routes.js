// routes/license.routes.js
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import * as licenseController from "../controllers/license.controller.js";

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get current user's company license
router.get("/my-license", asyncHandler(licenseController.getMyCompanyLicense));

// Get license history
router.get("/my-license/history", asyncHandler(licenseController.getMyLicenseHistory));

// Get company user count
router.get("/my-license/user-count", asyncHandler(licenseController.getCompanyUserCount));

export default router;