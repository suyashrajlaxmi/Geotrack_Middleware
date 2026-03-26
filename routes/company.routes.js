// routes/company.routes.js
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/company.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import * as companyController from "../controllers/company.controller.js";

const router = express.Router();

// All routes require authentication + super admin role
router.use(authenticateToken, requireSuperAdmin);

// Company CRUD
router.post("/", asyncHandler(companyController.createCompany));
router.get("/", asyncHandler(companyController.getAllCompanies));
router.get("/stats", asyncHandler(companyController.getCompanyStats));
router.get("/:companyId", asyncHandler(companyController.getCompanyById));
router.put("/:companyId", asyncHandler(companyController.updateCompany));
router.delete("/:companyId", asyncHandler(companyController.deleteCompany));

// ✅ ADD THESE TWO NEW ROUTES:
router.get("/:companyId/users", asyncHandler(companyController.getCompanyUsers));
router.get("/:companyId/clients", asyncHandler(companyController.getCompanyClients));

// User-Company assignment
router.post("/assign-user", asyncHandler(companyController.assignUserToCompany));

// Super admin management
router.post("/promote-super-admin", asyncHandler(companyController.promoteSuperAdmin));
router.post("/revoke-super-admin", asyncHandler(companyController.revokeSuperAdmin));

export default router;