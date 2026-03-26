// middleware/company.js
// Company context middleware - attaches companyId to requests

import { pool } from "../db.js";

/**
 * Attach company context to request
 * Super admins can optionally switch companies via header
 */
export const attachCompanyContext = async (req, res, next) => {
  try {
    console.log(`🔍 [attachCompanyContext] Starting for user: ${req.user?.id || 'NO USER'}`);
    console.log(`🔍 [attachCompanyContext] req.user:`, req.user);
    
    // Get user's company and super admin status
    const result = await pool.query(
      `SELECT company_id, is_super_admin, is_admin 
       FROM users 
       WHERE id = $1`,
      [req.user.id]
    );

    console.log(`🔍 [attachCompanyContext] Query result:`, result.rows[0]);

    if (result.rows.length === 0) {
      console.error(`❌ [attachCompanyContext] User ${req.user.id} not found!`);
      return res.status(404).json({ 
        error: "UserNotFound",
        message: "User not found" 
      });
    }

    const user = result.rows[0];

    // Super admin can switch companies via header
    if (user.is_super_admin) {
      const requestedCompanyId = req.headers['x-company-id'];
      
      if (requestedCompanyId) {
        const companyCheck = await pool.query(
          "SELECT id, name FROM companies WHERE id = $1",
          [requestedCompanyId]
        );

        if (companyCheck.rows.length === 0) {
          return res.status(404).json({ 
            error: "CompanyNotFound",
            message: "Requested company does not exist" 
          });
        }

        req.companyId = requestedCompanyId;
        req.isSuperAdmin = true;
        req.companyName = companyCheck.rows[0].name;
        console.log(`✅ [attachCompanyContext] Super Admin accessing company: ${companyCheck.rows[0].name}`);
      } else {
        req.companyId = null;
        req.isSuperAdmin = true;
        console.log(`✅ [attachCompanyContext] Super Admin - all companies access`);
      }
    } else {
      // Regular user - must have company assigned
      if (!user.company_id) {
        console.error(`❌ [attachCompanyContext] User has no company_id!`);
        return res.status(403).json({ 
          error: "NoCompanyAssigned",
          message: "User is not assigned to any company. Contact super admin." 
        });
      }

      req.companyId = user.company_id;
      req.isSuperAdmin = false;
      console.log(`✅ [attachCompanyContext] Regular admin - company_id: ${req.companyId}`);
    }

    req.isCompanyAdmin = user.is_admin;
    
    console.log(`✅ [attachCompanyContext] Final values - companyId: ${req.companyId}, isSuperAdmin: ${req.isSuperAdmin}`);

    next();
  } catch (error) {
    console.error("❌ [attachCompanyContext] Error:", error);
    res.status(500).json({ 
      error: "FailedToLoadCompanyContext",
      message: "Failed to load company context" 
    });
  }
};

/**
 * Require super admin access
 */
export const requireSuperAdmin = async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT is_super_admin FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0 || !result.rows[0].is_super_admin) {
      return res.status(403).json({ 
        error: "SuperAdminOnly",
        message: "This action requires super admin privileges" 
      });
    }

    next();
  } catch (error) {
    console.error("❌ Super admin check error:", error);
    res.status(500).json({ error: "AuthorizationCheckFailed" });
  }
};

/**
 * Helper to build company-scoped WHERE clause
 * @param {string} companyId - Company ID from request
 * @param {boolean} isSuperAdmin - Is user super admin
 * @returns {Object} { clause: string, params: array, paramIndex: number }
 */
export const buildCompanyFilter = (companyId, isSuperAdmin) => {
  if (isSuperAdmin && !companyId) {
    // Super admin viewing all companies - no filter
    return {
      clause: "",
      params: [],
      paramIndex: 0
    };
  }

  return {
    clause: "company_id = $",
    params: [companyId],
    paramIndex: 1
  };
};