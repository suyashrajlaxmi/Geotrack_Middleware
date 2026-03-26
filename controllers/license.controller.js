// controllers/license.controller.js
// Get company license information for authenticated user

import { pool } from "../db.js";

/**
 * Get current user's company license details
 */
export const getMyCompanyLicense = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's company and license info
    const result = await pool.query(
      `SELECT 
        u.id as user_id,
        u.email,
        u.is_admin,
        u.company_id,
        c.name as company_name,
        c.subdomain as company_subdomain,
        c.settings as company_settings,
        cl.id as license_id,
        cl.license_key,
        cl.plan,
        cl.max_users,
        cl.expires_at,
        cl.created_at as license_created_at,
        -- Calculate days until expiry
        CASE 
          WHEN cl.expires_at IS NULL THEN NULL
          WHEN cl.expires_at < NOW() THEN 0
          ELSE EXTRACT(DAY FROM cl.expires_at - NOW())
        END as days_until_expiry,
        -- Check if expired
        CASE 
          WHEN cl.expires_at IS NULL THEN false
          WHEN cl.expires_at < NOW() THEN true
          ELSE false
        END as is_expired,
        -- Check if expiring soon (within 30 days)
        CASE 
          WHEN cl.expires_at IS NULL THEN false
          WHEN cl.expires_at < NOW() + INTERVAL '30 days' THEN true
          ELSE false
        END as is_expiring_soon
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      LEFT JOIN company_licenses cl ON c.id = cl.company_id
      WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: "UserNotFound",
        message: "User not found" 
      });
    }

    const data = result.rows[0];

    // Parse company settings (stored as JSON)
    let companySettings = {};
    if (data.company_settings) {
      try {
        companySettings = typeof data.company_settings === 'string' 
          ? JSON.parse(data.company_settings) 
          : data.company_settings;
      } catch (e) {
        console.error("Failed to parse company settings:", e);
      }
    }

    // Build response
    const response = {
      user: {
        id: data.user_id,
        email: data.email,
        isAdmin: data.is_admin
      },
      company: {
        id: data.company_id,
        name: data.company_name,
        subdomain: data.company_subdomain,
        settings: companySettings
      },
      license: data.license_id ? {
        id: data.license_id,
        licenseKey: data.license_key,
        plan: data.plan,
        maxUsers: data.max_users,
        expiresAt: data.expires_at,
        createdAt: data.license_created_at,
        daysUntilExpiry: data.days_until_expiry ? Math.floor(data.days_until_expiry) : null,
        isExpired: data.is_expired,
        isExpiringSoon: data.is_expiring_soon,
        status: data.is_expired ? 'expired' : 
                data.is_expiring_soon ? 'expiring_soon' : 
                'active'
      } : null
    };

    res.json(response);

  } catch (error) {
    console.error("❌ Error fetching license info:", error);
    res.status(500).json({ 
      error: "ServerError",
      message: "Failed to fetch license information" 
    });
  }
};

/**
 * Get license history (all licenses for user's company)
 */
export const getMyLicenseHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Get user's company
    const companyResult = await pool.query(
      `SELECT company_id FROM users WHERE id = $1`,
      [userId]
    );

    if (companyResult.rows.length === 0 || !companyResult.rows[0].company_id) {
      return res.status(404).json({ 
        error: "NoCompanyAssigned",
        message: "User is not assigned to any company" 
      });
    }

    const companyId = companyResult.rows[0].company_id;

    // Get all licenses for this company (if you keep history)
    // For now, this will just return the current license
    // If you want to track history, you'd need to modify the table structure
    const result = await pool.query(
      `SELECT 
        cl.id,
        cl.license_key,
        cl.plan,
        cl.max_users,
        cl.expires_at,
        cl.created_at,
        c.name as company_name,
        CASE 
          WHEN cl.expires_at IS NULL THEN 'active'
          WHEN cl.expires_at < NOW() THEN 'expired'
          ELSE 'active'
        END as status
      FROM company_licenses cl
      LEFT JOIN companies c ON cl.company_id = c.id
      WHERE cl.company_id = $1
      ORDER BY cl.created_at DESC
      LIMIT $2 OFFSET $3`,
      [companyId, limit, offset]
    );

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM company_licenses WHERE company_id = $1`,
      [companyId]
    );

    const total = parseInt(countResult.rows[0].count);

    res.json({
      history: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("❌ Error fetching license history:", error);
    res.status(500).json({ 
      error: "ServerError",
      message: "Failed to fetch license history" 
    });
  }
};

/**
 * Get current user count for the company
 */
export const getCompanyUserCount = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT 
        u.company_id,
        c.name as company_name,
        COUNT(DISTINCT u2.id) as current_users,
        cl.max_users as max_allowed_users,
        cl.max_users - COUNT(DISTINCT u2.id) as available_slots
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      LEFT JOIN company_licenses cl ON c.id = cl.company_id
      LEFT JOIN users u2 ON u2.company_id = u.company_id
      WHERE u.id = $1
      GROUP BY u.company_id, c.name, cl.max_users`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: "NoCompanyAssigned",
        message: "User is not assigned to any company" 
      });
    }

    const data = result.rows[0];

    res.json({
      companyName: data.company_name,
      currentUsers: parseInt(data.current_users),
      maxAllowedUsers: parseInt(data.max_allowed_users) || null,
      availableSlots: parseInt(data.available_slots) || null,
      isAtCapacity: data.max_allowed_users ? 
        parseInt(data.current_users) >= parseInt(data.max_allowed_users) : 
        false
    });

  } catch (error) {
    console.error("❌ Error fetching user count:", error);
    res.status(500).json({ 
      error: "ServerError",
      message: "Failed to fetch user count" 
    });
  }
};