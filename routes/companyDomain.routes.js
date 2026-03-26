// routes/companyDomain.routes.js
// NEW FILE: Company email domain management routes

import express from "express";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { attachCompanyContext, requireSuperAdmin } from "../middleware/company.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import {
  setCompanyEmailDomain,
  removeCompanyEmailDomain,
  getAllCompanyDomains,
  findCompanyByEmailDomain,
  isGenericEmailDomain
} from "../services/emailDomain.service.js";
import { pool } from "../db.js";

const router = express.Router();

// ============================================
// COMPANY ADMIN: Manage Own Email Domain
// ============================================

/**
 * Get current company's email domain
 */
router.get(
  "/my-domain",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, subdomain, email_domain 
       FROM companies 
       WHERE id = $1`,
      [req.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "CompanyNotFound" });
    }

    const company = result.rows[0];

    res.json({
      companyId: company.id,
      companyName: company.name,
      subdomain: company.subdomain,
      emailDomain: company.email_domain,
      configured: !!company.email_domain
    });
  })
);

/**
 * Set/Update company email domain
 */
router.post(
  "/set-domain",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { emailDomain } = req.body;

    if (!emailDomain) {
      return res.status(400).json({
        error: "ValidationError",
        message: "Email domain is required"
      });
    }

    // Validate format
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(emailDomain)) {
      return res.status(400).json({
        error: "InvalidDomain",
        message: "Invalid email domain format. Example: acme-corp.com"
      });
    }

    // Check if generic
    if (isGenericEmailDomain(`test@${emailDomain}`)) {
      return res.status(400).json({
        error: "GenericDomainNotAllowed",
        message: "Cannot use generic email domains (gmail.com, yahoo.com, etc.)"
      });
    }

    try {
      await setCompanyEmailDomain(req.companyId, emailDomain);

      const updated = await pool.query(
        'SELECT email_domain FROM companies WHERE id = $1',
        [req.companyId]
      );

      console.log(`✅ Company ${req.companyId} email domain set to: ${emailDomain}`);

      res.json({
        message: "EmailDomainSet",
        emailDomain: updated.rows[0].email_domain,
        instructions: `Users with @${emailDomain} emails will now be automatically assigned to your company when they sign up`
      });
    } catch (error) {
      return res.status(400).json({
        error: "SetDomainFailed",
        message: error.message
      });
    }
  })
);

/**
 * Remove company email domain
 */
router.delete(
  "/remove-domain",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await removeCompanyEmailDomain(req.companyId);

    console.log(`🗑️ Company ${req.companyId} email domain removed`);

    res.json({
      message: "EmailDomainRemoved",
      note: "New users will no longer be automatically assigned to your company"
    });
  })
);

/**
 * Check if an email domain is available
 */
router.post(
  "/check-domain",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { emailDomain } = req.body;

    if (!emailDomain) {
      return res.status(400).json({ error: "EmailDomainRequired" });
    }

    // Check if generic
    if (isGenericEmailDomain(`test@${emailDomain}`)) {
      return res.json({
        available: false,
        reason: "GenericDomain",
        message: "Generic email domains cannot be registered"
      });
    }

    // Check if already taken
    const existing = await pool.query(
      'SELECT id, name FROM companies WHERE email_domain = $1',
      [emailDomain.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return res.json({
        available: false,
        reason: "AlreadyTaken",
        message: `Domain is already registered to ${existing.rows[0].name}`,
        takenBy: existing.rows[0].name
      });
    }

    res.json({
      available: true,
      domain: emailDomain.toLowerCase()
    });
  })
);

/**
 * Get all users from company email domain (preview before claiming)
 */
router.post(
  "/preview-users",
  authenticateToken,
  attachCompanyContext,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { emailDomain } = req.body;

    if (!emailDomain) {
      return res.status(400).json({ error: "EmailDomainRequired" });
    }

    // Find users with this email domain who are not assigned to any company
    const users = await pool.query(
      `SELECT id, email, created_at, is_trial_user
       FROM users
       WHERE email LIKE $1
       AND (company_id IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [`%@${emailDomain}`, req.companyId]
    );

    res.json({
      domain: emailDomain,
      totalUsers: users.rows.length,
      users: users.rows,
      message: users.rows.length > 0 
        ? `${users.rows.length} user(s) will be automatically assigned to your company`
        : "No existing users with this domain"
    });
  })
);

// ============================================
// SUPER ADMIN: View All Domains
// ============================================

/**
 * Get all company email domains (Super Admin only)
 */
router.get(
  "/all-domains",
  authenticateToken,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const domains = await getAllCompanyDomains();

    res.json({
      totalCompanies: domains.length,
      domains: domains.map(d => ({
        companyId: d.id,
        companyName: d.name,
        subdomain: d.subdomain,
        emailDomain: d.email_domain,
        isActive: d.is_active
      }))
    });
  })
);

/**
 * Lookup which company owns a specific domain (Super Admin only)
 */
router.post(
  "/lookup-domain",
  authenticateToken,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "EmailRequired" });
    }

    const isGeneric = isGenericEmailDomain(email);

    if (isGeneric) {
      return res.json({
        found: false,
        generic: true,
        message: "This is a generic email domain (gmail, yahoo, etc.)"
      });
    }

    const company = await findCompanyByEmailDomain(email);

    if (!company) {
      return res.json({
        found: false,
        generic: false,
        message: "No company registered with this email domain"
      });
    }

    res.json({
      found: true,
      company: {
        id: company.id,
        name: company.name,
        subdomain: company.subdomain,
        emailDomain: company.email_domain,
        isActive: company.is_active,
        currentPlan: company.current_plan
      }
    });
  })
);

export default router;