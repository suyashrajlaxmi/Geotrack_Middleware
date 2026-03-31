// controllers/auth.controller.js
// UPDATED: Added API key support for external license sync

import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import * as tokenService from "../services/token.service.js";
import * as trialService from "../services/trial.service.js";
import * as emailDomainService from "../services/emailDomain.service.js";
import { sendPasswordResetEmail } from "../services/email.service.js";

// ============================================
// API Key configuration from environment
// ============================================
const LICENSE_SYSTEM_API_KEY = process.env.LICENSE_SYSTEM_API_KEY || 'my-secret-key-123';
const LICENSE_SYSTEM_URL = process.env.LICENSE_SYSTEM_URL || 'https://lisence-system.onrender.com';

export const login = async (req, res) => {
  const { email, password, deviceId } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "MissingFields" });
  }

  const result = await pool.query(
    `SELECT 
       u.*,
       p.full_name, 
       p.department, 
       p.work_hours_start, 
       p.work_hours_end,
       c.id as company_id,
       c.name as company_name,
       c.subdomain as company_subdomain,
       c.is_active as company_active,
       c.email_domain as company_email_domain
     FROM users u
     LEFT JOIN profiles p ON u.id = p.user_id
     LEFT JOIN companies c ON u.company_id = c.id
     WHERE u.email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: "InvalidCredentials" });
  }

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    return res.status(401).json({ error: "InvalidCredentials" });
  }

  if (!user.is_super_admin && !user.company_id) {
    return res.status(403).json({ 
      error: "NoCompanyAssigned",
      message: "Your account is not assigned to any company. Contact super admin." 
    });
  }

  if (!user.is_super_admin && !user.company_active) {
    return res.status(403).json({ 
      error: "CompanyInactive",
      message: "Your company account is currently inactive. Contact super admin." 
    });
  }

  // Clean up only EXPIRED sessions for this user (not active ones)
  // This allows multiple admin accounts to be logged in simultaneously
  const deletedSessions = await pool.query(
    "DELETE FROM user_sessions WHERE user_id = $1 AND expires_at < NOW() RETURNING id",
    [user.id]
  );

  if (deletedSessions.rows.length > 0) {
    console.log(`🧹 Cleaned ${deletedSessions.rows.length} expired sessions for ${user.email}`);
  }

  const token = tokenService.generateToken({
    id: user.id,
    email: user.email,
    isAdmin: user.is_admin,
    isSuperAdmin: user.is_super_admin || false,
    isTrialUser: user.is_trial_user || false,
    companyId: user.company_id
  }, '7d');

  await tokenService.createSession(user.id, token, 7, user.company_id);

  console.log(`✅ Login: ${user.email} | Company: ${user.company_name || 'Super Admin'} | Trial: ${user.is_trial_user || false}`);

  res.json({
    message: "LoginSuccess",
    token,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      department: user.department,
      workHoursStart: user.work_hours_start,
      workHoursEnd: user.work_hours_end,
      isAdmin: user.is_admin,
      isSuperAdmin: user.is_super_admin || false,
      isTrialUser: user.is_trial_user || false,
      companyId: user.company_id,
      companyName: user.company_name,
      companySubdomain: user.company_subdomain,
      companyEmailDomain: user.company_email_domain
    },
  });
};

export const logout = async (req, res) => {
  const token = tokenService.extractTokenFromHeader(req.headers["authorization"]);
  await tokenService.deleteSession(token);
  res.json({ message: "LogoutSuccess" });
};

export const signup = async (req, res) => {
  const { email, password, deviceId, fullName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "MissingFields" });
  }

  const existing = await pool.query(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );

  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "EmailAlreadyExists" });
  }

  const isGenericEmail = emailDomainService.isGenericEmailDomain(email);
  const isTrialUser = isGenericEmail;
  
  let company = null;
  let signupType = 'trial';

  if (!isGenericEmail) {
    company = await emailDomainService.findCompanyByEmailDomain(email);
    
    if (company) {
      signupType = 'company';
      console.log(`📧 Email domain matched: ${email} → ${company.name}`);
    } else {
      console.log(`⚠️ Corporate email ${email} but no company found. Creating trial user.`);
    }
  }

  if (isTrialUser && deviceId) {
    const trialStatus = await trialService.checkTrialStatus(deviceId);

    if (!trialStatus.isValid) {
      return res.status(403).json({
        error: "TRIAL_EXPIRED",
        message: trialStatus.message || "Trial period has ended",
        daysRemaining: trialStatus.daysRemaining
      });
    }

    console.log(`🍕 Trial Status: ${trialStatus.daysRemaining} days remaining`);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const userResult = await pool.query(
    `INSERT INTO users (email, password, is_admin, is_trial_user, company_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, is_trial_user, company_id`,
    [
      email, 
      hashedPassword, 
      false,
      isTrialUser,
      company?.id || null
    ]
  );

  const user = userResult.rows[0];

  await pool.query(
    `INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)`,
    [user.id, fullName || null]
  );

  if (isTrialUser && deviceId) {
    await trialService.registerDevice(deviceId, user.id);
  }

  const token = tokenService.generateToken({
    id: user.id,
    email: user.email,
    isAdmin: false,
    isSuperAdmin: false,
    isTrialUser: user.is_trial_user,
    companyId: user.company_id
  }, '7d');

  await tokenService.createSession(user.id, token, 7, user.company_id);

  console.log(`✅ Signup: ${email} | Type: ${signupType} | Company: ${company?.name || 'None (Trial)'} | Trial: ${isTrialUser}`);

  res.status(201).json({
    message: "SignupSuccess",
    token,
    signupType,
    user: {
      id: user.id,
      email: user.email,
      fullName: fullName || null,
      isTrialUser: user.is_trial_user,
      companyId: user.company_id,
      companyName: company?.name || null,
      companySubdomain: company?.subdomain || null
    },
    ...(isTrialUser && {
      restrictions: emailDomainService.getTrialUserRestrictions(),
      message: company 
        ? `Use your company email (@${company.email_domain}) for full access`
        : 'Trial users have read-only access. Contact your company admin to get added.'
    })
  });
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "EmailRequired" });
  }

  try {
    const result = await pool.query(
      "SELECT id FROM users WHERE email = $1", [email]
    );

    if (result.rows.length === 0) {
      return res.json({ message: "PasswordResetEmailSent" });
    }

    const resetToken = tokenService.generateResetToken();
    await tokenService.saveResetToken(email, resetToken);

    await sendPasswordResetEmail(email, resetToken);

    console.log(`✅ Reset email sent to: ${email}`);
    return res.json({ message: "PasswordResetEmailSent" });

  } catch (err) {
    console.error("❌ forgotPassword error:", err.message);
    return res.status(500).json({ error: "InternalError", message: err.message });
  }
};

// ============================================
// Sync hashed password to license system with API key
// ============================================
const syncPasswordToLicenseSystem = async (email, hashedPassword) => {
  try {
    const response = await fetch(
      `${LICENSE_SYSTEM_URL}/api/external/customer-password-sync`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-api-key": LICENSE_SYSTEM_API_KEY
        },
        body: JSON.stringify({ email, hashedPassword })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.warn(`⚠️ License system sync failed for ${email}:`, data);
    } else {
      console.log(`🔄 License system password synced for: ${email}`);
    }
  } catch (err) {
    // Non-blocking — log but don't fail the reset
    console.warn(`⚠️ License system sync error (non-fatal): ${err.message}`);
  }
};

export const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "MissingFields" });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: "PasswordTooShort" });
  }

  try {
    // Validate token and get userId
    const userId = await tokenService.validateResetToken(token);

    // Get user email for license sync
    const userResult = await pool.query(
      "SELECT email FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "UserNotFound" });
    }

    const userEmail = userResult.rows[0].email;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password in local DB
    await pool.query(
      "UPDATE users SET password = $1 WHERE id = $2",
      [hashedPassword, userId]
    );

    // Clear reset token
    await tokenService.clearResetToken(userId);

    console.log(`✅ Password reset success for: ${userEmail}`);

    // Respond to user immediately
    res.json({ message: "PasswordResetSuccess" });

    // Sync hashed password to license system in background (non-blocking)
    syncPasswordToLicenseSystem(userEmail, hashedPassword);

  } catch (err) {
    console.error("❌ resetPassword error:", err.message);

    // Handle invalid/expired token specifically
    if (err.message?.toLowerCase().includes("invalid") || 
        err.message?.toLowerCase().includes("expired")) {
      return res.status(400).json({ 
        error: "InvalidToken",
        message: "This reset link is invalid or has expired. Please request a new one." 
      });
    }

    return res.status(500).json({ error: "InternalError", message: err.message });
  }
};

export const getProfile = async (req, res) => {
  const result = await pool.query(
    `SELECT 
       u.id, 
       u.email, 
       u.is_admin,
       u.is_super_admin,
       u.is_trial_user,
       u.company_id,
       p.full_name, 
       p.department, 
       p.work_hours_start, 
       p.work_hours_end, 
       p.created_at,
       c.name as company_name,
       c.subdomain as company_subdomain,
       c.email_domain as company_email_domain
     FROM users u
     LEFT JOIN profiles p ON u.id = p.user_id
     LEFT JOIN companies c ON u.company_id = c.id
     WHERE u.id = $1`,
    [req.user.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "UserNotFound" });
  }

  const user = result.rows[0];

  res.json({
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      department: user.department,
      workHoursStart: user.work_hours_start,
      workHoursEnd: user.work_hours_end,
      createdAt: user.created_at,
      isAdmin: user.is_admin,
      isSuperAdmin: user.is_super_admin || false,
      isTrialUser: user.is_trial_user || false,
      companyId: user.company_id,
      companyName: user.company_name,
      companySubdomain: user.company_subdomain,
      companyEmailDomain: user.company_email_domain
    },
    ...(user.is_trial_user && {
      restrictions: emailDomainService.getTrialUserRestrictions()
    })
  });
};

export const updateProfile = async (req, res) => {
  const { fullName, department, workHoursStart, workHoursEnd } = req.body;

  if (fullName !== undefined && fullName !== null) {
    const trimmedName = fullName.trim();
    if (trimmedName.length < 2) {
      return res.status(400).json({
        error: "InvalidName",
        message: "Name must be at least 2 characters"
      });
    }
    if (trimmedName.length > 50) {
      return res.status(400).json({
        error: "InvalidName",
        message: "Name must be less than 50 characters"
      });
    }
  }

  const result = await pool.query(
    `UPDATE profiles 
     SET full_name = $1, department = $2, work_hours_start = $3, work_hours_end = $4
     WHERE user_id = $5
     RETURNING *`,
    [fullName, department, workHoursStart, workHoursEnd, req.user.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "ProfileNotFound" });
  }

  const profile = result.rows[0];

  res.json({
    message: "ProfileUpdated",
    profile: {
      id: profile.id,
      userId: profile.user_id,
      email: profile.email,
      fullName: profile.full_name,
      department: profile.department,
      workHoursStart: profile.work_hours_start,
      workHoursEnd: profile.work_hours_end
    }
  });
};

// ============================================
// Convert Trial User to Full User
// ============================================
export const convertTrialUser = async (req, res) => {
  const { newEmail, password } = req.body;

  if (!newEmail) {
    return res.status(400).json({ error: "NewEmailRequired" });
  }

  const userCheck = await pool.query(
    'SELECT is_trial_user, company_id FROM users WHERE id = $1',
    [req.user.id]
  );

  if (userCheck.rows.length === 0) {
    return res.status(404).json({ error: "UserNotFound" });
  }

  if (!userCheck.rows[0].is_trial_user) {
    return res.status(400).json({ 
      error: "NotTrialUser",
      message: "You are already a full user" 
    });
  }

  const user = await pool.query(
    'SELECT password FROM users WHERE id = $1',
    [req.user.id]
  );

  const validPassword = await bcrypt.compare(password, user.rows[0].password);
  if (!validPassword) {
    return res.status(401).json({ error: "InvalidPassword" });
  }

  const isGeneric = emailDomainService.isGenericEmailDomain(newEmail);
  
  if (isGeneric) {
    return res.status(400).json({
      error: "GenericEmailNotAllowed",
      message: "Please use your company email address, not a generic email provider"
    });
  }

  const company = await emailDomainService.findCompanyByEmailDomain(newEmail);
  
  if (!company) {
    return res.status(404).json({
      error: "CompanyNotFound",
      message: "No company registered with this email domain. Contact your company admin."
    });
  }

  try {
    await emailDomainService.convertTrialUserToFullUser(
      req.user.id,
      newEmail,
      company.id
    );

    await pool.query(
      'UPDATE users SET company_id = $1 WHERE id = $2',
      [company.id, req.user.id]
    );

    console.log(`✅ Trial user ${req.user.id} converted to full user: ${newEmail}`);

    res.json({
      message: "ConversionSuccess",
      newEmail,
      companyName: company.name,
      companySubdomain: company.subdomain
    });

  } catch (error) {
    return res.status(400).json({
      error: "ConversionFailed",
      message: error.message
    });
  }
};

export const clearPincode = async (req, res) => {
  await pool.query(
    `UPDATE users SET pincode = NULL WHERE id = $1`,
    [req.user.id]
  );
  console.log(`🛑 Tracking stopped → cleared pincode for ${req.user.id}`);
  res.json({ message: "PincodeCleared" });
};

export const verifyToken = (req, res) => {
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      isAdmin: req.user.isAdmin || false,
      isSuperAdmin: req.user.isSuperAdmin || false,
      isTrialUser: req.user.isTrialUser || false,
      companyId: req.user.companyId
    }
  });
};

export const getTrialStatus = async (req, res) => {
  const { deviceId } = req.query;

  if (!deviceId) {
    return res.status(400).json({ error: "DeviceIdRequired" });
  }

  const status = await trialService.checkTrialStatus(deviceId);

  res.json({
    isValid: status.isValid,
    daysRemaining: status.daysRemaining,
    message: status.message,
    accountsCreated: status.accountsCreated
  });
};

export const getTrialStats = async (req, res) => {
  const stats = await trialService.getTrialStats();
  res.json(stats);
};

export const blockDevice = async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "DeviceIdRequired" });
  }

  await trialService.blockDevice(deviceId);
  res.json({ message: "DeviceBlocked" });
};

export const unblockDevice = async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "DeviceIdRequired" });
  }

  await trialService.unblockDevice(deviceId);
  res.json({ message: "DeviceUnblocked" });
};