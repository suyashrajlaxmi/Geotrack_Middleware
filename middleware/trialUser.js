// middleware/trialUser.js
// NEW FILE: Middleware to restrict trial users

import { getTrialUserRestrictions } from "../services/emailDomain.service.js";

/**
 * Block trial users from write operations
 * Trial users (generic emails) have read-only access
 */
export const blockTrialUserWrites = (req, res, next) => {
  // Super admins and regular admins bypass this
  if (req.user.isSuperAdmin || req.user.isAdmin) {
    return next();
  }

  // Check if user is trial user
  if (req.user.isTrialUser) {
    const restrictions = getTrialUserRestrictions();
    
    return res.status(403).json({
      error: "TrialUserRestricted",
      message: restrictions.message,
      restrictions: restrictions,
      upgradeInstructions: "Please use your company email or contact your company admin to get full access"
    });
  }

  next();
};

/**
 * Allow trial users but with read-only enforcement
 * Use this for GET routes where trial users can view limited data
 */
export const enforceTrialUserLimits = (req, res, next) => {
  if (req.user.isTrialUser && !req.user.isAdmin && !req.user.isSuperAdmin) {
    // Mark request as trial user for controllers to handle
    req.isTrialUser = true;
    req.trialRestrictions = getTrialUserRestrictions();
  }

  next();
};

/**
 * Require full user (not trial)
 * Blocks trial users completely from accessing certain routes
 */
export const requireFullUser = (req, res, next) => {
  if (req.user.isTrialUser && !req.user.isSuperAdmin && !req.user.isAdmin) {
    return res.status(403).json({
      error: "FullUserRequired",
      message: "This feature requires a full company account. Please use your company email to sign up.",
      upgradeUrl: "/auth/convert-trial-user"
    });
  }

  next();
};