// controllers/company.controller.js
// Super admin functions for managing companies

import { pool } from "../db.js";

/**
 * Create new company (Super Admin only)
 */
export const createCompany = async (req, res) => {
  const { name, subdomain, settings, email, emailDomain } = req.body;

  if (!name || !subdomain) {
    return res.status(400).json({ 
      error: "ValidationError",
      message: "Company name and subdomain are required" 
    });
  }

  // Validate subdomain format (lowercase, alphanumeric, hyphens only)
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({ 
      error: "InvalidSubdomain",
      message: "Subdomain must contain only lowercase letters, numbers, and hyphens" 
    });
  }

  // ✅ NEW: Extract email domain if admin email provided
  let companyEmailDomain = emailDomain; // Allow explicit override
  
  if (!companyEmailDomain && email) {
    try {
      companyEmailDomain = extractDomain(email);
      console.log(`📧 Extracted email domain from admin email: ${companyEmailDomain}`);
    } catch (error) {
      console.log(`⚠️ Could not extract email domain from ${email}`);
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO companies (name, subdomain, email_domain, settings, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [name, subdomain.toLowerCase(), companyEmailDomain || null, settings || {}]
    );

    console.log(`✅ Company created: ${name} (@${subdomain})`);
    if (companyEmailDomain) {
      console.log(`   📧 Email domain set: ${companyEmailDomain}`);
    }

    res.status(201).json({
      message: "CompanyCreated",
      company: result.rows[0],
      emailDomainSet: !!companyEmailDomain
    });
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      if (error.constraint?.includes('email_domain')) {
        return res.status(409).json({ 
          error: "EmailDomainExists",
          message: "A company with this email domain already exists" 
        });
      }
      return res.status(409).json({ 
        error: "SubdomainExists",
        message: "A company with this subdomain already exists" 
      });
    }
    throw error;
  }
};

/**
 * Get all companies with counts (Super Admin only)
 */
export const getAllCompanies = async (req, res) => {
  const { page = 1, limit = 50, search, status } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT 
      c.id,
      c.name,
      c.subdomain,
      c.is_active,
      c.created_at,
      c.updated_at,
      c.settings,
      COUNT(DISTINCT u.id) as user_count,
      COUNT(DISTINCT cl.id) as client_count,
      COUNT(DISTINCT cs.id) as service_count
    FROM companies c
    LEFT JOIN users u ON u.company_id = c.id
    LEFT JOIN clients cl ON cl.company_id = c.id
    LEFT JOIN client_services cs ON cs.company_id = c.id
    WHERE 1=1
  `;

  const params = [];
  let paramCount = 0;

  if (status === "active" || status === "inactive") {
    paramCount++;
    query += ` AND c.is_active = $${paramCount}`;
    params.push(status === "active");
  }

  if (search) {
    paramCount++;
    query += ` AND (c.name ILIKE $${paramCount} OR c.subdomain ILIKE $${paramCount})`;
    params.push(`%${search}%`);
  }

  query += `
    GROUP BY c.id
    ORDER BY c.created_at DESC
    LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
  `;

  params.push(limit, offset);

  const result = await pool.query(query, params);

  const countResult = await pool.query("SELECT COUNT(*) FROM companies");
  const total = parseInt(countResult.rows[0].count);

  res.json({
    companies: result.rows,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};


/**
 * Get all users in a company (Super Admin only)
 */
export const getCompanyUsers = async (req, res) => {
  const { companyId } = req.params;

  const result = await pool.query(
    `SELECT 
       u.id,
       u.email,
       u.is_admin,
       u.is_super_admin,
       u.created_at,
       p.full_name,
       p.department,
       p.work_hours_start,
       p.work_hours_end
     FROM users u
     LEFT JOIN profiles p ON u.id = p.user_id
     WHERE u.company_id = $1
     ORDER BY u.created_at DESC`,
    [companyId]
  );

  res.json({ users: result.rows });
};

/**
 * Get all clients in a company (Super Admin only)
 */
export const getCompanyClients = async (req, res) => {
  const { companyId } = req.params;

  const result = await pool.query(
    `SELECT 
       id,
       name,
       email,
       phone,
       status,
       pincode,
       latitude,
       longitude,
       created_at
     FROM clients
     WHERE company_id = $1
     ORDER BY created_at DESC`,
    [companyId]
  );

  res.json({ clients: result.rows });
};

/**
 * Get single company details (Super Admin only)
 */
export const getCompanyById = async (req, res) => {
  const { companyId } = req.params;

  const result = await pool.query(
    `SELECT 
       c.*,
       COUNT(DISTINCT u.id) as user_count,
       COUNT(DISTINCT cl.id) as client_count,
       COUNT(DISTINCT m.id) as meeting_count,
       COUNT(DISTINCT cs.id) as service_count
     FROM companies c
     LEFT JOIN users u ON u.company_id = c.id
     LEFT JOIN clients cl ON cl.company_id = c.id
     LEFT JOIN meetings m ON m.company_id = c.id
     LEFT JOIN client_services cs ON cs.company_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [companyId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ 
      error: "CompanyNotFound",
      message: "Company not found" 
    });
  }

  res.json({ company: result.rows[0] });
};

/**
 * Update company (Super Admin only)
 */
export const updateCompany = async (req, res) => {
  const { companyId } = req.params;
  const { name, subdomain, settings, isActive } = req.body;

  try {
    const result = await pool.query(
      `UPDATE companies 
       SET name = COALESCE($1, name),
           subdomain = COALESCE($2, subdomain),
           settings = COALESCE($3, settings),
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [name, subdomain?.toLowerCase(), settings, isActive, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: "CompanyNotFound",
        message: "Company not found" 
      });
    }

    console.log(`✅ Company updated: ${result.rows[0].name}`);

    res.json({
      message: "CompanyUpdated",
      company: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ 
        error: "SubdomainExists",
        message: "This subdomain is already taken" 
      });
    }
    throw error;
  }
};

/**
 * Delete company (Super Admin only - DANGEROUS)
 */
export const deleteCompany = async (req, res) => {
  const { companyId } = req.params;

  // Check if company exists
  const companyCheck = await pool.query(
    "SELECT name FROM companies WHERE id = $1",
    [companyId]
  );

  if (companyCheck.rows.length === 0) {
    return res.status(404).json({ 
      error: "CompanyNotFound",
      message: "Company not found" 
    });
  }

  // Check if company has users
  const userCheck = await pool.query(
    "SELECT COUNT(*) FROM users WHERE company_id = $1",
    [companyId]
  );

  const userCount = parseInt(userCheck.rows[0].count);

  if (userCount > 0) {
    return res.status(400).json({ 
      error: "CompanyHasUsers",
      message: `Cannot delete company with ${userCount} users. Reassign or delete users first.` 
    });
  }

  // Delete company (CASCADE will delete all related data)
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);

  console.log(`🗑️ Company deleted: ${companyCheck.rows[0].name}`);

  res.json({ 
    message: "CompanyDeleted",
    companyName: companyCheck.rows[0].name 
  });
};

/**
 * Assign user to company (Super Admin only)
 */
export const assignUserToCompany = async (req, res) => {
  const { userId, companyId } = req.body;

  if (!userId || !companyId) {
    return res.status(400).json({ 
      error: "ValidationError",
      message: "User ID and Company ID are required" 
    });
  }

  // Verify user exists
  const userCheck = await pool.query(
    "SELECT email FROM users WHERE id = $1",
    [userId]
  );

  if (userCheck.rows.length === 0) {
    return res.status(404).json({ error: "UserNotFound" });
  }

  // Verify company exists
  const companyCheck = await pool.query(
    "SELECT name FROM companies WHERE id = $1",
    [companyId]
  );

  if (companyCheck.rows.length === 0) {
    return res.status(404).json({ error: "CompanyNotFound" });
  }

  // Assign user to company
  await pool.query(
    "UPDATE users SET company_id = $1 WHERE id = $2",
    [companyId, userId]
  );

  console.log(`✅ User ${userCheck.rows[0].email} assigned to ${companyCheck.rows[0].name}`);

  res.json({ 
    message: "UserAssignedToCompany",
    user: userCheck.rows[0].email,
    company: companyCheck.rows[0].name
  });
};

/**
 * Promote user to super admin (Super Admin only)
 */
export const promoteSuperAdmin = async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "UserIdRequired" });
  }

  const result = await pool.query(
    `UPDATE users 
     SET is_super_admin = true 
     WHERE id = $1 
     RETURNING email, is_super_admin`,
    [userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "UserNotFound" });
  }

  console.log(`👑 User promoted to Super Admin: ${result.rows[0].email}`);

  res.json({ 
    message: "UserPromotedToSuperAdmin",
    email: result.rows[0].email 
  });
};

/**
 * Revoke super admin (Super Admin only)
 */
export const revokeSuperAdmin = async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "UserIdRequired" });
  }

  // Prevent self-revocation
  if (userId === req.user.id) {
    return res.status(400).json({ 
      error: "CannotRevokeSelf",
      message: "You cannot revoke your own super admin privileges" 
    });
  }

  const result = await pool.query(
    `UPDATE users 
     SET is_super_admin = false 
     WHERE id = $1 
     RETURNING email`,
    [userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "UserNotFound" });
  }

  console.log(`⬇️ Super Admin revoked: ${result.rows[0].email}`);

  res.json({ 
    message: "SuperAdminRevoked",
    email: result.rows[0].email 
  });
};

/**
 * Get company statistics (Super Admin dashboard)
 */
export const getCompanyStats = async (req, res) => {
  const stats = await pool.query(`
    SELECT 
      COUNT(*) as total_companies,
      COUNT(*) FILTER (WHERE is_active = true) as active_companies,
      COUNT(*) FILTER (WHERE is_active = false) as inactive_companies
    FROM companies
  `);

  const userStats = await pool.query(`
    SELECT 
      c.id as company_id,
      c.name as company_name,
      c.subdomain,
      COUNT(u.id) as user_count,
      COUNT(u.id) FILTER (WHERE u.is_admin = true) as admin_count
    FROM companies c
    LEFT JOIN users u ON u.company_id = c.id
    GROUP BY c.id, c.name, c.subdomain
    ORDER BY user_count DESC
  `);

  res.json({
    overview: stats.rows[0],
    companyBreakdown: userStats.rows
  });
};

