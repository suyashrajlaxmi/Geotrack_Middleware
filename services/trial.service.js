import { pool } from "../db.js";

const TRIAL_DAYS = 7;
const MAX_ACCOUNTS_PER_DEVICE = 3;

/**
 * Check if device trial is valid
 * @param {string} deviceId - Device fingerprint hash
 * @returns {Promise<{isValid: boolean, daysRemaining: number, message?: string}>}
 */
export const checkTrialStatus = async (deviceId) => {
  if (!deviceId) {
    return { isValid: false, daysRemaining: 0, message: "Device ID required" };
  }

  const result = await pool.query(
    `SELECT 
      device_id,
      trial_start,
      accounts_created,
      is_blocked,
      EXTRACT(DAY FROM NOW() - trial_start) as days_passed
    FROM trial_devices 
    WHERE device_id = $1`,
    [deviceId]
  );

  // First time device - valid trial
  if (result.rows.length === 0) {
    return { 
      isValid: true, 
      daysRemaining: TRIAL_DAYS,
      isNewDevice: true
    };
  }

  const device = result.rows[0];

  // Check if manually blocked
  if (device.is_blocked) {
    return { 
      isValid: false, 
      daysRemaining: 0, 
      message: "Device has been blocked. Contact support." 
    };
  }

  // Check if trial expired (7 days passed)
  const daysPassed = Math.floor(device.days_passed);
  const daysRemaining = Math.max(0, TRIAL_DAYS - daysPassed);

  if (daysPassed >= TRIAL_DAYS) {
    return { 
      isValid: false, 
      daysRemaining: 0, 
      message: "Trial period has ended" 
    };
  }

  // Check account creation limit
  if (device.accounts_created >= MAX_ACCOUNTS_PER_DEVICE) {
    return { 
      isValid: false, 
      daysRemaining, 
      message: "Account creation limit reached for this device" 
    };
  }

  return { 
    isValid: true, 
    daysRemaining,
    accountsCreated: device.accounts_created 
  };
};

/**
 * Register new device or increment account count
 * @param {string} deviceId 
 * @param {string} userId 
 */
export const registerDevice = async (deviceId, userId) => {
  const existing = await pool.query(
    "SELECT accounts_created FROM trial_devices WHERE device_id = $1",
    [deviceId]
  );

  if (existing.rows.length === 0) {
    // First account on this device
    await pool.query(
      `INSERT INTO trial_devices (device_id, user_id, accounts_created)
       VALUES ($1, $2, 1)`,
      [deviceId, userId]
    );
    console.log(`📱 NEW DEVICE: ${deviceId.substring(0, 12)}... - User: ${userId}`);
  } else {
    // Increment account count
    await pool.query(
      `UPDATE trial_devices 
       SET accounts_created = accounts_created + 1,
           user_id = $2,
           last_login = NOW()
       WHERE device_id = $1`,
      [deviceId, userId]
    );
    console.log(`📱 EXISTING DEVICE: ${deviceId.substring(0, 12)}... - Account #${existing.rows[0].accounts_created + 1}`);
  }
};

/**
 * Update last login timestamp
 * @param {string} deviceId 
 */
export const updateLastLogin = async (deviceId) => {
  await pool.query(
    "UPDATE trial_devices SET last_login = NOW() WHERE device_id = $1",
    [deviceId]
  );
};

/**
 * Check if user has added their name (required)
 * @param {string} userId 
 * @returns {Promise<boolean>}
 */
export const hasUserName = async (userId) => {
  const result = await pool.query(
    "SELECT full_name FROM profiles WHERE user_id = $1",
    [userId]
  );

  if (result.rows.length === 0) return false;
  
  const fullName = result.rows[0].full_name;
  return fullName && fullName.trim().length > 0;
};

/**
 * Get trial statistics (admin only)
 */
export const getTrialStats = async () => {
  const stats = await pool.query(`
    SELECT 
      COUNT(*) as total_devices,
      COUNT(*) FILTER (WHERE EXTRACT(DAY FROM NOW() - trial_start) < 7) as active_trials,
      COUNT(*) FILTER (WHERE EXTRACT(DAY FROM NOW() - trial_start) >= 7) as expired_trials,
      COUNT(*) FILTER (WHERE is_blocked = true) as blocked_devices,
      SUM(accounts_created) as total_accounts,
      AVG(accounts_created) as avg_accounts_per_device
    FROM trial_devices
  `);

  return stats.rows[0];
};

/**
 * Block a device manually (admin only)
 * @param {string} deviceId 
 */
export const blockDevice = async (deviceId) => {
  await pool.query(
    "UPDATE trial_devices SET is_blocked = true WHERE device_id = $1",
    [deviceId]
  );
  console.log(`🚫 BLOCKED DEVICE: ${deviceId.substring(0, 12)}...`);
};

/**
 * Unblock a device (admin only)
 * @param {string} deviceId 
 */
export const unblockDevice = async (deviceId) => {
  await pool.query(
    "UPDATE trial_devices SET is_blocked = false WHERE device_id = $1",
    [deviceId]
  );
  console.log(`✅ UNBLOCKED DEVICE: ${deviceId.substring(0, 12)}...`);
};