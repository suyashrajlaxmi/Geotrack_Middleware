// controllers/quickVisits.controller.js
import { pool } from "../db.js";

/**
 * Create a quick visit (no full meeting)
 */
// controllers/quickVisits.controller.js
export const createQuickVisit = async (req, res) => {
  const { clientId, visitType, latitude, longitude, accuracy, notes } = req.body;

  if (!clientId || !visitType) {
    return res.status(400).json({ 
      error: "MissingFields",
      message: "clientId and visitType are required" 
    });
  }

  // Validate visit type
  const validTypes = ['met_success', 'not_available', 'office_closed', 'phone_call'];
  if (!validTypes.includes(visitType)) {
    return res.status(400).json({
      error: "InvalidVisitType",
      message: `visitType must be one of: ${validTypes.join(', ')}`
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify client exists in user's company
    const clientCheck = await client.query(
      'SELECT id, name FROM clients WHERE id = $1 AND company_id = $2',
      [clientId, req.companyId]
    );

    if (clientCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "ClientNotFound" });
    }

    // Create quick visit record
    const visitResult = await client.query(
      `INSERT INTO quick_visits 
       (client_id, user_id, visit_type, latitude, longitude, accuracy, notes, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING 
         id,
         client_id as "clientId",
         user_id as "userId",
         visit_type as "visitType",
         latitude,
         longitude,
         accuracy,
         notes,
         created_at as "createdAt",
         updated_at as "updatedAt"`,
      [
        clientId,
        req.user.id,
        visitType,
        latitude || null,
        longitude || null,
        accuracy || null,
        notes || null,
        req.companyId
      ]
    );

    const quickVisit = visitResult.rows[0];

    // Update client's last visit info AND get updated client data
    const updatedClientResult = await client.query(
      `UPDATE clients 
       SET last_visit_date = NOW(),
           last_visit_type = $1,
           last_visit_notes = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING 
         id,
         name,
         phone,
         email,
         address,
         latitude,
         longitude,
         pincode,
         status,
         notes,
         created_by as "createdBy",
         created_at as "createdAt",
         updated_at as "updatedAt",
         last_visit_date as "lastVisitDate",
         last_visit_type as "lastVisitType",
         last_visit_notes as "lastVisitNotes"`,
      [visitType, notes || null, clientId]
    );

    await client.query('COMMIT');

    const updatedClient = updatedClientResult.rows[0];
    
    // ✅ Calculate hasLocation on the fly
    updatedClient.hasLocation = !!(updatedClient.latitude && updatedClient.longitude);

    console.log(`✅ Quick visit created: ${quickVisit.id} for client ${clientCheck.rows[0].name}`);

    // Return both the quick visit AND the updated client
    res.status(201).json({
      message: "QuickVisitCreated",
      quickVisit: quickVisit,
      client: updatedClient
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating quick visit:', error);
    res.status(500).json({ 
      error: "FailedToCreateQuickVisit",
      message: error.message 
    });
  } finally {
    client.release();
  }
};

/**
 * Get quick visits for a client
 */
export const getClientQuickVisits = async (req, res) => {
  const { clientId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  // Verify client exists in user's company
  const clientCheck = await pool.query(
    'SELECT id FROM clients WHERE id = $1 AND company_id = $2',
    [clientId, req.companyId]
  );

  if (clientCheck.rows.length === 0) {
    return res.status(404).json({ error: "ClientNotFound" });
  }

  const result = await pool.query(
    `SELECT 
       qv.id,
       qv.visit_type as "visitType",
       qv.latitude,
       qv.longitude,
       qv.accuracy,
       qv.notes,
       qv.created_at as "createdAt",
       u.email as "userEmail",
       p.full_name as "userName"
     FROM quick_visits qv
     LEFT JOIN users u ON qv.user_id = u.id
     LEFT JOIN profiles p ON u.id = p.user_id
     WHERE qv.client_id = $1 AND qv.company_id = $2
     ORDER BY qv.created_at DESC
     LIMIT $3 OFFSET $4`,
    [clientId, req.companyId, limit, offset]
  );

  const countResult = await pool.query(
    'SELECT COUNT(*) FROM quick_visits WHERE client_id = $1 AND company_id = $2',
    [clientId, req.companyId]
  );

  const total = parseInt(countResult.rows[0].count);

  res.json({
    visits: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
};

/**
 * Get all quick visits for current user
 */
export const getMyQuickVisits = async (req, res) => {
  const { page = 1, limit = 50, startDate, endDate } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT 
      qv.id,
      qv.visit_type as "visitType",
      qv.latitude,
      qv.longitude,
      qv.accuracy,
      qv.notes,
      qv.created_at as "createdAt",
      c.id as "clientId",
      c.name as "clientName",
      c.address as "clientAddress"
    FROM quick_visits qv
    LEFT JOIN clients c ON qv.client_id = c.id
    WHERE qv.user_id = $1 AND qv.company_id = $2
  `;
  
  const params = [req.user.id, req.companyId];
  let paramCount = 2;

  if (startDate) {
    paramCount++;
    query += ` AND qv.created_at >= $${paramCount}`;
    params.push(startDate);
  }

  if (endDate) {
    paramCount++;
    query += ` AND qv.created_at <= $${paramCount}`;
    params.push(endDate);
  }

  query += ` ORDER BY qv.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);

  res.json({
    visits: result.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit)
    }
  });
};