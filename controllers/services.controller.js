// controllers/services.controller.js
// UPDATED: All queries now filter by company_id

import { pool } from "../db.js";

// Get services for ONE specific client
export const getClientServices = async (req, res) => {
  const { clientId } = req.params;
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  try {
    // ✅ UPDATED: Verify client exists in user's company
    const clientCheck = await pool.query(
      'SELECT id FROM clients WHERE id = $1 AND company_id = $2',
      [clientId, req.companyId]
    );

    if (clientCheck.rows.length === 0) {
      return res.json({
        services: [],
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
      });
    }

    // ✅ UPDATED: Add company_id filter
    let query = `
      SELECT 
        cs.*,
        u1.email as "createdByEmail",
        u2.email as "updatedByEmail",
        c.name as "clientName"
      FROM client_services cs
      LEFT JOIN users u1 ON cs.created_by = u1.id
      LEFT JOIN users u2 ON cs.updated_by = u2.id
      LEFT JOIN clients c ON cs.client_id = c.id
      WHERE cs.client_id = $1 AND cs.company_id = $2
    `;
    const params = [clientId, req.companyId];
    let paramCount = 2;

    if (status) {
      paramCount++;
      query += ` AND cs.status = $${paramCount}`;
      params.push(status);
    }

    query += ` ORDER BY cs.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // ✅ UPDATED: Add company_id filter to count query
    const countQuery = `SELECT COUNT(*) FROM client_services WHERE client_id = $1 AND company_id = $2`;
    const countResult = await pool.query(countQuery, [clientId, req.companyId]);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      services: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Error fetching client services:", error);
    res.json({
      services: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        totalPages: 0
      }
    });
  }
};

// Get ALL services across ALL clients (within company)
export const getAllServices = async (req, res) => {
  const { status, page = 1, limit = 5000 } = req.query;
  const offset = (page - 1) * limit;

  try {
    // ✅ UPDATED: Add company_id filter
    let query = `
      SELECT 
        cs.id,
        cs.service_name,
        cs.description,
        cs.status,
        cs.start_date,
        cs.expiry_date,
        cs.price,
        cs.notes,
        cs.created_at,
        cs.updated_at,
        cs.client_id,
        c.name as "clientName",
        c.email as "clientEmail",
        c.phone as "clientPhone",
        u1.email as "createdByEmail"
      FROM client_services cs
      LEFT JOIN clients c ON cs.client_id = c.id
      LEFT JOIN users u1 ON cs.created_by = u1.id
      WHERE cs.company_id = $1
    `;
    const params = [req.companyId];
    let paramCount = 1;

    if (status) {
      paramCount++;
      query += ` AND cs.status = $${paramCount}`;
      params.push(status);
    }

    query += ` ORDER BY cs.expiry_date ASC NULLS LAST LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // ✅ UPDATED: Add company_id filter to count query
    let countQuery = `SELECT COUNT(*) FROM client_services cs WHERE cs.company_id = $1`;
    const countParams = [req.companyId];
    
    if (status) {
      countQuery += ` AND cs.status = $2`;
      countParams.push(status);
    }
    
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    console.log(`✅ Fetched ${result.rows.length} services (Total: ${total})`);

    res.json({
      services: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Error fetching all services:", error);
    res.status(500).json({ 
      error: "Failed to fetch services", 
      message: error.message 
    });
  }
};

// Create new service
export const createService = async (req, res) => {
  const { clientId } = req.params;
  const {
    serviceName,
    description,
    startDate,
    expiryDate,
    price,
    notes,
    status = 'active'
  } = req.body;

  if (!serviceName) {
    return res.status(400).json({ error: "Service name is required" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ✅ UPDATED: Verify client exists in user's company
    const clientCheck = await client.query(
      'SELECT id FROM clients WHERE id = $1 AND company_id = $2',
      [clientId, req.companyId]
    );

    if (clientCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Client not found" });
    }

    // ✅ UPDATED: Include company_id in INSERT
    const result = await client.query(
      `INSERT INTO client_services 
       (client_id, service_name, description, status, start_date, expiry_date, price, notes, created_by, updated_by, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
       RETURNING *`,
      [
        clientId,
        serviceName,
        description || null,
        status,
        startDate || new Date(),
        expiryDate || null,
        price || null,
        notes || null,
        req.user.id,
        req.companyId
      ]
    );

    // ✅ UPDATED: Include company_id in history INSERT
    await client.query(
      `INSERT INTO client_service_history (service_id, action, changed_by, changes, company_id)
       VALUES ($1, 'created', $2, $3, $4)`,
      [
        result.rows[0].id,
        req.user.id,
        JSON.stringify(result.rows[0]),
        req.companyId
      ]
    );

    await client.query('COMMIT');

    console.log(`✅ Service created: ${result.rows[0].id} for client ${clientId}`);

    res.status(201).json({
      message: "Service created successfully",
      service: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error creating service:", error);
    res.status(500).json({ error: "Failed to create service", message: error.message });
  } finally {
    client.release();
  }
};

// Update service
export const updateService = async (req, res) => {
  const { serviceId } = req.params;
  const {
    serviceName,
    description,
    status,
    startDate,
    expiryDate,
    price,
    notes
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ✅ UPDATED: Verify service exists in user's company
    const currentResult = await client.query(
      'SELECT * FROM client_services WHERE id = $1 AND company_id = $2',
      [serviceId, req.companyId]
    );

    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Service not found" });
    }

    const oldService = currentResult.rows[0];

    const result = await client.query(
      `UPDATE client_services 
       SET 
         service_name = COALESCE($1, service_name),
         description = COALESCE($2, description),
         status = COALESCE($3, status),
         start_date = COALESCE($4, start_date),
         expiry_date = COALESCE($5, expiry_date),
         price = COALESCE($6, price),
         notes = COALESCE($7, notes),
         updated_by = $8
       WHERE id = $9
       RETURNING *`,
      [
        serviceName || null,
        description || null,
        status || null,
        startDate || null,
        expiryDate || null,
        price || null,
        notes || null,
        req.user.id,
        serviceId
      ]
    );

    const changes = {};
    Object.keys(result.rows[0]).forEach(key => {
      if (oldService[key] !== result.rows[0][key] && 
          !['updated_at', 'updated_by'].includes(key)) {
        changes[key] = {
          old: oldService[key],
          new: result.rows[0][key]
        };
      }
    });

    // ✅ UPDATED: Include company_id in history INSERT
    await client.query(
      `INSERT INTO client_service_history (service_id, action, changed_by, changes, company_id)
       VALUES ($1, 'updated', $2, $3, $4)`,
      [serviceId, req.user.id, JSON.stringify(changes), req.companyId]
    );

    await client.query('COMMIT');

    console.log(`✅ Service updated: ${serviceId}`);

    res.json({
      message: "Service updated successfully",
      service: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error updating service:", error);
    res.status(500).json({ error: "Failed to update service", message: error.message });
  } finally {
    client.release();
  }
};

// Delete service
export const deleteService = async (req, res) => {
  const { serviceId } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ✅ UPDATED: Verify service exists in user's company
    const serviceResult = await client.query(
      'SELECT * FROM client_services WHERE id = $1 AND company_id = $2',
      [serviceId, req.companyId]
    );

    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Service not found" });
    }

    // ✅ UPDATED: Include company_id in history INSERT
    await client.query(
      `INSERT INTO client_service_history (service_id, action, changed_by, changes, company_id)
       VALUES ($1, 'deleted', $2, $3, $4)`,
      [serviceId, req.user.id, JSON.stringify(serviceResult.rows[0]), req.companyId]
    );

    await client.query('DELETE FROM client_services WHERE id = $1', [serviceId]);

    await client.query('COMMIT');

    console.log(`🗑️ Service deleted: ${serviceId}`);

    res.json({ message: "Service deleted successfully" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error deleting service:", error);
    res.status(500).json({ error: "Failed to delete service", message: error.message });
  } finally {
    client.release();
  }
};

// Get service history
export const getServiceHistory = async (req, res) => {
  const { serviceId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    // ✅ UPDATED: Add company_id filter
    const result = await pool.query(
      `SELECT 
         sh.*,
         u.email as "changedByEmail"
       FROM client_service_history sh
       LEFT JOIN users u ON sh.changed_by = u.id
       WHERE sh.service_id = $1 AND sh.company_id = $2
       ORDER BY sh.created_at DESC
       LIMIT $3 OFFSET $4`,
      [serviceId, req.companyId, limit, offset]
    );

    // ✅ UPDATED: Add company_id filter to count query
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM client_service_history WHERE service_id = $1 AND company_id = $2',
      [serviceId, req.companyId]
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
    console.error("Error fetching service history:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
};

// Get expiring services
export const getExpiringServices = async (req, res) => {
  const { days = 30 } = req.query;

  try {
    // ✅ UPDATED: Add company_id filter
    const result = await pool.query(
      `SELECT 
         cs.*,
         c.name as "clientName",
         c.email as "clientEmail",
         c.phone as "clientPhone"
       FROM client_services cs
       LEFT JOIN clients c ON cs.client_id = c.id
       WHERE cs.status = 'active'
       AND cs.company_id = $1
       AND cs.expiry_date IS NOT NULL
       AND cs.expiry_date <= NOW() + INTERVAL '${parseInt(days)} days'
       AND cs.expiry_date >= NOW()
       ORDER BY cs.expiry_date ASC`,
      [req.companyId]
    );

    res.json({ services: result.rows });
  } catch (error) {
    console.error("Error fetching expiring services:", error);
    res.status(500).json({ error: "Failed to fetch expiring services" });
  }
};