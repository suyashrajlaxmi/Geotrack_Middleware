import express from "express";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { attachCompanyContext } from "../middleware/company.js"; // ✅ ADD THIS
import { asyncHandler } from "../middleware/errorHandler.js";
import * as adminController from "../controllers/admin.controller.js";

const router = express.Router();

// ✅ FIXED: All admin routes require authentication + company context + admin role
router.use(authenticateToken, attachCompanyContext, requireAdmin);

// Existing routes
router.get("/clients", asyncHandler(adminController.getAllClients));
router.get("/users", asyncHandler(adminController.getAllUsers));
router.get("/analytics", asyncHandler(adminController.getAnalytics));
router.get("/location-logs/:userId", asyncHandler(adminController.getUserLocationLogs));
router.get("/clock-status/:userId", asyncHandler(adminController.getClockStatus));
router.get("/expenses/summary", asyncHandler(adminController.getExpensesSummary));
router.get("/user-meetings/:userId", asyncHandler(adminController.getUserMeetings));
router.get("/user-expenses/:userId", asyncHandler(adminController.getUserExpenses));
router.get("/check", asyncHandler(adminController.checkAdminStatus));

// NEW USER MANAGEMENT ROUTES
router.post("/users", asyncHandler(adminController.createUser));
router.get("/users/:userId", asyncHandler(adminController.getUserDetails));
router.put("/users/:userId", asyncHandler(adminController.updateUser));
router.delete("/users/:userId", asyncHandler(adminController.deleteUser));
router.post("/users/:userId/reset-password", asyncHandler(adminController.resetUserPassword));


// ============================================
// MARK EXPENSE AS PAID / UNPAID
// ============================================
router.patch("/expenses/:expenseId/mark-paid",   asyncHandler(adminController.markExpenseAsPaid));
router.patch("/expenses/:expenseId/mark-unpaid", asyncHandler(adminController.markExpenseAsUnpaid));

export default router;