// middleware/featureAuth.js
// Enhanced middleware with comprehensive database-based limitations

import {
  canAccessFeature,
  getCompanyPlanFeatures,
  checkUserLimit,
  checkClientLimit,
  checkClientServiceLimit,
  checkMeetingAttachmentLimit,
  checkExpenseReceiptLimit,
  checkImportBatchSize,
  logFeatureUsage
} from "../services/plan.service.js";

/**
 * Require specific feature access
 * Usage: router.get('/analytics', requireFeature('advancedAnalytics'))
 */
export const requireFeature = (featureName) => {
  return async (req, res, next) => {
    try {
      if (!req.companyId) {
        return res.status(403).json({
          error: "NoCompany",
          message: "Company context required"
        });
      }

      // Super admins bypass restrictions
      if (req.isSuperAdmin) {
        return next();
      }

      const hasAccess = await canAccessFeature(req.companyId, featureName);
      
      if (!hasAccess) {
        const plan = await getCompanyPlanFeatures(req.companyId);
        
        // Log blocked access
        await logFeatureUsage(
          req.companyId,
          req.user.id,
          featureName,
          'blocked',
          { planName: plan.planName }
        );
        
        return res.status(403).json({
          error: "FeatureNotAvailable",
          message: `This feature is not available in your ${plan.displayName} plan`,
          currentPlan: plan.planName,
          feature: featureName,
          upgradeRequired: true,
          upgradeUrl: `/plans/upgrade?feature=${featureName}`
        });
      }

      // Log successful access
      await logFeatureUsage(
        req.companyId,
        req.user.id,
        featureName,
        'accessed'
      );

      next();
    } catch (error) {
      console.error("❌ Feature auth error:", error);
      res.status(500).json({ error: "FeatureAuthFailed" });
    }
  };
};

/**
 * Check user creation limit
 */
export const checkUserCreationLimit = async (req, res, next) => {
  try {
    if (!req.companyId || req.isSuperAdmin) {
      return next();
    }

    const limitCheck = await checkUserLimit(req.companyId);
    
    if (limitCheck.hasReachedLimit) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(403).json({
        error: "UserLimitReached",
        message: `You have reached the maximum number of users (${limitCheck.maxUsers}) for your ${plan.displayName} plan`,
        currentUsers: limitCheck.currentUsers,
        maxUsers: limitCheck.maxUsers,
        upgradeRequired: true,
        currentPlan: plan.planName
      });
    }

    next();
  } catch (error) {
    console.error("❌ User limit check error:", error);
    res.status(500).json({ error: "UserLimitCheckFailed" });
  }
};

/**
 * Check client creation limit
 */
export const checkClientCreationLimit = async (req, res, next) => {
  try {
    if (!req.companyId || req.isSuperAdmin) {
      return next();
    }

    const limitCheck = await checkClientLimit(req.companyId);
    
    if (limitCheck.hasReachedLimit) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(403).json({
        error: "ClientLimitReached",
        message: `You have reached the maximum number of clients (${limitCheck.maxClients}) for your ${plan.displayName} plan`,
        currentClients: limitCheck.currentClients,
        maxClients: limitCheck.maxClients,
        upgradeRequired: true,
        currentPlan: plan.planName
      });
    }

    next();
  } catch (error) {
    console.error("❌ Client limit check error:", error);
    res.status(500).json({ error: "ClientLimitCheckFailed" });
  }
};

/**
 * Check client service limit
 */
export const checkServiceCreationLimit = async (req, res, next) => {
  try {
    if (!req.companyId || req.isSuperAdmin) {
      return next();
    }

    const clientId = req.params.clientId || req.body.clientId;
    
    if (!clientId) {
      return res.status(400).json({ error: "ClientIdRequired" });
    }

    const limitCheck = await checkClientServiceLimit(req.companyId, clientId);
    
    if (!limitCheck.allowed) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      if (limitCheck.reason) {
        return res.status(403).json({
          error: "FeatureNotAvailable",
          message: limitCheck.reason,
          currentPlan: plan.planName,
          upgradeRequired: true
        });
      }
      
      return res.status(403).json({
        error: "ServiceLimitReached",
        message: `You have reached the maximum number of services (${limitCheck.maxServices}) per client for your ${plan.displayName} plan`,
        currentServices: limitCheck.currentServices,
        maxServices: limitCheck.maxServices,
        upgradeRequired: true
      });
    }

    next();
  } catch (error) {
    console.error("❌ Service limit check error:", error);
    res.status(500).json({ error: "ServiceLimitCheckFailed" });
  }
};

/**
 * Validate Excel import batch size
 */
export const validateImportBatchSize = async (req, res, next) => {
  try {
    if (!req.companyId || req.isSuperAdmin) {
      return next();
    }

    // This will be called after multer processes the file
    if (!req.file) {
      return next();
    }

    // Parse the Excel to get row count (you'd need to implement this)
    // For now, we'll estimate or parse it
    const xlsx = await import('xlsx');
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);
    const batchSize = rows.length;

    const limitCheck = await checkImportBatchSize(req.companyId, batchSize);
    
    if (!limitCheck.allowed) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(403).json({
        error: "ImportBatchTooLarge",
        message: `Your import contains ${batchSize} rows, but your ${plan.displayName} plan allows maximum ${limitCheck.maxBatchSize} rows per import`,
        requestedSize: batchSize,
        maxBatchSize: limitCheck.maxBatchSize,
        exceededBy: limitCheck.exceededBy,
        upgradeRequired: true,
        suggestion: `Please split your import into smaller batches of ${limitCheck.maxBatchSize} rows or upgrade your plan`
      });
    }

    next();
  } catch (error) {
    console.error("❌ Import batch size check error:", error);
    // Don't block on this error, let it proceed
    next();
  }
};

/**
 * Check meeting attachment limit
 */
export const checkMeetingAttachmentUpload = async (req, res, next) => {
  try {
    if (!req.companyId || req.isSuperAdmin) {
      return next();
    }

    const meetingId = req.params.id;
    
    if (!meetingId) {
      return res.status(400).json({ error: "MeetingIdRequired" });
    }

    const limitCheck = await checkMeetingAttachmentLimit(req.companyId, meetingId);
    
    if (!limitCheck.allowed) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(403).json({
        error: "AttachmentLimitReached",
        message: `You have reached the maximum number of attachments (${limitCheck.maxAttachments}) per meeting for your ${plan.displayName} plan`,
        currentAttachments: limitCheck.currentAttachments,
        maxAttachments: limitCheck.maxAttachments,
        upgradeRequired: true
      });
    }

    // Also check file size
    if (req.file && req.file.size > limitCheck.maxSizeMB * 1024 * 1024) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(413).json({
        error: "FileTooLarge",
        message: `File size exceeds the maximum allowed (${limitCheck.maxSizeMB}MB) for your ${plan.displayName} plan`,
        fileSize: (req.file.size / (1024 * 1024)).toFixed(2) + 'MB',
        maxSize: limitCheck.maxSizeMB + 'MB',
        upgradeRequired: true
      });
    }

    next();
  } catch (error) {
    console.error("❌ Attachment limit check error:", error);
    res.status(500).json({ error: "AttachmentLimitCheckFailed" });
  }
};

/**
 * Check expense receipt limit
 */
export const checkExpenseReceiptUpload = async (req, res, next) => {
  try {
    if (!req.companyId || req.isSuperAdmin) {
      return next();
    }

    const expenseId = req.params.id || req.body.expenseId;
    
    const limitCheck = await checkExpenseReceiptLimit(req.companyId, expenseId);
    
    if (!limitCheck.allowed) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(403).json({
        error: "ReceiptLimitReached",
        message: `You have reached the maximum number of receipt images (${limitCheck.maxImages}) per expense for your ${plan.displayName} plan`,
        currentImages: limitCheck.currentImages,
        maxImages: limitCheck.maxImages,
        upgradeRequired: true
      });
    }

    // Check file size
    if (req.file && req.file.size > limitCheck.maxSizeMB * 1024 * 1024) {
      const plan = await getCompanyPlanFeatures(req.companyId);
      
      return res.status(413).json({
        error: "FileTooLarge",
        message: `File size exceeds the maximum allowed (${limitCheck.maxSizeMB}MB) for your ${plan.displayName} plan`,
        fileSize: (req.file.size / (1024 * 1024)).toFixed(2) + 'MB',
        maxSize: limitCheck.maxSizeMB + 'MB',
        upgradeRequired: true
      });
    }

    next();
  } catch (error) {
    console.error("❌ Receipt limit check error:", error);
    res.status(500).json({ error: "ReceiptLimitCheckFailed" });
  }
};

/**
 * Attach plan features to request
 */
export const attachPlanFeatures = async (req, res, next) => {
  try {
    if (!req.companyId) {
      return next();
    }

    const features = await getCompanyPlanFeatures(req.companyId);
    req.planFeatures = features;
    
    next();
  } catch (error) {
    console.error("❌ Error attaching plan features:", error);
    next();
  }
};