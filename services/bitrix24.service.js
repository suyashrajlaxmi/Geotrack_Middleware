// services/bitrix24.service.js
// UPDATED: Added Employee/User sync alongside existing Client (CRM Company) sync

import axios from "axios";

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// Set these in your .env file:
//   BITRIX24_WEBHOOK_URL=https://<domain>.bitrix24.com/rest/<user-id>/<token>/
//   BITRIX_WEBHOOK=https://<domain>.bitrix24.com/rest/<user-id>/<token>/
//
// BITRIX_WEBHOOK is the canonical key for user-sync operations.
// BITRIX24_WEBHOOK_URL is kept for backward-compatible client sync.
// ─────────────────────────────────────────────────────────────
const BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL || null;
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK || BITRIX24_WEBHOOK_URL || null;

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function normaliseWebhook(url) {
  if (!url) return null;
  return url.endsWith("/") ? url : url + "/";
}

async function callBitrix(webhookUrl, method, params = {}) {
  const base = normaliseWebhook(webhookUrl);
  const url = `${base}${method}.json`;

  const response = await axios.post(url, params, {
    timeout: 10_000,
    headers: { "Content-Type": "application/json" },
  });

  if (response.data && response.data.error) {
    throw new Error(
      `Bitrix24 API error [${method}]: ${response.data.error} — ${response.data.error_description || ""}`
    );
  }

  return response.data.result;
}

// ─────────────────────────────────────────────────────────────
// ── USER (EMPLOYEE) SYNC ──────────────────────────────────────
// ─────────────────────────────────────────────────────────────

/**
 * Map a GeoTrack user object to Bitrix24 user fields.
 */
function mapUserToBitrix(user) {
  const fields = {
    EMAIL: user.email,
    ACTIVE: true,
    USER_TYPE: "employee",
  };

  if (user.fullName) {
    const parts = user.fullName.trim().split(/\s+/);
    fields.NAME = parts[0] || "";
    fields.LAST_NAME = parts.slice(1).join(" ") || "";
  }

  if (user.department) {
    fields.WORK_POSITION = user.department;
  }

  if (user.phone) {
    fields.PERSONAL_PHONE = String(user.phone).trim();
  }

  return fields;
}

/**
 * Find a Bitrix24 user by e-mail address.
 * Returns the Bitrix user object (with .ID) or null if not found.
 *
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function findBitrixUserByEmail(email) {
  if (!BITRIX_WEBHOOK) {
    console.warn("⚠️  [Bitrix24] BITRIX_WEBHOOK not set — skipping findBitrixUserByEmail.");
    return null;
  }

  if (!email) return null;

  try {
    const result = await callBitrix(BITRIX_WEBHOOK, "user.get", {
      filter: { EMAIL: email },
    });

    const users = Array.isArray(result) ? result : [];
    if (users.length === 0) {
      console.log(`ℹ️  [Bitrix24] No user found with email: ${email}`);
      return null;
    }

    console.log(`✅ [Bitrix24] Found existing user for ${email} → Bitrix ID ${users[0].ID}`);
    return users[0];
  } catch (err) {
    console.error(`❌ [Bitrix24] findBitrixUserByEmail(${email}) failed:`, err.message);
    return null;
  }
}

/**
 * Create a new employee in Bitrix24.
 * Falls back to returning the existing Bitrix user if the email is already taken.
 *
 * @param {object} user  GeoTrack user object { email, fullName, department, phone }
 * @returns {Promise<string|null>}  Bitrix24 user ID string, or null on failure
 */
export async function createBitrixUser(user) {
  if (!BITRIX_WEBHOOK) {
    console.warn("⚠️  [Bitrix24] BITRIX_WEBHOOK not set — skipping createBitrixUser.");
    return null;
  }

  if (!user || !user.email) {
    console.warn("⚠️  [Bitrix24] createBitrixUser: user.email is required.");
    return null;
  }

  try {
    // Duplicate-prevention: check if user already exists in Bitrix
    const existing = await findBitrixUserByEmail(user.email);
    if (existing) {
      console.log(`ℹ️  [Bitrix24] Reusing existing Bitrix user ID ${existing.ID} for ${user.email}`);
      return String(existing.ID);
    }

    const fields = mapUserToBitrix(user);
    const bitrixId = await callBitrix(BITRIX_WEBHOOK, "user.add", { FIELDS: fields });

    console.log(`✅ [Bitrix24] Created employee for ${user.email} → Bitrix ID ${bitrixId}`);
    return String(bitrixId);
  } catch (err) {
    // user.add can fail due to portal permissions. Attempt fallback lookup.
    console.error(`❌ [Bitrix24] createBitrixUser(${user.email}) failed:`, err.message);

    try {
      console.log(`🔄 [Bitrix24] Fallback: looking up ${user.email} after user.add failure…`);
      const fallback = await findBitrixUserByEmail(user.email);
      if (fallback) {
        console.log(`✅ [Bitrix24] Fallback succeeded — reusing Bitrix ID ${fallback.ID}`);
        return String(fallback.ID);
      }
    } catch (lookupErr) {
      console.error(`❌ [Bitrix24] Fallback lookup also failed:`, lookupErr.message);
    }

    return null;
  }
}

/**
 * Update an existing Bitrix24 employee.
 *
 * @param {string|number} bitrixUserId  Bitrix24 user ID
 * @param {object}        user          GeoTrack user fields to sync
 * @returns {Promise<boolean>}
 */
export async function updateBitrixUser(bitrixUserId, user) {
  if (!BITRIX_WEBHOOK) {
    console.warn("⚠️  [Bitrix24] BITRIX_WEBHOOK not set — skipping updateBitrixUser.");
    return false;
  }

  if (!bitrixUserId) {
    console.warn("⚠️  [Bitrix24] updateBitrixUser: bitrixUserId is required.");
    return false;
  }

  try {
    const fields = mapUserToBitrix(user);

    await callBitrix(BITRIX_WEBHOOK, "user.update", {
      ID: String(bitrixUserId),
      FIELDS: fields,
    });

    console.log(`✅ [Bitrix24] Updated employee Bitrix ID ${bitrixUserId} (${user.email || "—"})`);
    return true;
  } catch (err) {
    console.error(`❌ [Bitrix24] updateBitrixUser(${bitrixUserId}) failed:`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// ── CLIENT (CRM COMPANY) SYNC — preserved from original ──────
// ─────────────────────────────────────────────────────────────

function mapClientToBitrixCompany(clientData) {
  const fields = {
    TITLE: clientData.name || "Unnamed Company",
  };

  if (clientData.phone) {
    fields.PHONE = [{ VALUE: String(clientData.phone).trim(), VALUE_TYPE: "WORK" }];
  }

  if (clientData.email) {
    fields.EMAIL = [{ VALUE: clientData.email, VALUE_TYPE: "WORK" }];
  }

  if (clientData.address) fields.ADDRESS = clientData.address;
  if (clientData.city) fields.ADDRESS_CITY = clientData.city;
  if (clientData.pincode) fields.ADDRESS_POSTAL_CODE = String(clientData.pincode).trim();

  if (clientData.id) {
    fields.COMMENTS = `GeoTrack Client ID: ${clientData.id}`;
  }

  return fields;
}

/**
 * Create a CRM Company in Bitrix24 for a GeoTrack client.
 * Fire-and-forget safe — never throws.
 *
 * @param {object} clientData
 * @returns {Promise<number|null>}
 */
export async function createBitrixCompany(clientData) {
  if (!BITRIX24_WEBHOOK_URL) {
    console.warn("⚠️  [Bitrix24] BITRIX24_WEBHOOK_URL not set — skipping company sync.");
    return null;
  }

  if (!clientData || !clientData.name) {
    console.warn("⚠️  [Bitrix24] createBitrixCompany: clientData.name is required.");
    return null;
  }

  try {
    const fields = mapClientToBitrixCompany(clientData);
    const companyId = await callBitrix(BITRIX24_WEBHOOK_URL, "crm.company.add", { fields });

    console.log(`✅ [Bitrix24] CRM Company created for "${clientData.name}" → ID ${companyId}`);
    return companyId;
  } catch (err) {
    console.error(`❌ [Bitrix24] createBitrixCompany("${clientData?.name}") failed:`, err.message);
    return null;
  }
}