// services/bitrix24.service.js
// Bitrix24 REST API integration — creates a CRM Company whenever
// a GeoTrack client is created.  Non-blocking: failures are logged
// but never break the GeoTrack response.

import axios from "axios";

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// Set BITRIX24_WEBHOOK_URL in your .env file:
//   BITRIX24_WEBHOOK_URL=https://<your-domain>.bitrix24.com/rest/<user-id>/<token>/
//
// To get this URL:
//   Bitrix24 → Developer resources → Other → Incoming webhook → Create
// ─────────────────────────────────────────────────────────────
const BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL || null;

// BITRIX_WEBHOOK is used for the employee task integration
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK || null;

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

  // EMAIL
  if (clientData.email) {
    fields.EMAIL = [
      {
        VALUE: clientData.email,
        VALUE_TYPE: "WORK",
      },
    ];
  }

  // ADDRESS fields
  if (clientData.address)  fields.ADDRESS             = clientData.address;
  if (clientData.city)     fields.ADDRESS_CITY        = clientData.city;
  if (clientData.pincode)  fields.ADDRESS_POSTAL_CODE = String(clientData.pincode).trim();

  // Store the GeoTrack client ID as a comment so you can trace it back
  if (clientData.id) {
    fields.COMMENTS = `GeoTrack Client ID: ${clientData.id}`;
  }

  return fields;
}

// ─────────────────────────────────────────────────────────────
// createBitrixCompany
//
// Called automatically after every successful POST /clients.
// Always fire-and-forget — never await this in the route handler.
//
// @param {object} clientData  — the client row returned by GeoTrack's DB
// @returns {Promise<number|null>}  — Bitrix24 Company ID, or null on failure
// ─────────────────────────────────────────────────────────────
export async function createBitrixCompany(clientData) {
  // Skip silently if webhook URL is not configured
  if (!BITRIX24_WEBHOOK_URL) {
    console.warn("⚠️  [Bitrix24] BITRIX24_WEBHOOK_URL not set in .env — skipping company sync.");
    return null;
  }

  if (!clientData || !clientData.name) {
    console.warn("⚠️  [Bitrix24] Skipped: clientData has no name.");
    return null;
  }

  const fields = mapClientToBitrixCompany(clientData);

  console.log(
    `🔗 [Bitrix24] Syncing client "${clientData.name}" (GeoTrack ID: ${clientData.id ?? "N/A"}) → Bitrix24 CRM Company`
  );

  try {
    const base     = BITRIX24_WEBHOOK_URL.replace(/\/$/, "");
    const endpoint = `${base}/crm.company.add.json`;

    const response = await axios.post(
      endpoint,
      { fields },
      {
        timeout: 10_000, // 10 s — never block GeoTrack's own response
        headers: { "Content-Type": "application/json" },
      }
    );

    const bitrixCompanyId = response.data?.result;

    if (!bitrixCompanyId) {
      console.error(
        "❌ [Bitrix24] crm.company.add returned no ID. Response:",
        JSON.stringify(response.data, null, 2)
      );
      return null;
    }

    console.log(
      `✅ [Bitrix24] Company created — Bitrix24 ID: ${bitrixCompanyId} | Client: "${clientData.name}"`
    );
    return bitrixCompanyId;

  } catch (err) {
    if (err.response) {
      // Bitrix24 returned an HTTP error
      console.error(
        `❌ [Bitrix24] API error ${err.response.status}:`,
        JSON.stringify(err.response.data, null, 2)
      );
    } else if (err.request) {
      // Request was sent but no response received (timeout / network)
      console.error(
        "❌ [Bitrix24] No response received (timeout / network issue):",
        err.message
      );
    } else {
      console.error("❌ [Bitrix24] Unexpected error:", err.message);
    }

    return null; // never throw — this is a best-effort side-effect
  }
}

// ─────────────────────────────────────────────────────────────
// updateBitrixCompany
//
// Optional: call this from updateClient if you want changes in
// GeoTrack to propagate back to Bitrix24.
//
// @param {number} bitrixCompanyId — ID returned by createBitrixCompany
// @param {object} clientData      — updated GeoTrack client data
// ─────────────────────────────────────────────────────────────
export async function updateBitrixCompany(bitrixCompanyId, clientData) {
  if (!BITRIX24_WEBHOOK_URL) {
    console.warn("⚠️  [Bitrix24] BITRIX24_WEBHOOK_URL not set — skipping update sync.");
    return false;
  }

  if (!bitrixCompanyId) {
    console.warn("⚠️  [Bitrix24] updateBitrixCompany: no bitrixCompanyId supplied.");
    return false;
  }

  const fields = mapClientToBitrixCompany(clientData);

  try {
    const base     = BITRIX24_WEBHOOK_URL.replace(/\/$/, "");
    const endpoint = `${base}/crm.company.update.json`;

    const response = await axios.post(
      endpoint,
      { id: bitrixCompanyId, fields },
      { timeout: 10_000, headers: { "Content-Type": "application/json" } }
    );

    const success = response.data?.result === true;
    if (success) {
      console.log(`✅ [Bitrix24] Company ${bitrixCompanyId} updated.`);
    } else {
      console.warn("⚠️  [Bitrix24] Update returned unexpected result:", response.data);
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

// ─────────────────────────────────────────────────────────────
// createEmployeeTask
//
// Called automatically after a new employee/team member is created
// in GeoTrack. Creates a task in Bitrix24 via tasks.task.add.
// Fire-and-forget — never throws, never blocks the main response.
//
// Uses BITRIX_WEBHOOK env variable.
// RESPONSIBLE_ID is intentionally omitted so Bitrix auto-assigns
// the task to the webhook owner.
//
// @param {object} user — the newly created user object from GeoTrack's DB
//   Expected shape: { id, email, full_name, phone, role, department, is_admin }
// @returns {Promise<number|null>} — Bitrix24 Task ID, or null on failure
// ─────────────────────────────────────────────────────────────
export async function createEmployeeTask(user) {
  if (!BITRIX_WEBHOOK) {
    console.warn("⚠️  [Bitrix24:EmployeeTask] BITRIX_WEBHOOK not set in .env — skipping task creation.");
    return null;
  }

  if (!user) {
    console.warn("⚠️  [Bitrix24:EmployeeTask] Skipped: no user data provided.");
    return null;
  }

  const name       = user.full_name || user.fullName || "N/A";
  const email      = user.email     || "N/A";
  const phone      = user.phone     || "N/A";
  const role       = user.is_admin  ? "Admin" : (user.role || user.department || "Employee");

  const title = `New Employee Created: ${name}`;

  const description =
    `A new team member has been added to GeoTrack.\n\n` +
    `Name:  ${name}\n` +
    `Email: ${email}\n` +
    `Phone: ${phone}\n` +
    `Role:  ${role}\n` +
    `\nGeoTrack User ID: ${user.id ?? "N/A"}`;

  console.log(`🔗 [Bitrix24:EmployeeTask] Creating task for new employee "${name}" (${email})`);

  // Extract the user ID from the webhook URL
  // Webhook format: https://domain.bitrix24.com/rest/<USER_ID>/<token>/
  // Bitrix24 requires RESPONSIBLE_ID — we derive it from the webhook URL itself.
  const webhookUserId = (() => {
    try {
      const parts = BITRIX_WEBHOOK.replace(/\/$/, "").split("/");
      // parts: ["https:", "", "domain", "rest", "<USER_ID>", "<token>"]
      const restIndex = parts.indexOf("rest");
      return restIndex !== -1 ? parseInt(parts[restIndex + 1], 10) : null;
    } catch (_) {
      return null;
    }
  })();

  if (!webhookUserId) {
    console.warn("⚠️  [Bitrix24:EmployeeTask] Could not extract user ID from BITRIX_WEBHOOK URL. Set BITRIX_RESPONSIBLE_ID in .env as fallback.");
  }

  const responsibleId = webhookUserId || parseInt(process.env.BITRIX_RESPONSIBLE_ID, 10) || null;

  if (!responsibleId) {
    console.error("❌ [Bitrix24:EmployeeTask] No RESPONSIBLE_ID available — task creation aborted. Set BITRIX_RESPONSIBLE_ID in .env.");
    return null;
  }

  try {
    const base     = BITRIX_WEBHOOK.replace(/\/$/, "");
    const endpoint = `${base}/tasks.task.add.json`;

    const response = await axios.post(
      endpoint,
      {
        fields: {
          TITLE:          title,
          DESCRIPTION:    description,
          RESPONSIBLE_ID: responsibleId,  // Required by Bitrix24 — derived from webhook URL
        },
      },
      {
        timeout: 10_000,
        headers: { "Content-Type": "application/json" },
      }
    );

    const taskId = response.data?.result?.task?.id;

    if (!taskId) {
      console.error(
        "❌ [Bitrix24:EmployeeTask] tasks.task.add returned no task ID. Response:",
        JSON.stringify(response.data, null, 2)
      );
      return null;
    }

    console.log(
      `✅ [Bitrix24:EmployeeTask] Task created — Bitrix24 Task ID: ${taskId} | Employee: "${name}"`
    );
    return taskId;

  } catch (err) {
    if (err.response) {
      console.error(
        `❌ [Bitrix24:EmployeeTask] API error ${err.response.status}:`,
        JSON.stringify(err.response.data, null, 2)
      );
    } else if (err.request) {
      console.error(
        "❌ [Bitrix24:EmployeeTask] No response received (timeout / network issue):",
        err.message
      );
    } else {
      console.error("❌ [Bitrix24:EmployeeTask] Unexpected error:", err.message);
    }

    return null; // never throw — best-effort side-effect
  }
}