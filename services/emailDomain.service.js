// services/emailDomain.service.js
// Email domain-based company assignment logic

import { pool } from "../db.js";

/**
 * List of generic email providers that don't represent companies
 */
const GENERIC_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'aol.com',
  'protonmail.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'gmx.com',
  'tutanota.com',
  'fastmail.com',
  'hey.com',
  // Indian providers
  'rediffmail.com',
  'in.com',
  // Add more as needed
];

/**
 * Extract domain from email
 * @param {string} email 
 * @returns {string} - Domain part (e.g., "acme-corp.com")
 */
export const extractDomain = (email) => {
  if (!email || typeof email !== 'string') {
    throw new Error('Invalid email');
  }
  
  const parts = email.toLowerCase().trim().split('@');
  if (parts.length !== 2) {
    throw new Error('Invalid email format');
  }
  
  return parts[1];
};

/**
 * Check if email domain is generic (gmail, yahoo, etc.)
 * @param {string} email 
 * @returns {boolean}
 */
export const isGenericEmailDomain = (email) => {
  const domain = extractDomain(email);
  return GENERIC_EMAIL_DOMAINS.includes(domain);
};

/**
 * Find company by email domain
 * @param {string} email 
 * @returns {Promise<Object|null>} - Company object or null
 */
export const findCompanyByEmailDomain = async (email) => {
  const domain = extractDomain(email);
  
  // Don't search for generic domains
  if (GENERIC_EMAIL_DOMAINS.includes(domain)) {
    return null;
  }
  
  const result = await pool.query(
    `SELECT c.id, c.name, c.subdomain, c.email_domain, c.is_active,
            cl.plan as current_plan
     FROM companies c
     LEFT JOIN company_licenses cl ON c.id = cl.company_id
     WHERE c.email_domain = $1 AND c.is_active = true
     LIMIT 1`,
    [domain]
  );
  
  return result.rows.length > 0 ? result.rows[0] : null;
};

/**
 * Set email domain for a company
 * @param {string} companyId 
 * @param {string} emailDomain 
 */
export const setCompanyEmailDomain = async (companyId, emailDomain) => {
  // Validate domain format
  if (!emailDomain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(emailDomain)) {
    throw new Error('Invalid email domain format');
  }
  
  // Check if domain is generic
  if (GENERIC_EMAIL_DOMAINS.includes(emailDomain.toLowerCase())) {
    throw new Error('Cannot use generic email domains (gmail.com, yahoo.com, etc.)');
  }
  
  // Check if domain already used by another company
  const existing = await pool.query(
    'SELECT id, name FROM companies WHERE email_domain = $1 AND id != $2',
    [emailDomain.toLowerCase(), companyId]
  );
  
  if (existing.rows.length > 0) {
    throw new Error(`Domain ${emailDomain} is already registered to ${existing.rows[0].name}`);
  }
  
  // Set domain
  await pool.query(
    'UPDATE companies SET email_domain = $1, updated_at = NOW() WHERE id = $2',
    [emailDomain.toLowerCase(), companyId]
  );
  
  console.log(`✅ Email domain set: ${emailDomain} → Company ${companyId}`);
};

/**
 * Remove email domain from company
 * @param {string} companyId 
 */
export const removeCompanyEmailDomain = async (companyId) => {
  await pool.query(
    'UPDATE companies SET email_domain = NULL, updated_at = NOW() WHERE id = $1',
    [companyId]
  );
  
  console.log(`🗑️ Email domain removed from company ${companyId}`);
};

/**
 * Get all companies with their email domains
 */
export const getAllCompanyDomains = async () => {
  const result = await pool.query(`
    SELECT id, name, subdomain, email_domain, is_active
    FROM companies
    WHERE email_domain IS NOT NULL
    ORDER BY name
  `);
  
  return result.rows;
};

/**
 * Validate if user should be trial user
 * @param {string} email 
 * @returns {boolean}
 */
export const shouldBeTrialUser = (email) => {
  return isGenericEmailDomain(email);
};

/**
 * Get trial user restrictions
 * @returns {Object}
 */
export const getTrialUserRestrictions = () => {
  return {
    canCreate: false,        // Cannot create clients, meetings, etc.
    canEdit: false,          // Cannot edit anything
    canDelete: false,        // Cannot delete anything
    canExport: false,        // Cannot export data
    canViewAll: false,       // Can only view assigned data
    maxDataView: 10,         // Can view max 10 records
    readOnlyAccess: true,    // Purely read-only
    message: 'Trial users have read-only access. Please use your company email or contact admin.'
  };
};

/**
 * Check if user email matches their company domain
 * @param {string} email 
 * @param {string} companyId 
 * @returns {Promise<boolean>}
 */
export const doesEmailMatchCompanyDomain = async (email, companyId) => {
  const domain = extractDomain(email);
  
  const result = await pool.query(
    'SELECT email_domain FROM companies WHERE id = $1',
    [companyId]
  );
  
  if (result.rows.length === 0) {
    return false;
  }
  
  const companyDomain = result.rows[0].email_domain;
  return companyDomain && companyDomain.toLowerCase() === domain.toLowerCase();
};

/**
 * Convert trial user to full user (when they provide company email)
 * @param {string} userId 
 * @param {string} newEmail 
 * @param {string} companyId 
 */
export const convertTrialUserToFullUser = async (userId, newEmail, companyId) => {
  // Validate email matches company domain
  const matches = await doesEmailMatchCompanyDomain(newEmail, companyId);
  
  if (!matches) {
    const company = await pool.query(
      'SELECT email_domain FROM companies WHERE id = $1',
      [companyId]
    );
    throw new Error(`Email must be from company domain: @${company.rows[0].email_domain}`);
  }
  
  // Check if email already exists
  const existing = await pool.query(
    'SELECT id FROM users WHERE email = $1 AND id != $2',
    [newEmail, userId]
  );
  
  if (existing.rows.length > 0) {
    throw new Error('Email already in use');
  }
  
  // Update user
  await pool.query(
    `UPDATE users 
     SET email = $1, is_trial_user = false, updated_at = NOW()
     WHERE id = $2`,
    [newEmail, userId]
  );
  
  console.log(`✅ Trial user ${userId} converted to full user with email ${newEmail}`);
};