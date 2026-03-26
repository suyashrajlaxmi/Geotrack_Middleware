// services/token.service.js
// UPDATED: Include company_id in sessions

import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../db.js";
import { JWT_SECRET } from "../config/constants.js";

/**
 * Generate JWT token with custom expiry
 * @param {object} payload - User data to encode
 * @param {string} expiresIn - Token expiry (e.g., '7d', '1h')
 */
export const generateToken = (payload, expiresIn = '7d') => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

/**
 * Create session in database
 * @param {string} userId 
 * @param {string} token 
 * @param {number} daysValid - Number of days session is valid (default 7)
 * @param {string} companyId - Company ID (optional for super admins)
 */
export const createSession = async (userId, token, daysValid = 7, companyId = null) => {
  await pool.query(
    `INSERT INTO user_sessions (user_id, token, expires_at, company_id)
     VALUES ($1, $2, NOW() + INTERVAL '${daysValid} days', $3)`,
    [userId, token, companyId]
  );
  
  console.log(`✅ Session created for user ${userId} - Valid for ${daysValid} days`);
};

/**
 * Delete session (logout)
 */
export const deleteSession = async (token) => {
  await pool.query("DELETE FROM user_sessions WHERE token = $1", [token]);
};

/**
 * Extract token from Authorization header
 */
export const extractTokenFromHeader = (authHeader) => {
  return authHeader && authHeader.split(" ")[1];
};

/**
 * Generate password reset token
 */
export const generateResetToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

/**
 * Save reset token with 1 hour expiry
 */
export const saveResetToken = async (email, token) => {
  await pool.query(
    `INSERT INTO password_reset_otps (email, otp, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')
     ON CONFLICT (email) 
     DO UPDATE SET otp = $2, expires_at = NOW() + INTERVAL '1 hour', attempts = 0`,
    [email, token]
  );
};

/**
 * Validate reset token and return userId
 */
export const validateResetToken = async (token) => {
  const result = await pool.query(
    `SELECT u.id 
     FROM password_reset_otps pr
     JOIN users u ON u.email = pr.email
     WHERE pr.otp = $1 AND pr.expires_at > NOW()`,
    [token]
  );

  if (result.rows.length === 0) {
    throw new Error("InvalidOrExpiredToken");
  }

  return result.rows[0].id;
};

/**
 * Clear reset token after password reset
 */
export const clearResetToken = async (userId) => {
  await pool.query(
    `DELETE FROM password_reset_otps 
     WHERE email = (SELECT email FROM users WHERE id = $1)`,
    [userId]
  );
};

/**
 * Cleanup expired sessions (run periodically)
 */
export const cleanupExpiredSessions = async () => {
  const result = await pool.query(
    "DELETE FROM user_sessions WHERE expires_at < NOW()"
  );
  
  console.log(`🧹 Cleaned up ${result.rowCount} expired sessions`);
  return result.rowCount;
};