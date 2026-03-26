// routes/plan.routes.js
// FIXED: Handle super admin case where companyId is null

import express from "express";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { attachCompanyContext, requireSuperAdmin } from "../middleware/company.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { 
  getCompanyPlanFeatures, 
  getAllPlans, 
  upgradeCompanyPlan,
  checkUserLimit,
  checkClientLimit,
  getCompanyUsage
} from "../services/plan.service.js";

const router = express.Router();

// ============================================
// GET CURRENT COMPANY'S PLAN & FEATURES
// ============================================
router.get(
  "/my-plan",
  authenticateToken,
  attachCompanyContext,
  asyncHandler(async (req, res) => {
    // ✅ FIX: Handle super admin without company context
    if (req.isSuperAdmin && !req.companyId) {
      return res.json({
        plan: {
          planName: 'super_admin',
          displayName: 'Super Administrator',
          priceINR: null,
          companyName: 'All Companies',
          limits: {
            users: { max: null, maxConcurrentSessions: null },
            clients: { max: null, importBatchSize: null },
            storage: { maxGB: null },
            history: { locationDays: null, meetingDays: null, expenseDays: null },
            meetings: { maxAttachments: null, attachmentMaxSizeMB: null },
            expenses: { maxReceiptImages: null, receiptMaxSizeMB: null },
            services: { maxPerClient: null },
            api: { rateLimit: null }
          },
          tracking: {
            gpsEnabled: true,
            gpsIntervalMinutes: 5
          },
          features: {
            clientManagementType: 'unlimited',
            pincodeFiltering: true,
            smartPincodeFiltering: true,
            advancedSearch: true,
            bulkOperations: true,
            services: true,
            servicesHistory: true,
            expenses: true,
            tallySync: true,
            tallySyncFrequency: 30,
            apiAccess: true,
            webhooks: true,
            basicReports: true,
            advancedAnalytics: true,
            customReports: true,
            dataExport: true,
            exportFormats: ['csv', 'excel', 'pdf', 'json'],
            teamManagement: true,
            roleBasedPermissions: true,
            interactiveMaps: true,
            routeOptimization: true,
            customBranding: true,
            whiteLabel: true
          },
          support: { level: 'priority' }
        },
        usage: {
          users: {
            current: 0,
            max: null,
            remaining: null,
            percentage: null,
            unlimited: true
          },
          clients: {
            current: 0,
            max: null,
            remaining: null,
            unlimited: true,
            percentage: null
          },
          services: 0,
          meetings: 0,
          expenses: 0,
          locationLogs: 0
        },
        isSuperAdmin: true
      });
    }

    // Regular admin or super admin with specific company selected
    const features = await getCompanyPlanFeatures(req.companyId);
    const userLimit = await checkUserLimit(req.companyId);
    const clientLimit = await checkClientLimit(req.companyId);
    const usage = await getCompanyUsage(req.companyId);
    
    res.json({
      plan: features,
      usage: {
        users: {
          current: userLimit.currentUsers,
          max: userLimit.maxUsers,
          remaining: userLimit.remaining,
          percentage: ((userLimit.currentUsers / userLimit.maxUsers) * 100).toFixed(1)
        },
        clients: {
          current: clientLimit.currentClients,
          max: clientLimit.maxClients,
          remaining: clientLimit.unlimited ? null : clientLimit.remaining,
          unlimited: clientLimit.unlimited,
          percentage: clientLimit.unlimited ? null : ((clientLimit.currentClients / clientLimit.maxClients) * 100).toFixed(1)
        },
        services: usage.services,
        meetings: usage.meetings,
        expenses: usage.expenses,
        locationLogs: usage.locationLogs
      }
    });
  })
);

// ============================================
// GET ALL AVAILABLE PLANS (For Pricing Page)
// ============================================
router.get(
  "/available-plans",
  asyncHandler(async (req, res) => {
    const plans = await getAllPlans();
    
    const formattedPlans = plans.map(plan => ({
      name: plan.plan_name,
      displayName: plan.display_name,
      price: plan.price_inr,
      limits: {
        users: plan.max_users,
        clients: plan.max_clients,
        storageGB: plan.max_cloud_storage_gb,
        servicesPerClient: plan.max_services_per_client,
        importBatchSize: plan.client_import_batch_size
      },
      features: {
        services: plan.services_enabled,
        tallySync: plan.tally_sync_enabled,
        apiAccess: plan.api_access_enabled,
        advancedAnalytics: plan.advanced_analytics_enabled,
        customReports: plan.custom_reports_enabled,
        interactiveMaps: plan.interactive_maps_enabled,
        bulkOperations: plan.bulk_operations_enabled,
        whiteLabel: plan.white_label_enabled
      },
      history: {
        locationDays: plan.location_history_days,
        meetingDays: plan.meeting_history_days,
        expenseDays: plan.expense_history_days
      }
    }));
    
    res.json({ plans: formattedPlans });
  })
);

// ============================================
// UPGRADE COMPANY PLAN (Company Admin Only)
// ============================================
router.post(
  "/upgrade",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { planName } = req.body;
    
    if (!planName) {
      return res.status(400).json({
        error: "ValidationError",
        message: "Plan name is required"
      });
    }
    
    // Super admin cannot upgrade their own "plan"
    if (req.isSuperAdmin && !req.companyId) {
      return res.status(400).json({
        error: "NoCompanyContext",
        message: "Super admins must select a specific company to upgrade"
      });
    }
    
    const allPlans = await getAllPlans();
    const planExists = allPlans.some(p => p.plan_name === planName);
    
    if (!planExists) {
      return res.status(400).json({
        error: "InvalidPlan",
        message: `Plan '${planName}' does not exist`,
        availablePlans: allPlans.map(p => p.plan_name)
      });
    }

    await upgradeCompanyPlan(req.companyId, planName);
    const newFeatures = await getCompanyPlanFeatures(req.companyId);
    
    console.log(`✅ Company ${req.companyId} upgraded to ${planName} by user ${req.user.email}`);
    
    res.json({
      message: "Plan upgraded successfully",
      newPlan: newFeatures,
      effectiveImmediately: true
    });
  })
);

// ============================================
// GET PLAN USAGE DETAILS (Company Admin Only)
// ============================================
router.get(
  "/usage",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Super admin without company context
    if (req.isSuperAdmin && !req.companyId) {
      return res.json({
        planName: 'super_admin',
        limits: {},
        currentUsage: {},
        warnings: {},
        message: 'Super admin has unlimited access'
      });
    }

    const usage = await getCompanyUsage(req.companyId);
    const features = await getCompanyPlanFeatures(req.companyId);
    const userLimit = await checkUserLimit(req.companyId);
    const clientLimit = await checkClientLimit(req.companyId);
    
    res.json({
      planName: features.planName,
      limits: features.limits,
      currentUsage: usage,
      warnings: {
        usersNearLimit: userLimit.currentUsers >= userLimit.maxUsers * 0.8,
        clientsNearLimit: !clientLimit.unlimited && clientLimit.currentClients >= clientLimit.maxClients * 0.8
      }
    });
  })
);

// ============================================
// SUPER ADMIN: SET ANY COMPANY'S PLAN
// ============================================
router.post(
  "/admin/set-plan/:companyId",
  authenticateToken,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { planName } = req.body;
    
    if (!planName) {
      return res.status(400).json({
        error: "ValidationError",
        message: "Plan name is required"
      });
    }

    await upgradeCompanyPlan(companyId, planName);
    const newFeatures = await getCompanyPlanFeatures(companyId);
    
    console.log(`👑 Super Admin ${req.user.email} set company ${companyId} to ${planName}`);
    
    res.json({
      message: "Plan updated successfully",
      companyId,
      newPlan: newFeatures
    });
  })
);

// ============================================
// SUPER ADMIN: GET ALL PLANS WITH DETAILS
// ============================================
router.get(
  "/admin/all-plans",
  authenticateToken,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const plans = await getAllPlans();
    res.json({ 
      plans,
      totalPlans: plans.length 
    });
  })
);

export default router;