// controllers/expenses.controller.js
// MERGED: Multi-leg expenses + Company filtering + Trial user support

import { pool } from "../db.js";

// ============================================
// TRANSFORMATION HELPERS
// ============================================

const transformExpenseRow = (row) => ({
  id: row.id,
  user_id: row.user_id,
  trip_name: row.trip_name,
  is_multi_leg: row.is_multi_leg || false,
  start_location: row.start_location,
  end_location: row.end_location,
  travel_date: row.travel_date,
  distance_km: row.distance_km,
  transport_mode: row.transport_mode,
  amount_spent: row.amount_spent,
  currency: row.currency,
  notes: row.notes,
  receipt_images: row.receipt_images || [],
  client_id: row.client_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  legs: [] // Will be populated separately if multi-leg
});

const transformLegRow = (row) => ({
  id: row.id,
  expense_id: row.expense_id,
  leg_number: row.leg_number,
  start_location: row.start_location,
  end_location: row.end_location,
  distance_km: row.distance_km,
  transport_mode: row.transport_mode,
  amount_spent: row.amount_spent,
  notes: row.notes,
  created_at: row.created_at
});

// ============================================
// CREATE EXPENSE (BACKWARD COMPATIBLE)
// ============================================

export const createExpense = async (req, res) => {
  console.log("📦 Received expense data:", JSON.stringify(req.body, null, 2));

  const {
    tripName,
    trip_name,
    start_location,
    startLocation,
    end_location,
    endLocation,
    travel_date,
    travelDate,
    distance_km,
    distanceKm,
    transport_mode,
    transportMode,
    amount_spent,
    amountSpent,
    currency = "₹",
    notes,
    receipt_images,
    receiptImages,
    client_id,
    clientId,
    legs // NEW: Array of trip legs
  } = req.body;

  // Handle both camelCase (from Android) and snake_case
  const finalTripName = tripName || trip_name || null;
  const finalStartLocation = start_location || startLocation;
  const finalEndLocation = end_location || endLocation;
  const finalTravelDate = travel_date || travelDate;
  const finalDistanceKm = distance_km || distanceKm;
  const finalTransportMode = transport_mode || transportMode;
  const finalAmountSpent = amount_spent || amountSpent;
  const finalReceiptImages = receipt_images || receiptImages || [];
  const finalClientId = client_id || clientId || null;

  // Validate required fields
  if (!finalStartLocation) {
    console.error("❌ Missing start_location");
    return res.status(400).json({ 
      error: "MissingField", 
      message: "start_location is required" 
    });
  }

  if (!finalTravelDate) {
    console.error("❌ Missing travel_date");
    return res.status(400).json({ 
      error: "MissingField", 
      message: "travel_date is required" 
    });
  }

  if (finalDistanceKm === undefined || finalDistanceKm === null) {
    console.error("❌ Missing distance_km");
    return res.status(400).json({ 
      error: "MissingField", 
      message: "distance_km is required" 
    });
  }

  if (!finalTransportMode) {
    console.error("❌ Missing transport_mode");
    return res.status(400).json({ 
      error: "MissingField", 
      message: "transport_mode is required" 
    });
  }

  if (finalAmountSpent === undefined || finalAmountSpent === null) {
    console.error("❌ Missing amount_spent");
    return res.status(400).json({ 
      error: "MissingField", 
      message: "amount_spent is required" 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const isMultiLeg = Array.isArray(legs) && legs.length > 0;
    console.log(`📊 Multi-leg trip: ${isMultiLeg}, Legs: ${legs?.length || 0}`);

    // Insert main expense record (✅ WITH company_id)
    const expenseResult = await client.query(
      `INSERT INTO trip_expenses
      (user_id, trip_name, is_multi_leg, start_location, end_location, travel_date, 
       distance_km, transport_mode, amount_spent, currency, notes, receipt_images, client_id, company_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        req.user.id,
        finalTripName,
        isMultiLeg,
        finalStartLocation,
        finalEndLocation,
        finalTravelDate,
        finalDistanceKm,
        finalTransportMode,
        finalAmountSpent,
        currency,
        notes,
        finalReceiptImages,
        finalClientId,
        req.companyId // ✅ Added company_id
      ]
    );

    const expense = expenseResult.rows[0];
    console.log("✅ Expense created:", expense.id);

    let legsData = [];

    // If multi-leg, insert leg records
    if (isMultiLeg) {
      console.log("📄 Inserting legs...");
      for (const leg of legs) {
        const legResult = await client.query(
          `INSERT INTO trip_legs
          (expense_id, leg_number, start_location, end_location, 
           distance_km, transport_mode, amount_spent, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *`,
          [
            expense.id,
            leg.leg_number || leg.legNumber,
            leg.start_location || leg.startLocation,
            leg.end_location || leg.endLocation,
            leg.distance_km || leg.distanceKm,
            leg.transport_mode || leg.transportMode,
            leg.amount_spent || leg.amountSpent,
            leg.notes || null
          ]
        );
        legsData.push(transformLegRow(legResult.rows[0]));
        console.log(`  ✅ Leg ${leg.leg_number || leg.legNumber} inserted`);
      }
    }

    await client.query('COMMIT');

    const response = transformExpenseRow(expense);
    response.legs = legsData;

    console.log("🎉 Expense submission successful");

    res.status(201).json({
      expense: response
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error creating expense:', err);
    console.error('Stack trace:', err.stack);
    
    res.status(500).json({
      error: err.message || "Failed to create expense",
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } finally {
    client.release();
  }
};

// ============================================
// GET MY EXPENSES (with legs)
// ============================================

export const getMyExpenses = async (req, res) => {
  const { startDate, endDate, transportMode, clientId } = req.query;

  // ✅ Add company_id filter
  let query = `SELECT * FROM trip_expenses WHERE user_id = $1 AND company_id = $2`;
  const params = [req.user.id, req.companyId];
  let count = 2;

  if (startDate) {
    count++;
    query += ` AND travel_date >= $${count}`;
    params.push(startDate);
  }
  if (endDate) {
    count++;
    query += ` AND travel_date <= $${count}`;
    params.push(endDate);
  }
  if (transportMode) {
    count++;
    query += ` AND transport_mode = $${count}`;
    params.push(transportMode);
  }
  if (clientId) {
    count++;
    query += ` AND client_id = $${count}`;
    params.push(clientId);
  }

  query += ` ORDER BY travel_date DESC`;

  const result = await pool.query(query, params);
  const expenses = result.rows.map(transformExpenseRow);

  // Fetch legs for multi-leg expenses
  for (const expense of expenses) {
    if (expense.is_multi_leg) {
      const legsResult = await pool.query(
        `SELECT * FROM trip_legs WHERE expense_id = $1 ORDER BY leg_number`,
        [expense.id]
      );
      expense.legs = legsResult.rows.map(transformLegRow);
    }
  }

  res.json({
    expenses: expenses,
    total: expenses.length,
    totalAmount: expenses.reduce((sum, e) => sum + Number(e.amount_spent), 0)
  });
};

// ============================================
// GET EXPENSE BY ID (with legs)
// ============================================

export const getExpenseById = async (req, res) => {
  // ✅ Add company_id filter
  const result = await pool.query(
    `SELECT * FROM trip_expenses WHERE id = $1 AND user_id = $2 AND company_id = $3`,
    [req.params.id, req.user.id, req.companyId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "ExpenseNotFound" });
  }

  const expense = transformExpenseRow(result.rows[0]);

  // Fetch legs if multi-leg
  if (expense.is_multi_leg) {
    const legsResult = await pool.query(
      `SELECT * FROM trip_legs WHERE expense_id = $1 ORDER BY leg_number`,
      [expense.id]
    );
    expense.legs = legsResult.rows.map(transformLegRow);
  }

  res.json({ expense });
};

// ============================================
// UPDATE EXPENSE (with legs)
// ============================================

export const updateExpense = async (req, res) => {
  const {
    tripName,
    trip_name,
    start_location,
    startLocation,
    end_location,
    endLocation,
    travel_date,
    travelDate,
    distance_km,
    distanceKm,
    transport_mode,
    transportMode,
    amount_spent,
    amountSpent,
    currency = "₹",
    notes,
    receipt_images,
    receiptImages,
    client_id,
    clientId,
    legs
  } = req.body;

  const finalTripName = tripName || trip_name || null;
  const finalStartLocation = start_location || startLocation;
  const finalEndLocation = end_location || endLocation;
  const finalTravelDate = travel_date || travelDate;
  const finalDistanceKm = distance_km || distanceKm;
  const finalTransportMode = transport_mode || transportMode;
  const finalAmountSpent = amount_spent || amountSpent;
  const finalReceiptImages = receipt_images || receiptImages || [];
  const finalClientId = client_id || clientId || null;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const isMultiLeg = Array.isArray(legs) && legs.length > 0;

    // ✅ Update main expense (with company_id filter)
    const result = await client.query(
      `UPDATE trip_expenses
       SET trip_name = $1,
           is_multi_leg = $2,
           start_location = $3,
           end_location = $4,
           travel_date = $5,
           distance_km = $6,
           transport_mode = $7,
           amount_spent = $8,
           currency = $9,
           notes = $10,
           receipt_images = $11,
           client_id = $12,
           updated_at = NOW()
       WHERE id = $13 AND user_id = $14 AND company_id = $15
       RETURNING *`,
      [
        finalTripName,
        isMultiLeg,
        finalStartLocation,
        finalEndLocation,
        finalTravelDate,
        finalDistanceKm,
        finalTransportMode,
        finalAmountSpent,
        currency,
        notes,
        finalReceiptImages,
        finalClientId,
        req.params.id,
        req.user.id,
        req.companyId // ✅ Added company_id
      ]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "ExpenseNotFound" });
    }

    const expense = result.rows[0];
    let legsData = [];

    // Delete old legs and insert new ones
    if (isMultiLeg) {
      await client.query('DELETE FROM trip_legs WHERE expense_id = $1', [expense.id]);

      for (const leg of legs) {
        const legResult = await client.query(
          `INSERT INTO trip_legs
          (expense_id, leg_number, start_location, end_location, 
           distance_km, transport_mode, amount_spent, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *`,
          [
            expense.id,
            leg.leg_number || leg.legNumber,
            leg.start_location || leg.startLocation,
            leg.end_location || leg.endLocation,
            leg.distance_km || leg.distanceKm,
            leg.transport_mode || leg.transportMode,
            leg.amount_spent || leg.amountSpent,
            leg.notes || null
          ]
        );
        legsData.push(transformLegRow(legResult.rows[0]));
      }
    }

    await client.query('COMMIT');

    const response = transformExpenseRow(expense);
    response.legs = legsData;

    res.json({
      message: "Expense updated successfully",
      expense: response
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating expense:', err);
    throw err;
  } finally {
    client.release();
  }
};

// ============================================
// DELETE EXPENSE (cascades to legs automatically)
// ============================================

export const deleteExpense = async (req, res) => {
  // ✅ Add company_id filter
  const result = await pool.query(
    `DELETE FROM trip_expenses WHERE id = $1 AND user_id = $2 AND company_id = $3 RETURNING id`,
    [req.params.id, req.user.id, req.companyId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "ExpenseNotFound" });
  }

  res.status(204).send();
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

export const getMyTotal = async (req, res) => {
  // ✅ Add company_id filter
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount_spent), 0) as total_amount
     FROM trip_expenses
     WHERE user_id = $1 AND company_id = $2`,
    [req.user.id, req.companyId]
  );

  res.json({
    totalAmount: parseFloat(result.rows[0].total_amount)
  });
};

export const uploadReceipt = async (req, res) => {
  const { imageData, fileName } = req.body;

  if (!imageData) {
    return res.status(400).json({ error: "ImageRequired" });
  }

  res.json({ 
    imageData: imageData,
    fileName: fileName 
  });
};