// services/bitrix24.service.js
// Bitrix24 REST API integration — creates a CRM Company whenever
// a GeoTrack client is created.  Non-blocking: failures are logged
// but never break the GeoTrack response.

import axios from "axios";

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// Replace the value below with your real Incoming Webhook URL,
// or set BITRIX24_WEBHOOK_URL in your .env file.
// Format: https://<your-domain>.bitrix24.com/rest/<user-id>/<token>/
// ─────────────────────────────────────────────────────────────
const BITRIX24_WEBHOOK_URL =
  process.env.BITRIX24_WEBHOOK_URL ||
  "https://world.bitrix24.com/rest/244/ts8jdv7plafc4y5y/profile.json";

// ─────────────────────────────────────────────────────────────
// FIELD MAPPER
// Translates a GeoTrack clientData object into the shape that
// crm.company.add expects.
// ─────────────────────────────────────────────────────────────
function mapClientToBitrixCompany(clientData) {
  const fields = {
    TITLE: clientData.name || "Unnamed Company",
  };

  // PHONE — Bitrix expects an array of value-objects
  if (clientData.phone) {
    fields.PHONE = [
      {
        VALUE: String(clientData.phone).trim(),
        VALUE_TYPE: "WORK",
      },
    ];
  }

  // ADDRESS fields
  if (clientData.address) {
    fields.ADDRESS = clientData.address;
  }
  if (clientData.city) {
    fields.ADDRESS_CITY = clientData.city;
  }
  if (clientData.pincode) {
    fields.ADDRESS_POSTAL_CODE = String(clientData.pincode).trim();
  }

  // Extra useful metadata (won't break if Bitrix ignores them)
  if (clientData.email) {
    fields.EMAIL = [
      {
        VALUE: clientData.email,
        VALUE_TYPE: "WORK",
      },
    ];
  }

  // Store the GeoTrack client ID as a comment so you can trace it
  if (clientData.id) {
    fields.COMMENTS = `GeoTrack Client ID: ${clientData.id}`;
  }

  return fields;
}

// ─────────────────────────────────────────────────────────────
// createBitrixCompany
//
// @param {object} clientData  — the client row returned by GeoTrack's DB
// @returns {Promise<number|null>}  — Bitrix24 Company ID, or null on failure
// ─────────────────────────────────────────────────────────────
export async function createBitrixCompany(clientData) {
  if (!clientData || !clientData.name) {
    console.warn("⚠️  [Bitrix24] Skipped: clientData has no name.");
    return null;
  }

  const fields = mapClientToBitrixCompany(clientData);

  console.log(
    `🔗 [Bitrix24] Creating company for GeoTrack client "${clientData.name}" (ID: ${clientData.id ?? "N/A"})`
  );

  try {
    const endpoint = `${BITRIX24_WEBHOOK_URL.replace(/\/$/, "")}/crm.company.add.json`;

    const response = await axios.post(
      endpoint,
      { fields },
      {
        timeout: 10_000, // 10 s — don't block GeoTrack's response for long
        headers: { "Content-Type": "application/json" },
      }
    );

    const bitrixCompanyId = response.data?.result;

    if (!bitrixCompanyId) {
      console.error(
        "❌ [Bitrix24] API returned no company ID. Full response:",
        JSON.stringify(response.data, null, 2)
      );
      return null;
    }

    console.log(
      `✅ [Bitrix24] Company created — Bitrix24 ID: ${bitrixCompanyId} | GeoTrack client: "${clientData.name}"`
    );
    return bitrixCompanyId;

  } catch (err) {
    // Distinguish network errors from Bitrix API errors for cleaner logs
    if (err.response) {
      console.error(
        `❌ [Bitrix24] API error ${err.response.status}:`,
        JSON.stringify(err.response.data, null, 2)
      );
    } else if (err.request) {
      console.error(
        "❌ [Bitrix24] No response received (timeout / network issue):",
        err.message
      );
    } else {
      console.error("❌ [Bitrix24] Unexpected error:", err.message);
    }

    // Return null — caller must NOT throw; this is a best-effort side-effect
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// (Optional) Update an existing Bitrix24 Company
// Useful if you later sync GeoTrack client updates back to Bitrix.
// ─────────────────────────────────────────────────────────────
export async function updateBitrixCompany(bitrixCompanyId, clientData) {
  if (!bitrixCompanyId) {
    console.warn("⚠️  [Bitrix24] updateBitrixCompany: no bitrixCompanyId supplied.");
    return false;
  }

  const fields = mapClientToBitrixCompany(clientData);

  try {
    const endpoint = `${BITRIX24_WEBHOOK_URL.replace(/\/$/, "")}/crm.company.update.json`;

    const response = await axios.post(
      endpoint,
      { id: bitrixCompanyId, fields },
      { timeout: 10_000, headers: { "Content-Type": "application/json" } }
    );

    const success = response.data?.result === true;
    if (success) {
      console.log(`✅ [Bitrix24] Company ${bitrixCompanyId} updated.`);
    } else {
      console.warn(
        `⚠️  [Bitrix24] Update returned unexpected result:`,
        response.data
      );
    }
    return success;

  } catch (err) {
    console.error(
      "❌ [Bitrix24] updateBitrixCompany error:",
      err.response?.data || err.message
    );
    return false;
  }
}