import { pool } from "../db.js";
import axios from "axios";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_FILE  = path.join(__dirname, "../bitrix_tokens.json");
const SYNCED_FILE = path.join(__dirname, "../bitrix_synced.json");
const CONFIG_FILE = path.join(__dirname, "../bitrix_config.json");
const VIEWS_DIR   = path.join(__dirname, "../bitrix_ui");

// ── View renderer ─────────────────────────────────────────────
function renderView(filename, data = {}) {
  let html = fs.readFileSync(path.join(VIEWS_DIR, filename), "utf8");
  html = Object.entries(data).reduce(
    (h, [k, v]) => h.replaceAll(`{{${k}}}`, String(v ?? "")), html
  );
  const injectScript = `<script>
window.__GT_MEMBER_ID__  = ${JSON.stringify(String(data.member_id   || ""))};
window.__GT_DOMAIN__     = ${JSON.stringify(String(data.DOMAIN      || "world.bitrix24.com"))};
window.__GT_USER_ID__    = ${JSON.stringify(String(data.user_id     || ""))};
window.__GT_USER_NAME__  = ${JSON.stringify(String(data.user_name   || ""))};
window.__GT_COMPANY_ID__ = ${JSON.stringify(String(data.company_id  || ""))};
</` + `script>`;
  html = html.replace('<script>', injectScript + '\n<script>');
  return html;
}

// ── Token helpers ─────────────────────────────────────────────
function loadAllTokens() {
  try { if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch(e){}
  return {};
}
function savePortalToken(memberId, data) {
  const all = loadAllTokens();
  all[memberId] = { ...all[memberId], ...data, expires_at: Date.now() + (data.expires_in || 3600) * 1000, updated_at: new Date().toISOString() };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2));
}
function getPortalToken(memberId) { return loadAllTokens()[memberId] || null; }
function deletePortalToken(memberId) {
  const all = loadAllTokens(); delete all[memberId];
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2));
}

// ── Synced helpers ────────────────────────────────────────────
function loadSynced() {
  try { if (fs.existsSync(SYNCED_FILE)) return JSON.parse(fs.readFileSync(SYNCED_FILE, "utf8")); } catch(e){}
  return {};
}
function saveSynced(data) { fs.writeFileSync(SYNCED_FILE, JSON.stringify(data, null, 2)); }
function markClientSynced(memberId, id, bitrixId) {
  const all = loadSynced();
  if (!all[memberId]) all[memberId] = { clients:{}, meetings:{} };
  all[memberId].clients[String(id)] = String(bitrixId);
  saveSynced(all);
}
function markMeetingSynced(memberId, id, bitrixId) {
  const all = loadSynced();
  if (!all[memberId]) all[memberId] = { clients:{}, meetings:{} };
  all[memberId].meetings[String(id)] = String(bitrixId);
  saveSynced(all);
}
function isClientSynced(memberId, id)  { return !!loadSynced()[memberId]?.clients?.[String(id)]; }
function isMeetingSynced(memberId, id) { return !!loadSynced()[memberId]?.meetings?.[String(id)]; }
function getBitrixContactId(memberId, clientId) { return loadSynced()[memberId]?.clients?.[String(clientId)] || null; }

// ── Config helpers ────────────────────────────────────────────
function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch(e){}
  return {};
}
function saveConfig(data) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }
function getPortalCompany(memberId) {
  const cfg = loadConfig()[memberId];
  return cfg ? { company_id: cfg.company_id, company_name: cfg.company_name } : null;
}
function setPortalCompany(memberId, company_id, company_name) {
  const all = loadConfig();
  all[memberId] = { ...all[memberId], company_id, company_name, updated_at: new Date().toISOString() };
  saveConfig(all);
}
function getPortalEmail(memberId) { return loadConfig()[memberId]?.email || null; }

// ── Bitrix24 token helpers ────────────────────────────────────
async function refreshBitrixToken(memberId) {
  const portal = getPortalToken(memberId);
  if (!portal?.refresh_token) throw new Error(`No refresh token for: ${memberId}`);
  const r = await axios.post(`https://${portal.domain}/oauth/token/`, null, {
    params: {
      grant_type:    "refresh_token",
      client_id:     process.env.BITRIX24_CLIENT_ID,
      client_secret: process.env.BITRIX24_CLIENT_SECRET,
      refresh_token: portal.refresh_token
    }
  });
  savePortalToken(memberId, { ...portal, access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_in: r.data.expires_in });
  return r.data.access_token;
}
export async function getValidBitrixToken(memberId) {
  const portal = getPortalToken(memberId);
  if (!portal) throw new Error(`Not connected: ${memberId}`);
  if (!portal.expires_at || Date.now() >= portal.expires_at - 300000) return await refreshBitrixToken(memberId);
  return portal.access_token;
}
async function callBitrix(memberId, method, params = {}) {
  const token  = await getValidBitrixToken(memberId);
  const portal = getPortalToken(memberId);
  const r      = await axios.post(`https://${portal.domain}/rest/${method}`, { ...params, auth: token });
  if (r.data.error) throw new Error(`Bitrix24[${method}]: ${r.data.error}`);
  return r.data.result;
}

// ═══════════════════════════════════════════════════════════════
// UUID validation helper
// ═══════════════════════════════════════════════════════════════
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(val) {
  return UUID_RE.test(String(val || "").trim());
}

// ═══════════════════════════════════════════════════════════════
// resolveCompany + resolveCompanyForRequest
// ═══════════════════════════════════════════════════════════════

// ── resolveCompany (legacy fallback — picks company with most users) ───────
async function resolveCompany(memberId) {
  try {
    const best = await pool.query(
      `SELECT c.id AS company_id, c.name AS company_name, COUNT(u.id) AS user_count
         FROM companies c
         LEFT JOIN users u ON u.company_id = c.id
         GROUP BY c.id, c.name
         ORDER BY user_count DESC, c.id ASC
         LIMIT 1`
    );
    if (best.rows.length && +best.rows[0].user_count > 0) {
      const { company_id, company_name } = best.rows[0];
      const cached = getPortalCompany(memberId);
      if (!cached?.company_id || cached.company_id !== company_id) {
        setPortalCompany(memberId, company_id, company_name);
        console.log(`✅ resolveCompany: mapped member=${memberId} → ${company_name} (id=${company_id}, users=${best.rows[0].user_count})`);
      }
      return { company_id, company_name };
    }
  } catch(e) {
    console.error("❌ resolveCompany best-match query failed:", e.message);
  }
  const cached = getPortalCompany(memberId);
  if (cached?.company_id) return cached;
  const email = getPortalEmail(memberId);
  if (email) {
    const r = await pool.query(
      `SELECT u.company_id, c.name AS company_name FROM users u LEFT JOIN companies c ON u.company_id=c.id WHERE u.email=$1`, [email]
    );
    if (r.rows.length && r.rows[0].company_id) {
      setPortalCompany(memberId, r.rows[0].company_id, r.rows[0].company_name);
      return { company_id: r.rows[0].company_id, company_name: r.rows[0].company_name };
    }
  }
  return null;
}

// ── resolveCompanyForRequest ──────────────────────────────────
// ✅ FIX: company_id is a UUID string — NEVER parse it as an integer.
//         The old code did parseInt(explicitId, 10) which truncated
//         "12eb7dbe-ddb6-44eb-96e1-742056bb0707" → 12, causing the
//         "invalid input syntax for type uuid" error on every request.
export async function resolveCompanyForRequest(req, memberId) {
  // Read as plain string — trim whitespace, never coerce to number
  const rawId =
    (req.query?.company_id  ? String(req.query.company_id).trim()  : null) ||
    (req.body?.company_id   ? String(req.body.company_id).trim()   : null) ||
    null;

  if (rawId) {
    // Only attempt DB lookup if it looks like a valid UUID
    if (!isValidUUID(rawId)) {
      console.warn(`⚠️  resolveCompanyForRequest: company_id "${rawId}" is not a valid UUID — falling back`);
    } else {
      try {
        const r = await pool.query(
          // ✅ Cast explicitly to uuid in the query — clear error if somehow still wrong
          `SELECT id AS company_id, name AS company_name FROM companies WHERE id = $1::uuid`,
          [rawId]
        );
        if (r.rows.length) {
          console.log(`✅ resolveCompanyForRequest: explicit company_id=${rawId} → ${r.rows[0].company_name}`);
          return {
            company_id:   r.rows[0].company_id,
            company_name: r.rows[0].company_name,
          };
        } else {
          console.warn(`⚠️  resolveCompanyForRequest: no company found for id=${rawId}`);
        }
      } catch(e) {
        console.error("❌ resolveCompanyForRequest explicit lookup failed:", e.message);
      }
    }
  }

  // Fallback: legacy Bitrix24 iframe installs with no login flow
  return resolveCompany(memberId);
}

// ── DB: fetch all dashboard data for a company ────────────────
async function fetchDashData(memberId, company_id) {
  const synced     = loadSynced();
  const portalData = synced[memberId] || { clients:{}, meetings:{} };
  const syncedIds  = Object.keys(portalData.clients || {});

  const [cStats, mStats, eStats, rClients, rMeetings, topC, topPins, allUsers, performers, analytic, planRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='inactive') AS inactive FROM clients WHERE company_id=$1`, [company_id]),
    pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='COMPLETED') AS completed, COUNT(*) FILTER (WHERE status='SCHEDULED') AS scheduled FROM meetings WHERE company_id=$1`, [company_id]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total_amount, COUNT(*) AS total_count FROM expenses WHERE company_id=$1`, [company_id]).catch(()=>({rows:[{total_amount:0,total_count:0}]})),
    pool.query(`SELECT id, name, phone, address, status, created_at FROM clients WHERE company_id=$1 ORDER BY created_at DESC LIMIT 10`, [company_id]),
    pool.query(`SELECT m.comments, m.start_time, m.status, c.name AS client_name FROM meetings m JOIN clients c ON m.client_id=c.id WHERE m.company_id=$1 ORDER BY m.start_time DESC LIMIT 10`, [company_id]),
    pool.query(`SELECT c.name, COUNT(m.id) AS meeting_count FROM clients c LEFT JOIN meetings m ON c.id=m.client_id WHERE c.company_id=$1 GROUP BY c.id,c.name ORDER BY meeting_count DESC LIMIT 5`, [company_id]),
    pool.query(`SELECT pincode, COUNT(*) AS client_count FROM clients WHERE company_id=$1 AND pincode IS NOT NULL AND pincode != '' GROUP BY pincode ORDER BY client_count DESC LIMIT 8`, [company_id]).catch(()=>({rows:[]})),
    pool.query(`SELECT u.id FROM users u WHERE u.company_id=$1`, [company_id]).catch(()=>({rows:[]})),
    pool.query(`
      SELECT COALESCE(p.full_name, u.email) AS full_name,
             COUNT(m.id)                    AS meetings,
             COUNT(DISTINCT m.client_id)    AS clients
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN meetings m ON m.user_id = u.id AND m.status = 'COMPLETED'
      WHERE u.company_id = $1 AND u.is_admin = false
      GROUP BY u.id, p.full_name, u.email
      ORDER BY meetings DESC LIMIT 5`, [company_id]).catch(()=>({rows:[]})),
    pool.query(`SELECT
      COUNT(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL) AS missing_gps,
      COUNT(DISTINCT pincode) FILTER (WHERE pincode IS NOT NULL AND pincode != '') AS unique_pins,
      (SELECT COUNT(*) FROM meetings WHERE company_id=$1) AS total_meetings,
      (SELECT COUNT(*) FROM location_logs ll JOIN users u ON u.id=ll.user_id WHERE u.company_id=$1) AS total_logs,
      (SELECT COUNT(*) FROM clients c2
       WHERE c2.company_id=$1 AND c2.status='active'
         AND EXISTS (SELECT 1 FROM meetings m3 WHERE m3.client_id=c2.id AND m3.status='COMPLETED')
         AND NOT EXISTS (SELECT 1 FROM meetings m2 WHERE m2.client_id=c2.id
           AND m2.status='COMPLETED' AND m2.start_time >= NOW() - INTERVAL '30 days')
      ) AS inactive_30d
    FROM clients WHERE company_id=$1`, [company_id]).catch(()=>({rows:[{missing_gps:0,unique_pins:0,total_meetings:0,total_logs:0,inactive_30d:0}]})),
    pool.query("SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id])
      .catch(()=>({ rows: [{ current_plan: 'enterprise' }] })),
  ]);

  const an        = analytic.rows[0] || {};
  const tc        = +cStats.rows[0].total || 0;
  const missingGps= +an.missing_gps || 0;
  const gpsPct    = tc > 0 ? +((tc - missingGps) / tc * 100).toFixed(1) : 0;
  const uniquePins= +an.unique_pins  || 0;
  const teamSize  = allUsers.rows.length;

  return {
    synced:  { clients: syncedIds.length, meetings: Object.keys(portalData.meetings||{}).length },
    current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase(),
    stats: {
      clients: {
        total:    +cStats.rows[0].total  || 0,
        active:   +cStats.rows[0].active || 0,
        inactive: +an.inactive_30d       || +cStats.rows[0].inactive || 0,
      },
      meetings: mStats.rows[0],
      expenses: eStats.rows[0],
    },
    recent:  { clients: rClients.rows.map(c=>({...c, synced: syncedIds.includes(String(c.id))})), meetings: rMeetings.rows },
    top:     { clients: topC.rows, pincodes: topPins.rows },
    team:    performers.rows,
    analytics: {
      missing_gps: missingGps,
      unique_pins: uniquePins,
      total_logs:  +an.total_logs  || +an.total_meetings || 0,
      gps_pct:     gpsPct,
      team_size:   teamSize,
      density:     uniquePins > 0 ? Math.round(tc / uniquePins) : (teamSize > 0 ? Math.round(tc / teamSize) : 0),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════

export const installGet = (req, res) => res.status(200).send("OK");

export const installPost = async (req, res) => {
  try {
    const { AUTH_ID, AUTH_EXPIRES, REFRESH_ID, member_id } = req.body;
    const domain = req.query.DOMAIN || req.body.DOMAIN;
    console.log("🔥 installPost body:", JSON.stringify(req.body));
    if (!AUTH_ID || !REFRESH_ID || !member_id || !domain) {
      return res.redirect(`/bitrix/app?DOMAIN=${domain||"world.bitrix24.com"}&member_id=${member_id||"unknown"}`);
    }
    savePortalToken(member_id, { domain, access_token: AUTH_ID, refresh_token: REFRESH_ID, expires_in: Number(AUTH_EXPIRES)||3600, installed_at: new Date().toISOString() });
    console.log(`✅ Installed: member=${member_id} domain=${domain}`);
    return res.redirect(`/bitrix/app?DOMAIN=${domain}&member_id=${member_id}`);
  } catch(e) {
    console.error("❌ installPost error:", e.message);
    return res.status(200).send("OK");
  }
};

export const uninstall = async (req, res) => {
  try {
    const { member_id } = req.body;
    if (member_id) { deletePortalToken(member_id); }
    return res.status(200).send("OK");
  } catch(e) { return res.status(200).send("OK"); }
};

export const appLauncher = async (req, res) => {
  try {
    const DOMAIN     = req.query.DOMAIN    || req.body.DOMAIN    || "world.bitrix24.com";
    const member_id  = req.query.member_id || req.body.member_id || "";
    res.setHeader("ngrok-skip-browser-warning", "true");
    console.log(`🔍 appLauncher: ${req.method} member_id=${member_id}`);

    const company = await resolveCompanyForRequest(req, member_id);

    if (!company?.company_id) {
      return res.status(500).send("<html><body style='font-family:sans-serif;padding:30px'><h2>&#x26A0; No companies found in GeoTrack database.</h2><p>Please add at least one company to get started.</p></body></html>");
    }

    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("dashboard.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ appLauncher error:", e.message);
    return res.status(500).send(`<html><body><h3 style="color:red;padding:20px">Error: ${e.message}</h3></body></html>`);
  }
};

export const selectCompany = async (req, res) => {
  try {
    const { member_id, company_id, DOMAIN } = req.body;
    if (!member_id || !company_id) {
      return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN||"world.bitrix24.com"}&member_id=${member_id||""}&err=Please+select+a+company`);
    }
    const r = await pool.query(`SELECT id, name FROM companies WHERE id=$1`, [company_id]);
    if (!r.rows.length) {
      return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}&err=Company+not+found`);
    }
    setPortalCompany(member_id, company_id, r.rows[0].name);
    console.log(`✅ Company selected: ${member_id} → ${r.rows[0].name} (id=${company_id})`);
    return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}&company_id=${company_id}`);
  } catch(e) {
    console.error("❌ selectCompany error:", e.message);
    return res.redirect(`/bitrix/app?DOMAIN=world.bitrix24.com&member_id=&err=${encodeURIComponent(e.message)}`);
  }
};

export const appData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id = req.query.member_id || req.body?.member_id || "";
    console.log(`📊 appData: member_id="${member_id}" ip=${req.ip}`);
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const data = await fetchDashData(member_id, company.company_id);
    return res.json({ company: company.company_name, ...data });
  } catch(e) {
    console.error("❌ appData error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const selectCompanyAjax = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, company_id } = req.body;
    if (!member_id || !company_id) return res.status(400).json({ error: "member_id and company_id required" });
    const r = await pool.query(`SELECT id, name FROM companies WHERE id=$1`, [String(company_id)]);
    if (!r.rows.length) return res.status(404).json({ error: "Company not found" });
    setPortalCompany(member_id, company_id, r.rows[0].name);
    return res.json({ ok: true, company: r.rows[0].name });
  } catch(e) { return res.status(500).json({ error: e.message }); }
};

export const resetCompany = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.body;
    const config = loadConfig();
    if (config[member_id]) {
      delete config[member_id].company_id;
      delete config[member_id].company_name;
      delete config[member_id].email;
      saveConfig(config);
    }
    console.log(`🔄 Company reset for: ${member_id}`);
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
};

export const doSyncAjax = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  const { member_id, type } = req.body;
  if (type === "refresh") return res.json({ ok: true });
  try {
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "No company configured." });
    const company_id = company.company_id;
    let clientsSynced = 0, clientsFailed = 0, meetingsSynced = 0, meetingsFailed = 0;

    if (type === "all" || type === "clients") {
      const { rows: clients } = await pool.query(
        `SELECT id, name, email, phone, address, pincode FROM clients WHERE company_id=$1 AND status='active'`, [company_id]
      );
      for (const c of clients) {
        if (isClientSynced(member_id, c.id)) continue;
        try {
          const parts = (c.name||"").split(" ");
          const cid = await callBitrix(member_id, "crm.contact.add", { fields: {
            NAME: parts[0]||c.name, LAST_NAME: parts.slice(1).join(" ")||"",
            PHONE: c.phone?[{VALUE:c.phone,VALUE_TYPE:"WORK"}]:[],
            EMAIL: c.email?[{VALUE:c.email,VALUE_TYPE:"WORK"}]:[],
            ADDRESS: c.address||"", ADDRESS_POSTAL_CODE: c.pincode||"",
            COMMENTS: `GeoTrack ID: ${c.id}`,
          }});
          markClientSynced(member_id, c.id, cid);
          clientsSynced++;
        } catch(e) { clientsFailed++; }
      }
    }

    if (type === "all" || type === "meetings") {
      const { rows: meetings } = await pool.query(
        `SELECT m.id, m.start_time, m.end_time, m.comments, m.start_latitude, m.start_longitude, m.client_id, c.name AS client_name
         FROM meetings m JOIN clients c ON m.client_id=c.id
         WHERE m.company_id=$1 AND m.status='COMPLETED'`, [company_id]
      );
      for (const m of meetings) {
        if (isMeetingSynced(member_id, m.id)) continue;
        try {
          const bid = getBitrixContactId(member_id, m.client_id);
          if (!bid) continue;
          const aid = await callBitrix(member_id, "crm.activity.add", { fields: {
            OWNER_TYPE_ID:3, OWNER_ID:bid, TYPE_ID:1,
            SUBJECT:`Field Visit — ${m.client_name}`,
            START_TIME:m.start_time, END_TIME:m.end_time||m.start_time,
            DESCRIPTION:m.comments||"No notes", COMPLETED:"Y", RESPONSIBLE_ID:1,
            LOCATION:`${m.start_latitude},${m.start_longitude}`,
          }});
          markMeetingSynced(member_id, m.id, aid);
          meetingsSynced++;
        } catch(e) { meetingsFailed++; }
      }
    }

    const portalData = loadSynced()[member_id] || { clients:{}, meetings:{} };
    const msg = type === "clients"
      ? `Synced ${clientsSynced} clients to Bitrix24`
      : type === "meetings"
      ? `Synced ${meetingsSynced} meetings to Bitrix24`
      : `Synced ${clientsSynced} clients & ${meetingsSynced} meetings`;

    return res.json({
      ok: true, message: msg,
      clients:  { synced: clientsSynced, failed: clientsFailed },
      meetings: { synced: meetingsSynced, failed: meetingsFailed },
      syncedClients:  Object.keys(portalData.clients||{}).length,
      syncedMeetings: Object.keys(portalData.meetings||{}).length,
    });
  } catch(e) {
    console.error("❌ doSyncAjax error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Map View ──────────────────────────────────────────────────
export const mapLauncher = async (req, res) => {
  try {
    const DOMAIN    = req.query.DOMAIN    || req.body.DOMAIN    || "world.bitrix24.com";
    const member_id = req.query.member_id || req.body.member_id || "";
    res.setHeader("ngrok-skip-browser-warning", "true");
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) {
      return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    }
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("map.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ mapLauncher error:", e.message);
    return res.status(500).send(`<html><body><h3 style="color:red;padding:20px">Error: ${e.message}</h3></body></html>`);
  }
};

export const mapData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id, company_name } = company;
    const synced    = loadSynced();
    const syncedIds = Object.keys((synced[member_id]||{}).clients||{});

    const [cRows, mRows, agentRows, totalTrackedRows, totalClientsRow] = await Promise.all([
      pool.query(
        `SELECT id, name, email, phone, address, pincode, status, latitude, longitude
         FROM clients WHERE company_id=$1
         AND latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY name ASC`, [company_id]
      ),
      pool.query(
        `SELECT m.id, m.client_id, m.start_time, m.status, m.comments,
                m.start_latitude AS lat, m.start_longitude AS lng,
                c.name AS client_name
         FROM meetings m JOIN clients c ON m.client_id=c.id
         WHERE m.company_id=$1
           AND m.start_latitude IS NOT NULL AND m.start_longitude IS NOT NULL
         ORDER BY m.start_time DESC LIMIT 200`, [company_id]
      ),
      pool.query(
        `SELECT DISTINCT ON (u.id)
                u.id          AS user_id,
                COALESCE(p.full_name, u.email) AS full_name,
                u.email,
                ll.latitude, ll.longitude,
                COALESCE(u.pincode, ll.pincode) AS pincode,
                ll.battery, ll.timestamp
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         LEFT JOIN location_logs ll ON ll.user_id = u.id
         WHERE u.company_id = $1
           AND u.is_admin = false
         ORDER BY u.id, ll.timestamp DESC NULLS LAST`, [company_id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT COUNT(DISTINCT ll.user_id) AS total_tracked
         FROM location_logs ll
         JOIN users u ON u.id = ll.user_id
         WHERE u.company_id = $1`, [company_id]
      ).catch(() => ({ rows: [{ total_tracked: 0 }] })),
      pool.query(
        `SELECT COUNT(*) AS total FROM clients WHERE company_id=$1`, [company_id]
      ).catch(() => ({ rows: [{ total: 0 }] })),
    ]);

    const NOW_MS = Date.now();
    const agents = agentRows.rows.map(a => ({
      user_id:   String(a.user_id),
      full_name: a.full_name || a.email || 'Unknown',
      email:     a.email,
      pincode:   a.pincode || null,
      battery:   a.battery != null ? parseInt(a.battery) : null,
      timestamp: a.timestamp,
      lat:       a.latitude  ? parseFloat(a.latitude)  : null,
      lng:       a.longitude ? parseFloat(a.longitude) : null,
      is_online: a.timestamp
        ? (NOW_MS - new Date(a.timestamp).getTime()) < 30 * 60 * 1000
        : false,
    }));

    const totalTracked = parseInt(totalTrackedRows.rows[0]?.total_tracked || 0);
    const meetingsArr  = mRows.rows.map(m => ({
      id: m.id, client_name: m.client_name, status: m.status,
      comments: m.comments, start_time: m.start_time,
      lat: parseFloat(m.lat), lng: parseFloat(m.lng),
    }));
    const qvTotal      = meetingsArr.length;
    const qvSuccessful = meetingsArr.filter(m => m.status === 'COMPLETED').length;

    return res.json({
      company: company_name,
      clients: cRows.rows.map(c => ({
        id: c.id, name: c.name, email: c.email,
        phone: c.phone, address: c.address, pincode: c.pincode,
        status: c.status,
        lat: parseFloat(c.latitude), lng: parseFloat(c.longitude),
        synced: syncedIds.includes(String(c.id)),
      })),
      meetings: meetingsArr,
      agents,
      quick_visits: { total: qvTotal, successful: qvSuccessful },
      total_tracked: totalTracked,
      total_clients: parseInt(totalClientsRow.rows[0]?.total || 0),
      online_count: agents.filter(a => a.is_online).length,
      online_clients: (() => {
        const onlineAgents = agents.filter(a => a.is_online);
        if (onlineAgents.length === 0) return 0;
        const onlinePincodes = new Set(
          onlineAgents.filter(a => a.pincode).map(a => String(a.pincode).trim())
        );
        const matched = new Set();
        cRows.rows.forEach(c => {
          if (!c) return;
          const cPin = c.pincode ? String(c.pincode).trim() : null;
          if (cPin && onlinePincodes.has(cPin)) { matched.add(c.id); return; }
          if (c.latitude != null && c.longitude != null) {
            for (const a of onlineAgents) {
              if (a.lat == null || a.lng == null) continue;
              const dLat = (parseFloat(c.latitude) - a.lat) * 111;
              const dLng = (parseFloat(c.longitude) - a.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
              const dist = Math.sqrt(dLat * dLat + dLng * dLng);
              if (dist <= 5) { matched.add(c.id); break; }
            }
          }
        });
        return matched.size;
      })(),
    });
  } catch(e) {
    console.error("❌ mapData error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const getStatus = (req, res) => {
  try {
    const tokens = loadAllTokens();
    const synced = loadSynced();
    const config = loadConfig();
    const portals = Object.keys(tokens).map(mid => ({
      memberId: mid, domain: tokens[mid].domain,
      company:  config[mid]?.company_name || config[mid]?.email || null,
      clientsSynced:  Object.keys(synced[mid]?.clients||{}).length,
      meetingsSynced: Object.keys(synced[mid]?.meetings||{}).length,
    }));
    return res.json({ connectedPortals: portals.length, portals });
  } catch(e) { return res.status(500).json({ error: e.message }); }
};

export const webhookHandler = (req, res) => {
  console.log(`📩 Webhook: event=${req.body?.event} member=${req.body?.auth?.member_id}`);
  return res.status(200).json({ ok: true });
};

// ── Legacy ────────────────────────────────────────────────────
export const saveEmail        = async (req, res) => res.json({ ok: true, note: "Use /select-company instead" });
export const connectEmail     = async (req, res) => res.redirect(`/bitrix/app?DOMAIN=${req.body.DOMAIN||""}&member_id=${req.body.member_id||""}`);
export const connectEmailAjax = async (req, res) => res.json({ ok: true, note: "Use /select-company-ajax instead" });
export const resetEmail       = async (req, res) => resetCompany(req, res);
export const doSync           = async (req, res) => {
  const { member_id, DOMAIN, type } = req.body;
  if (type === "refresh" || type === "reset") return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN||""}&member_id=${member_id||""}`);
  req.body.type = type;
  return doSyncAjax(req, res);
};
export const syncClients         = async (req, res) => res.json({ ok: true });
export const syncMeetings        = async (req, res) => res.json({ ok: true });
export const syncClientsInternal = async (req, res) => res.json({ ok: true });
export const syncMeetingsInternal= async (req, res) => res.json({ ok: true });

// ── Haversine distance (meters) ───────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Journey Launcher ──────────────────────────────────────────
export const journeyLauncher = async (req, res) => {
  try {
    const DOMAIN    = req.query.DOMAIN    || "world.bitrix24.com";
    const member_id = req.query.member_id || "";
    res.setHeader("ngrok-skip-browser-warning", "true");
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) {
      return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    }
    const company_id_param = req.query.company_id || String(company.company_id);
    const html = renderView("journey.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ journeyLauncher:", e.message);
    return res.status(500).send(`<html><body><h3 style="color:red;padding:20px">Error: ${e.message}</h3></body></html>`);
  }
};

export const journeyAgents = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id, company_name } = company;
    const r = await pool.query(
      `SELECT p.user_id, p.full_name, u.email
       FROM profiles p
       JOIN users u ON p.user_id = u.id
       WHERE u.company_id = $1
       ORDER BY p.full_name ASC`, [company_id]
    );
    if (!r.rows.length) {
      const r2 = await pool.query(
        `SELECT id AS user_id, email AS full_name, email
         FROM users WHERE company_id=$1 AND role != 'admin' ORDER BY email ASC`, [company_id]
      ).catch(() => ({ rows: [] }));
      return res.json({ company: company_name, agents: r2.rows });
    }
    return res.json({ company: company_name, agents: r.rows });
  } catch(e) {
    console.error("❌ journeyAgents:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const journeyData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, user_id, start, end } = req.query;
    if (!member_id || !user_id) return res.status(400).json({ error: "member_id and user_id required" });
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const startDate = start || new Date().toISOString().slice(0, 10);
    const endDate   = end   || new Date().toISOString().slice(0, 10);
    const endDateInc = new Date(endDate);
    endDateInc.setDate(endDateInc.getDate() + 1);
    const endDateStr = endDateInc.toISOString().slice(0, 10);
    let logsRows = [];
    const logsQueries = [
      `SELECT id, latitude, longitude, timestamp, pincode, accuracy FROM location_logs WHERE user_id = $1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp ASC`,
      `SELECT id, latitude, longitude, created_at AS timestamp, pincode FROM location_logs WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at ASC`,
      `SELECT id, latitude, longitude, recorded_at AS timestamp FROM location_logs WHERE user_id = $1 AND recorded_at >= $2 AND recorded_at < $3 ORDER BY recorded_at ASC`,
    ];
    for (const q of logsQueries) {
      try { const r = await pool.query(q, [user_id, startDate, endDateStr]); logsRows = r.rows; break; } catch(e) {}
    }
    let mtgRows = [];
    try {
      const r = await pool.query(
        `SELECT m.id, m.start_time, m.end_time, m.status, m.comments,
                m.start_latitude, m.start_longitude,
                m.distance_to_client, m.location_verified,
                c.name AS client_name, c.latitude AS client_lat, c.longitude AS client_lng
         FROM meetings m JOIN clients c ON m.client_id = c.id
         WHERE m.user_id = $1 AND m.company_id = $2 AND m.start_time >= $3 AND m.start_time < $4
         ORDER BY m.start_time ASC`, [user_id, company_id, startDate, endDateStr]
      );
      mtgRows = r.rows;
    } catch(e) {
      try {
        const r = await pool.query(
          `SELECT m.id, m.start_time, m.end_time, m.status, m.comments,
                  m.start_latitude, m.start_longitude, c.name AS client_name
           FROM meetings m JOIN clients c ON m.client_id = c.id
           WHERE m.user_id = $1 AND m.company_id = $2 AND m.start_time >= $3 AND m.start_time < $4
           ORDER BY m.start_time ASC`, [user_id, company_id, startDate, endDateStr]
        );
        mtgRows = r.rows;
      } catch(e2) { console.error("❌ meetings query:", e2.message); }
    }
    const logsCount = logsRows.length, meetingsCount = mtgRows.length;
    const clientsVisited = mtgRows.filter(m => m.status === "COMPLETED").length;
    let totalDistanceM = 0;
    for (let i = 1; i < logsRows.length; i++) {
      const a = logsRows[i - 1], b = logsRows[i];
      if (a.latitude && a.longitude && b.latitude && b.longitude)
        totalDistanceM += haversine(+a.latitude, +a.longitude, +b.latitude, +b.longitude);
    }
    const totalDistanceKm = +(totalDistanceM / 1000).toFixed(1);
    let totalDurationMins = 0;
    if (logsRows.length >= 2) {
      const t1 = new Date(logsRows[0].timestamp).getTime();
      const t2 = new Date(logsRows[logsRows.length - 1].timestamp).getTime();
      totalDurationMins = +((t2 - t1) / 60000).toFixed(1);
    }
    return res.json({ userId: user_id, dateRange: { start: startDate, end: endDate }, logsCount, meetingsCount, clientsVisited, totalDistanceKm, totalDurationMins, locationLogs: logsRows, meetings: mtgRows });
  } catch(e) {
    console.error("❌ journeyData:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Clients ───────────────────────────────────────────────────
export const clientsLauncher = async (req, res) => {
  try {
    const DOMAIN    = req.query.DOMAIN    || req.body.DOMAIN    || "world.bitrix24.com";
    const member_id = req.query.member_id || req.body.member_id || "";
    res.setHeader("ngrok-skip-browser-warning", "true");
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) {
      return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    }
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("clients.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ clientsLauncher:", e.message);
    return res.status(500).send(`<html><body><h3 style="color:red;padding:20px">Error: ${e.message}</h3></body></html>`);
  }
};

export const clientsData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id, company_name } = company;
    const synced    = loadSynced();
    const syncedIds = Object.keys((synced[member_id]?.clients) || {});
    const { rows: clientRows } = await pool.query(
      `SELECT id, name, email, phone, address, pincode, status,
              latitude AS lat, longitude AS lng, created_at
       FROM clients WHERE company_id = $1 ORDER BY name ASC`, [company_id]
    );
    const { rows: visitRows } = await pool.query(
      `SELECT client_id, MAX(start_time) AS last_visit FROM meetings WHERE company_id = $1 GROUP BY client_id`, [company_id]
    ).catch(() => ({ rows: [] }));
    const visitMap = {};
    visitRows.forEach(v => { visitMap[String(v.client_id)] = v.last_visit; });
    const clients = clientRows.map(c => ({
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      address: c.address, pincode: c.pincode, status: c.status,
      lat: c.lat ? parseFloat(c.lat) : null, lng: c.lng ? parseFloat(c.lng) : null,
      created_at: c.created_at, last_visit: visitMap[String(c.id)] || null,
      source: null, synced: syncedIds.includes(String(c.id)),
    }));
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    return res.json({ company: company_name, clients, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ clientsData:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const clientsSave = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, id, name, email, phone, address, pincode, status } = req.body;
    if (!member_id || !name) return res.status(400).json({ error: "member_id and name required" });
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "No company configured" });
    const { company_id } = company;
    if (id) {
      await pool.query(
        `UPDATE clients SET name=$1, email=$2, phone=$3, address=$4, pincode=$5, status=$6 WHERE id=$7 AND company_id=$8`,
        [name, email||null, phone||null, address||null, pincode||null, status||"active", id, company_id]
      );
      return res.json({ ok: true, action: "updated", id });
    } else {
      const r = await pool.query(
        `INSERT INTO clients (company_id, name, email, phone, address, pincode, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
        [company_id, name, email||null, phone||null, address||null, pincode||null, status||"active"]
      );
      return res.json({ ok: true, action: "created", id: r.rows[0].id });
    }
  } catch(e) {
    console.error("❌ clientsSave:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Client Services ───────────────────────────────────────────
async function ensureServicesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_services (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL,
      client_id    UUID    REFERENCES clients(id) ON DELETE CASCADE,
      service_name TEXT    NOT NULL,
      description  TEXT,
      price        NUMERIC(12,2),
      status       TEXT    DEFAULT 'active',
      start_date   DATE,
      expiry_date  DATE,
      created_at   TIMESTAMP WITH TIME ZONE DEFAULT now(),
      updated_at   TIMESTAMP WITH TIME ZONE DEFAULT now()
    )
  `);
}

export const servicesLauncher = async (req, res) => {
  try {
    const DOMAIN    = req.query.DOMAIN    || req.body.DOMAIN    || "world.bitrix24.com";
    const member_id = req.query.member_id || req.body.member_id || "";
    res.setHeader("ngrok-skip-browser-warning", "true");
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) {
      return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    }
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("client.services.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ servicesLauncher:", e.message);
    return res.status(500).send(`<html><body><h3 style="color:red;padding:20px">Error: ${e.message}</h3></body></html>`);
  }
};

export const servicesData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id, company_name } = company;
    await ensureServicesTable();
    const { rows: serviceRows } = await pool.query(
      `SELECT s.id, s.service_name, s.description, s.price, s.status,
              s.start_date, s.expiry_date, s.client_id,
              c.name  AS client_name, c.email AS client_email
       FROM client_services s
       LEFT JOIN clients c ON s.client_id = c.id
       WHERE s.company_id = $1
       ORDER BY s.expiry_date ASC NULLS LAST`, [company_id]
    );
    const { rows: clientRows } = await pool.query(
      `SELECT id, name, email FROM clients WHERE company_id = $1 AND status = 'active' ORDER BY name ASC`, [company_id]
    );
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    return res.json({ company: company_name, services: serviceRows, clients: clientRows, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ servicesData:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const servicesSave = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, id, service_name, description, client_id, price, status, start_date, expiry_date } = req.body;
    if (!member_id || !service_name || !client_id) {
      return res.status(400).json({ error: "member_id, service_name and client_id required" });
    }
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "No company configured" });
    const { company_id } = company;
    await ensureServicesTable();
    if (id) {
      await pool.query(
        `UPDATE client_services SET service_name=$1, description=$2, client_id=$3, price=$4, status=$5, start_date=$6, expiry_date=$7, updated_at=now() WHERE id=$8 AND company_id=$9`,
        [service_name, description||null, client_id, price||null, status||"active", start_date||null, expiry_date||null, id, company_id]
      );
      return res.json({ ok: true, action: "updated", id });
    } else {
      const r = await pool.query(
        `INSERT INTO client_services (company_id, client_id, service_name, description, price, status, start_date, expiry_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [company_id, client_id, service_name, description||null, price||null, status||"active", start_date||null, expiry_date||null]
      );
      return res.json({ ok: true, action: "created", id: r.rows[0].id });
    }
  } catch(e) {
    console.error("❌ servicesSave:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Team Activity ─────────────────────────────────────────────
async function ensureIsPaidColumn() {
  try {
    const chk = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='trip_expenses' AND table_schema='public' AND column_name='is_paid'`);
    if (!chk.rows.length) {
      await pool.query(`ALTER TABLE trip_expenses ADD COLUMN is_paid BOOLEAN DEFAULT false`);
      console.log('✅ ensureIsPaidColumn: is_paid column added');
    }
  } catch(e) { console.warn('⚠️  ensureIsPaidColumn:', e.message); }
}

async function ensureCompanyIdColumns() {
  try { await pool.query(`ALTER TABLE location_logs  ADD COLUMN IF NOT EXISTS company_id INTEGER`); } catch(e) {}
  try { await pool.query(`ALTER TABLE meetings        ADD COLUMN IF NOT EXISTS company_id INTEGER`); } catch(e) {}
  try { await pool.query(`ALTER TABLE trip_expenses   ADD COLUMN IF NOT EXISTS company_id INTEGER`); } catch(e) {}
}

export const teamActivityLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id  = req.body?.member_id || req.query?.member_id || "";
    const DOMAIN     = req.body?.DOMAIN    || req.query?.DOMAIN    || "world.bitrix24.com";
    const company_id_param = req.query.company_id || req.body?.company_id || "";
    const html = renderView("team.activity.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ teamActivityLauncher:", e.message);
    return res.status(500).send("<pre>teamActivityLauncher Error: " + e.message + "</pre>");
  }
};

export const teamData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY", users: [] });
    const { company_id, company_name } = company;
    await ensureCompanyIdColumns();
    let { rows: users } = await pool.query(
      `SELECT DISTINCT ON (u.id) u.id AS user_id, u.email, u.pincode AS user_pincode, p.full_name, p.department
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.company_id = $1
       ORDER BY u.id, COALESCE(p.full_name, u.email) ASC`, [company_id]
    );
    if (!users.length) {
      try {
        const fallback = await pool.query(
          `SELECT DISTINCT ON (u.id) u.id AS user_id, u.email, u.pincode AS user_pincode, p.full_name, p.department
           FROM users u LEFT JOIN profiles p ON p.user_id = u.id
           WHERE u.id IN (
             SELECT DISTINCT user_id FROM location_logs WHERE company_id = $1
             UNION SELECT DISTINCT user_id FROM meetings WHERE company_id = $1
             UNION SELECT DISTINCT user_id FROM trip_expenses WHERE company_id = $1
           )
           ORDER BY u.id, COALESCE(p.full_name, u.email) ASC`, [company_id]
        );
        users = fallback.rows;
      } catch(e2) { console.warn('⚠️  teamData UNION fallback failed:', e2.message); }
    }
    if (!users.length) return res.json({ company: company_name, users: [] });
    const userIds = users.map(u => u.user_id);
    const { rows: lastLogs } = await pool.query(
      `SELECT user_id::text, MAX(timestamp) AS last_log_time,
              (array_agg(pincode ORDER BY timestamp DESC) FILTER (WHERE pincode IS NOT NULL))[1] AS last_pincode
       FROM location_logs WHERE user_id = ANY($1::uuid[]) GROUP BY user_id`, [userIds]
    );
    const logMap = {};
    lastLogs.forEach(r => { logMap[r.user_id] = r; });
    const { rows: meetRows } = await pool.query(
      `SELECT user_id::text, COUNT(*) AS total_meetings, COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed_meetings
       FROM meetings WHERE user_id = ANY($1::uuid[]) GROUP BY user_id`, [userIds]
    );
    const meetMap = {};
    meetRows.forEach(r => { meetMap[String(r.user_id)] = r; });
    const { rows: expRows } = await pool.query(
      `SELECT user_id::text, COALESCE(SUM(amount_spent), 0) AS total_expenses
       FROM trip_expenses WHERE user_id = ANY($1::uuid[]) GROUP BY user_id`, [userIds]
    );
    const expMap = {};
    expRows.forEach(r => { expMap[r.user_id] = r; });
    const now = Date.now();
    const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const enriched = users.map(u => {
      const uid = String(u.user_id);
      const log = logMap[uid] || {};
      const lastLog = log.last_log_time ? new Date(log.last_log_time) : null;
      const isActive = lastLog && (now - lastLog.getTime()) < ACTIVE_WINDOW_MS;
      const lastSeenTime = lastLog
        ? lastLog.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + ", "
          + lastLog.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })
        : null;
      return {
        user_id: uid, email: u.email, full_name: u.full_name || u.email.split("@")[0],
        department: u.department || null, is_clocked_in: !!isActive,
        last_seen_time: lastSeenTime, last_pincode: log.last_pincode || u.user_pincode || null,
        total_meetings: parseInt(meetMap[uid]?.total_meetings || 0),
        completed_meetings: parseInt(meetMap[uid]?.completed_meetings || 0),
        total_expenses: parseFloat(expMap[uid]?.total_expenses || 0),
      };
    });
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    return res.json({ company: company_name, users: enriched, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ teamData:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const teamLogsLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id  = req.body?.member_id || req.query?.member_id || "";
    const DOMAIN     = req.body?.DOMAIN    || req.query?.DOMAIN    || "world.bitrix24.com";
    const user_id    = req.body?.user_id   || req.query?.user_id   || "";
    const user_name  = req.body?.user_name || req.query?.user_name || "User";
    const company_id_param = req.query.company_id || req.body?.company_id || "";
    if (!user_id) {
      console.warn("⚠️  teamLogsLauncher: no user_id — redirecting");
      return res.redirect(`/bitrix/team-activity?DOMAIN=${encodeURIComponent(DOMAIN)}&member_id=${encodeURIComponent(member_id)}`);
    }
    const html = renderView("team.logs.html", { member_id, DOMAIN, user_id, user_name, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ teamLogsLauncher:", e.message);
    return res.status(500).send("<pre>teamLogsLauncher Error: " + e.message + "</pre>");
  }
};

export const teamLogsData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id required" });
    const cleanUID = String(user_id).trim();
    if (!isValidUUID(cleanUID)) {
      return res.status(400).json({ error: "invalid_user_id", detail: `"${cleanUID}" is not a valid UUID`, logs: [] });
    }
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY", logs: [] });
    const { company_id, company_name } = company;
    let { rows: logs } = await pool.query(
      `SELECT id, latitude, longitude, accuracy, activity, notes, pincode, battery, timestamp
       FROM location_logs WHERE user_id = $1::uuid AND company_id = $2 ORDER BY timestamp DESC LIMIT 500`,
      [cleanUID, company_id]
    ).catch(() => ({ rows: [] }));
    if (!logs.length) {
      const fallback = await pool.query(
        `SELECT id, latitude, longitude, accuracy, activity, notes, pincode, battery, timestamp
         FROM location_logs WHERE user_id = $1::uuid ORDER BY timestamp DESC LIMIT 500`, [cleanUID]
      );
      logs = fallback.rows;
    }
    console.log(`📍 teamLogsData: user=${cleanUID} company=${company_id} found=${logs.length} logs`);
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    return res.json({ company: company_name, logs, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ teamLogsData:", e.message);
    return res.status(500).json({ error: e.message, logs: [] });
  }
};

export const teamMeetingsLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id  = req.body?.member_id || req.query?.member_id || "";
    const DOMAIN     = req.body?.DOMAIN    || req.query?.DOMAIN    || "world.bitrix24.com";
    const user_id    = req.body?.user_id   || req.query?.user_id   || "";
    const user_name  = req.body?.user_name || req.query?.user_name || "User";
    const company_id_param = req.query.company_id || req.body?.company_id || "";
    if (!user_id) {
      return res.redirect(`/bitrix/team-activity?DOMAIN=${encodeURIComponent(DOMAIN)}&member_id=${encodeURIComponent(member_id)}`);
    }
    const html = renderView("team.meetings.html", { member_id, DOMAIN, user_id, user_name, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ teamMeetingsLauncher:", e.message);
    return res.status(500).send("<pre>teamMeetingsLauncher Error: " + e.message + "</pre>");
  }
};

export const teamMeetingsData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id required" });
    const cleanUID = String(user_id).trim();
    if (!isValidUUID(cleanUID)) {
      return res.status(400).json({ error: "invalid_user_id", detail: `"${cleanUID}" is not a valid UUID`, meetings: [] });
    }
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY", meetings: [] });
    const { company_id, company_name } = company;
    let { rows: meetings } = await pool.query(
      `SELECT m.id, m.start_time, m.end_time, m.status, m.comments, m.attachments,
              m.start_latitude, m.start_longitude, m.end_latitude, m.end_longitude,
              c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.address AS client_address
       FROM meetings m LEFT JOIN clients c ON c.id = m.client_id
       WHERE m.user_id = $1::uuid AND m.company_id = $2 ORDER BY m.start_time DESC LIMIT 300`,
      [cleanUID, company_id]
    ).catch(() => ({ rows: [] }));
    if (!meetings.length) {
      const fallback = await pool.query(
        `SELECT m.id, m.start_time, m.end_time, m.status, m.comments, m.attachments,
                m.start_latitude, m.start_longitude, m.end_latitude, m.end_longitude,
                c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.address AS client_address
         FROM meetings m LEFT JOIN clients c ON c.id = m.client_id
         WHERE m.user_id = $1::uuid ORDER BY m.start_time DESC LIMIT 300`, [cleanUID]
      );
      meetings = fallback.rows;
    }
    console.log(`📅 teamMeetingsData: user=${cleanUID} company=${company_id} found=${meetings.length} meetings`);
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    return res.json({ company: company_name, meetings, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ teamMeetingsData:", e.message);
    return res.status(500).json({ error: e.message, meetings: [] });
  }
};

export const teamExpensesLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id  = req.body?.member_id || req.query?.member_id || "";
    const DOMAIN     = req.body?.DOMAIN    || req.query?.DOMAIN    || "world.bitrix24.com";
    const user_id    = req.body?.user_id   || req.query?.user_id   || "";
    const user_name  = req.body?.user_name || req.query?.user_name || "User";
    const company_id_param = req.query.company_id || req.body?.company_id || "";
    if (!user_id) {
      return res.redirect(`/bitrix/team-activity?DOMAIN=${encodeURIComponent(DOMAIN)}&member_id=${encodeURIComponent(member_id)}`);
    }
    const html = renderView("team.expenses.html", { member_id, DOMAIN, user_id, user_name, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ teamExpensesLauncher:", e.message);
    return res.status(500).send("<pre>teamExpensesLauncher Error: " + e.message + "</pre>");
  }
};

export const teamExpensesData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id required" });
    const cleanUID = String(user_id).trim();
    if (!isValidUUID(cleanUID)) return res.status(400).json({ error: "invalid_user_id", expenses: [], summary: {} });
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY", expenses: [], summary: {} });
    const { company_id, company_name } = company;
    await ensureIsPaidColumn();
    const { rows: colRows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trip_expenses' AND table_schema = 'public'`).catch(() => ({ rows: [] }));
    const cols = new Set(colRows.map(r => r.column_name));
    function col(hasIt, ifYes, ifNo) { return hasIt ? ifYes : ifNo; }
    const selParts = [
      'e.id', 'e.user_id',
      col(cols.has('start_location'), 'e.start_location', 'NULL AS start_location'),
      col(cols.has('end_location'),   'e.end_location',   'NULL AS end_location'),
      col(cols.has('travel_date'),    'e.travel_date',    'NULL AS travel_date'),
      col(cols.has('distance_km'),    'e.distance_km',    '0 AS distance_km'),
      col(cols.has('transport_mode'), 'e.transport_mode', 'NULL AS transport_mode'),
      col(cols.has('amount_spent'),   'e.amount_spent',   '0 AS amount_spent'),
      col(cols.has('currency'),       "COALESCE(e.currency,'₹') AS currency", "'₹' AS currency"),
      col(cols.has('notes'),          'e.notes',          'NULL AS notes'),
      col(cols.has('client_id'),      'e.client_id',      'NULL AS client_id'),
      col(cols.has('created_at'),     'e.created_at',     'NULL AS created_at'),
      cols.has('receipt_images') ? 'COALESCE(e.receipt_images, ARRAY[]::text[]) AS receipt_images'
        : cols.has('receipt_urls') ? 'COALESCE(e.receipt_urls, ARRAY[]::text[]) AS receipt_images'
        : 'ARRAY[]::text[] AS receipt_images',
      (cols.has('is_paid') && cols.has('payment_status'))
        ? "CASE WHEN e.is_paid IS TRUE OR UPPER(COALESCE(e.payment_status,''))='PAID' THEN 'true' ELSE 'false' END AS is_paid"
        : cols.has('is_paid') ? "CASE WHEN e.is_paid IS TRUE THEN 'true' ELSE 'false' END AS is_paid"
        : cols.has('payment_status') ? "CASE WHEN UPPER(COALESCE(e.payment_status,''))='PAID' THEN 'true' ELSE 'false' END AS is_paid"
        : "'false' AS is_paid",
      col(cols.has('trip_name'),    "COALESCE(e.trip_name,'') AS trip_name", "'' AS trip_name"),
      col(cols.has('is_multi_leg'), 'COALESCE(e.is_multi_leg,false) AS is_multi_leg', 'false AS is_multi_leg'),
      'c.name AS client_name',
    ];
    const sel = selParts.join(', ');
    let expenses = [];
    if (cols.has('company_id')) {
      const r1 = await pool.query(
        `SELECT ${sel} FROM trip_expenses e LEFT JOIN clients c ON c.id = e.client_id WHERE e.user_id = $1::uuid AND e.company_id = $2 ORDER BY e.created_at DESC LIMIT 200`,
        [cleanUID, company_id]
      ).catch(() => ({ rows: [] }));
      expenses = r1.rows;
    }
    if (!expenses.length) {
      const r2 = await pool.query(
        `SELECT ${sel} FROM trip_expenses e LEFT JOIN clients c ON c.id = e.client_id WHERE e.user_id = $1::uuid ORDER BY e.created_at DESC LIMIT 200`,
        [cleanUID]
      ).catch(() => ({ rows: [] }));
      expenses = r2.rows;
    }
    const multiIds = expenses.filter(e => e.is_multi_leg === true || e.is_multi_leg === 'true').map(e => e.id);
    const legsMap = {};
    if (multiIds.length) {
      const { rows: legs } = await pool.query(
        `SELECT expense_id, leg_number, start_location, end_location, distance_km, transport_mode, amount_spent, notes FROM trip_legs WHERE expense_id = ANY($1::uuid[]) ORDER BY expense_id, leg_number`,
        [multiIds]
      ).catch(() => ({ rows: [] }));
      legs.forEach(l => { (legsMap[l.expense_id] = legsMap[l.expense_id] || []).push(l); });
    }
    const isPaid = v => v === true || v === 't' || v === 'true' || v === 1 || v === '1' || (typeof v === 'string' && v.toUpperCase() === 'PAID');
    const enriched = expenses.map(e => ({
      ...e, receipt_images: Array.isArray(e.receipt_images) ? e.receipt_images : [],
      legs: legsMap[e.id] || [], is_paid: isPaid(e.is_paid),
      travel_date_display: e.travel_date
        ? new Date(typeof e.travel_date === 'string' && String(e.travel_date).length <= 13 ? parseInt(e.travel_date) : e.travel_date)
            .toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
        : '—',
    }));
    const total   = enriched.reduce((s, e) => s + parseFloat(e.amount_spent || 0), 0);
    const paidItems = enriched.filter(e => e.is_paid === true);
    const pendItems = enriched.filter(e => e.is_paid !== true);
    const paidAmt   = paidItems.reduce((s, e) => s + parseFloat(e.amount_spent || 0), 0);
    const pendAmt   = parseFloat((total - paidAmt).toFixed(2));
    const totalDist = enriched.reduce((s, e) => s + parseFloat(e.distance_km  || 0), 0);
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    return res.json({
      company: company_name, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase(),
      expenses: enriched,
      summary: {
        total_expenses: enriched.length, total_amount: parseFloat(total.toFixed(2)),
        paid_amount: parseFloat(paidAmt.toFixed(2)), pending_amount: pendAmt,
        total_distance: parseFloat(totalDist.toFixed(2)),
        paid_count: paidItems.length, pending_count: pendItems.length,
        avg_amount: enriched.length ? parseFloat((total / enriched.length).toFixed(2)) : 0,
      }
    });
  } catch(e) {
    console.error("❌ teamExpensesData:", e.message);
    return res.status(500).json({ error: e.message, expenses: [], summary: {} });
  }
};

export const teamExpensePay = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, expense_id } = req.body;
    if (!member_id || !expense_id) return res.status(400).json({ error: "member_id and expense_id required" });
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "No company configured" });
    const { company_id } = company;
    await ensureIsPaidColumn();
    const { rows: payColChk } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='trip_expenses' AND table_schema='public' AND column_name='company_id'`).catch(() => ({ rows: [] }));
    const hasCompanyCol = payColChk.length > 0;
    let updateResult = { rowCount: 0 };
    if (hasCompanyCol) {
      updateResult = await pool.query(`UPDATE trip_expenses SET is_paid = true WHERE id = $1::uuid AND company_id = $2`, [expense_id, company_id]).catch(() => ({ rowCount: 0 }));
    }
    if (!updateResult.rowCount) {
      updateResult = await pool.query(`UPDATE trip_expenses SET is_paid = true WHERE id = $1::uuid`, [expense_id]).catch(() => ({ rowCount: 0 }));
    }
    if (!updateResult.rowCount) return res.status(404).json({ error: "Expense not found" });
    return res.json({ ok: true, expense_id });
  } catch(e) {
    console.error("❌ teamExpensePay:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

export const teamExpensePayAll = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, user_id } = req.body;
    if (!member_id || !user_id) return res.status(400).json({ error: "member_id and user_id required" });
    if (!isValidUUID(String(user_id).trim())) return res.status(400).json({ error: "invalid_user_id" });
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "No company configured" });
    const { company_id } = company;
    await ensureIsPaidColumn();
    const { rows: colChk } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='trip_expenses' AND table_schema='public' AND column_name='company_id'`).catch(()=>({rows:[]}));
    const hasCol = colChk.length > 0;
    let result = { rowCount: 0 };
    if (hasCol) {
      result = await pool.query(`UPDATE trip_expenses SET is_paid = true WHERE user_id = $1::uuid AND (company_id = $2 OR company_id IS NULL) AND (is_paid IS NULL OR is_paid = false)`, [user_id, company_id]).catch(() => ({ rowCount: 0 }));
    }
    if (!result.rowCount) {
      result = await pool.query(`UPDATE trip_expenses SET is_paid = true WHERE user_id = $1::uuid AND (is_paid IS NULL OR is_paid = false)`, [user_id]).catch(() => ({ rowCount: 0 }));
    }
    await pool.query(`UPDATE trip_expenses SET payment_status = 'PAID' WHERE user_id = $1::uuid`, [user_id]).catch(()=>{});
    return res.json({ ok: true, updated: result.rowCount });
  } catch(e) {
    console.error("❌ teamExpensePayAll:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Debug ─────────────────────────────────────────────────────
export const debugCompany = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const config = loadConfig();
    const cached = config[member_id] || null;
    const resolved = member_id ? await resolveCompanyForRequest(req, member_id) : null;
    const { rows: companies } = await pool.query(
      `SELECT c.id, c.name, COUNT(u.id) AS user_count FROM companies c LEFT JOIN users u ON u.company_id = c.id GROUP BY c.id, c.name ORDER BY user_count DESC`
    );
    const mappings = Object.entries(config).map(([mid, cfg]) => ({
      member_id: mid, company_id: cfg.company_id, company_name: cfg.company_name,
    }));
    return res.json({ queried_member_id: member_id, cached_config: cached, resolved_company: resolved, all_companies: companies, all_mappings: mappings });
  } catch(e) { return res.status(500).json({ error: e.message }); }
};

export const debugTeam = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id, user_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    const result = { member_id, company, user_id, queries: {} };
    if (company?.company_id && user_id) {
      const cid = company.company_id, uid = String(user_id);
      result.queries.logs_by_user_only    = (await pool.query(`SELECT COUNT(*) AS cnt FROM location_logs WHERE user_id::text = $1`, [uid]).catch(e => ({ rows: [{ cnt: "ERROR: " + e.message }] }))).rows[0].cnt;
      result.queries.logs_with_company    = (await pool.query(`SELECT COUNT(*) AS cnt FROM location_logs WHERE user_id::text = $1 AND company_id = $2`, [uid, cid]).catch(e => ({ rows: [{ cnt: "ERROR: " + e.message }] }))).rows[0].cnt;
      result.queries.meetings_by_user_only= (await pool.query(`SELECT COUNT(*) AS cnt FROM meetings WHERE user_id::text = $1`, [uid]).catch(e => ({ rows: [{ cnt: "ERROR: " + e.message }] }))).rows[0].cnt;
      result.queries.meetings_with_company= (await pool.query(`SELECT COUNT(*) AS cnt FROM meetings WHERE user_id::text = $1 AND company_id = $2`, [uid, cid]).catch(e => ({ rows: [{ cnt: "ERROR: " + e.message }] }))).rows[0].cnt;
      result.queries.expenses_by_user_only= (await pool.query(`SELECT COUNT(*) AS cnt FROM trip_expenses WHERE user_id::text = $1`, [uid]).catch(e => ({ rows: [{ cnt: "ERROR: " + e.message }] }))).rows[0].cnt;
    }
    const r7 = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trip_expenses' ORDER BY ordinal_position`).catch(() => ({ rows: [] }));
    result.queries.trip_expenses_columns = r7.rows.map(r => r.column_name);
    const r8 = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'location_logs' ORDER BY ordinal_position`).catch(() => ({ rows: [] }));
    result.queries.location_logs_columns = r8.rows.map(r => r.column_name);
    return res.json(result);
  } catch(e) { return res.status(500).json({ error: e.message }); }
};

// ── User Management ───────────────────────────────────────────
export const userManagementLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id = req.query.member_id || req.body?.member_id || "";
    const DOMAIN    = req.query.DOMAIN    || req.body?.DOMAIN    || "world.bitrix24.com";
    const company   = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("user.management.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ userManagementLauncher:", e.message);
    return res.status(500).send("<pre>userManagementLauncher Error: " + e.message + "</pre>");
  }
};

export const userManagementData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY", users: [] });
    const { company_id, company_name } = company;
    const { rows: users } = await pool.query(
      `SELECT u.id, u.email, u.is_admin, u.is_super_admin, u.created_at, p.full_name, p.department, p.work_hours_start, p.work_hours_end
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.company_id = $1 ORDER BY u.created_at DESC`, [company_id]
    );
    const { rows: admins } = await pool.query(
      `SELECT u.id, u.email, u.is_admin, u.is_super_admin, p.full_name
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.company_id = $1 AND (u.is_admin = true OR u.is_super_admin = true)
       ORDER BY u.is_super_admin DESC, u.created_at ASC LIMIT 1`, [company_id]
    );
    console.log(`✅ userManagementData: ${users.length} users for company ${company_id}`);
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    res.json({ company: company_name, users, me: admins[0] || null, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ userManagementData:", e.message);
    res.status(500).json({ error: e.message });
  }
};

export const userManagementCreate = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { email, password, fullName, department, workHoursStart, workHoursEnd, isAdmin = false } = req.body;
    if (!email || !password) return res.status(400).json({ error: "MissingFields", message: "Email and password are required" });
    if (password.length < 6) return res.status(400).json({ error: "PasswordTooShort", message: "Password must be at least 6 characters" });
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: "EmailAlreadyExists", message: "A user with this email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      `INSERT INTO users (email, password, is_admin, company_id) VALUES ($1, $2, $3, $4) RETURNING id, email, is_admin, company_id, created_at`,
      [email, hashedPassword, !!isAdmin, company_id]
    );
    const user = userResult.rows[0];
    await pool.query(
      `INSERT INTO profiles (user_id, full_name, department, work_hours_start, work_hours_end) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, fullName || null, department || null, workHoursStart || null, workHoursEnd || null]
    );
    res.status(201).json({ message: "UserCreated", user: { ...user, full_name: fullName, department } });
  } catch(e) {
    console.error("❌ userManagementCreate:", e.message);
    res.status(500).json({ error: e.message });
  }
};

export const userManagementUpdate = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { userId, email, fullName, department, workHoursStart, workHoursEnd, isAdmin } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1 AND company_id = $2", [userId, company_id]);
    if (!userCheck.rows.length) return res.status(404).json({ error: "UserNotFound", message: "User not found in your company" });
    if (email !== undefined) {
      const emailCheck = await pool.query("SELECT id FROM users WHERE email = $1 AND id != $2", [email, userId]);
      if (emailCheck.rows.length > 0) return res.status(409).json({ error: "EmailAlreadyExists" });
      await pool.query("UPDATE users SET email = $1 WHERE id = $2", [email, userId]);
    }
    if (isAdmin !== undefined) await pool.query("UPDATE users SET is_admin = $1 WHERE id = $2", [!!isAdmin, userId]);
    await pool.query(
      `INSERT INTO profiles (user_id, full_name, department, work_hours_start, work_hours_end) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET full_name = COALESCE($2, profiles.full_name), department = COALESCE($3, profiles.department), work_hours_start = COALESCE($4, profiles.work_hours_start), work_hours_end = COALESCE($5, profiles.work_hours_end)`,
      [userId, fullName || null, department || null, workHoursStart || null, workHoursEnd || null]
    );
    res.json({ message: "UserUpdated" });
  } catch(e) {
    console.error("❌ userManagementUpdate:", e.message);
    res.status(500).json({ error: e.message });
  }
};

export const userManagementDelete = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const userCheck = await pool.query("SELECT id, email, is_super_admin FROM users WHERE id = $1 AND company_id = $2", [userId, company_id]);
    if (!userCheck.rows.length) return res.status(404).json({ error: "UserNotFound" });
    if (userCheck.rows[0].is_super_admin) {
      const superCount = await pool.query("SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_super_admin = true", [company_id]);
      if (parseInt(superCount.rows[0].count) <= 1) return res.status(400).json({ error: "CannotDeleteLastAdmin" });
    }
    const userEmail = userCheck.rows[0].email;
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    res.json({ message: "UserDeleted", email: userEmail });
  } catch(e) {
    console.error("❌ userManagementDelete:", e.message);
    res.status(500).json({ error: e.message });
  }
};

export const userManagementResetPassword = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { userId, newPassword } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "PasswordTooShort" });
    const userCheck = await pool.query("SELECT id, email FROM users WHERE id = $1 AND company_id = $2", [userId, company_id]);
    if (!userCheck.rows.length) return res.status(404).json({ error: "UserNotFound" });
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, userId]);
    try { await pool.query("DELETE FROM user_sessions WHERE user_id = $1 AND expires_at < NOW()", [userId]); } catch(_) {}
    res.json({ message: "PasswordReset", email: userCheck.rows[0].email });
  } catch(e) {
    console.error("❌ userManagementResetPassword:", e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── Bank Account ──────────────────────────────────────────────
async function ensureBankTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bank_accounts (
      id SERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL, holder_name TEXT, account_number TEXT, ifsc_code TEXT,
      bank_name TEXT, upi_id TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(), updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      UNIQUE(user_id)
    )
  `);
}

export const bankAccountLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id = req.query.member_id || req.body?.member_id || "";
    const DOMAIN    = req.query.DOMAIN    || req.body?.DOMAIN    || "world.bitrix24.com";
    const company   = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("bank.account.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ bankAccountLauncher:", e.message);
    return res.status(500).send("<pre>bankAccountLauncher Error: " + e.message + "</pre>");
  }
};

export const bankAccountData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY", users: [] });
    const { company_id, company_name } = company;
    await ensureBankTable();
    const { rows: users } = await pool.query(
      `SELECT u.id, u.email, u.created_at, p.full_name, p.department,
              b.holder_name, b.account_number, b.ifsc_code, b.bank_name, b.upi_id
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN user_bank_accounts b ON b.user_id = u.id
       WHERE u.company_id = $1 ORDER BY p.full_name ASC NULLS LAST, u.email ASC`, [company_id]
    );
    const { rows: admins } = await pool.query(
      `SELECT u.id, u.email, p.full_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.company_id = $1 AND (u.is_admin = true OR u.is_super_admin = true)
       ORDER BY u.is_super_admin DESC LIMIT 1`, [company_id]
    );
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    res.json({ company: company_name, users, me: admins[0] || null, current_plan: (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase() });
  } catch(e) {
    console.error("❌ bankAccountData:", e.message);
    res.status(500).json({ error: e.message });
  }
};

export const bankAccountSave = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { userId, holderName, accountNumber, ifscCode, bankName, upiId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1 AND company_id = $2", [userId, company_id]);
    if (!userCheck.rows.length) return res.status(404).json({ error: "UserNotFound" });
    await ensureBankTable();
    await pool.query(
      `INSERT INTO user_bank_accounts (user_id, company_id, holder_name, account_number, ifsc_code, bank_name, upi_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET holder_name=$3, account_number=$4, ifsc_code=$5, bank_name=$6, upi_id=$7, updated_at=now()`,
      [userId, company_id, holderName||null, accountNumber||null, ifscCode||null, bankName||null, upiId||null]
    );
    res.json({ message: "BankDetailsSaved" });
  } catch(e) {
    console.error("❌ bankAccountSave:", e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── Expand Capacity ───────────────────────────────────────────
async function ensureSlotOrdersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slot_orders (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL,
      user_slots INTEGER DEFAULT 0, client_slots INTEGER DEFAULT 0,
      total_amount NUMERIC(12,2) DEFAULT 0, payer_name TEXT, payer_email TEXT, payer_phone TEXT,
      status TEXT DEFAULT 'completed', created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )
  `);
  try { await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS user_limit INTEGER DEFAULT 1000`); } catch(_) {}
}

export const expandCapacityLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id = req.query.member_id || req.body?.member_id || "";
    const DOMAIN    = req.query.DOMAIN    || req.body?.DOMAIN    || "world.bitrix24.com";
    const company   = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("expand.capacity.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ expandCapacityLauncher:", e.message);
    return res.status(500).send("<pre>expandCapacityLauncher Error: " + e.message + "</pre>");
  }
};

export const expandCapacityData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id, company_name } = company;
    await ensureSlotOrdersTable();
    
    const { rows: uRows } = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE company_id = $1 AND is_admin = false AND is_super_admin = false", [company_id]);
    const { rows: cRows } = await pool.query("SELECT COUNT(*) AS cnt FROM clients WHERE company_id = $1", [company_id]);
    const { rows: limRows } = await pool.query("SELECT COALESCE(user_limit, 1000) AS user_limit, COALESCE(current_plan, 'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]).catch(() => ({ rows: [{ user_limit: 1000, current_plan: 'enterprise' }] }));
    
    // ── Fetch client limit from license API (same as billing page) ──
    let clientLimit = null;  // null = unlimited
    let clientLimitFromLicense = null;
    let userLimitFromLicense = null;
    let licenseData = null;
    let isClientUnlimited = false;
    
    const { rows: admins } = await pool.query(
      `SELECT u.id, u.email, u.is_admin, u.is_super_admin, p.full_name
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.company_id = $1 AND (u.is_admin = true OR u.is_super_admin = true)
       ORDER BY u.is_super_admin DESC LIMIT 1`, [company_id]
    );
    
    const adminUser = admins[0] || null;
    
    if (adminUser?.email) {
      try {
        // Get admin's auth token from user_sessions table
        const { rows: sessionRows } = await pool.query(
          `SELECT token FROM user_sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
          [adminUser.id]
        ).catch(() => ({ rows: [] }));

        const authToken = sessionRows[0]?.token || null;
        const authHeaders = authToken
          ? { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }
          : { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" };

        // Fetch license info from license API (same as billing page)
        const licenseResp = await axios.get(
          `https://geo-track-1.onrender.com/api/license/my-license`,
          { headers: authHeaders, timeout: 8000 }
        ).catch(() => ({ data: null }));
        
        if (licenseResp.data?.license) {
          const lic = licenseResp.data.license;
          licenseData = {
            plan: lic.plan,
            isActive: lic.isActive,
            isExpired: lic.isExpired,
            expiresAt: lic.expiresAt,
            maxLimits: lic.maxLimits || {}
          };
          
          // Get client limit from license maxLimits
          if (lic.maxLimits?.clients !== undefined) {
            clientLimitFromLicense = lic.maxLimits.clients;
            clientLimit = clientLimitFromLicense;
            isClientUnlimited = (clientLimit === null || clientLimit === 0);
          }
          
          // Also get user limit from license if available
          if (lic.maxLimits?.users !== undefined) {
            userLimitFromLicense = lic.maxLimits.users;
          }
          
          console.log(`✅ expandCapacityData: client_limit=${clientLimit}, is_unlimited=${isClientUnlimited} from license API`);
        }
        
        // Also fetch user count from license API for accurate max users
        const userCountResp = await axios.get(
          `https://geo-track-1.onrender.com/api/license/my-license/user-count`,
          { headers: authHeaders, timeout: 8000 }
        ).catch(() => ({ data: null }));
        
        if (userCountResp.data?.maxAllowedUsers) {
          userLimitFromLicense = userCountResp.data.maxAllowedUsers;
          console.log(`✅ expandCapacityData: user_limit=${userLimitFromLicense} from user-count API`);
        }
      } catch (licErr) {
        console.warn("⚠️ expandCapacityData: license API error:", licErr.message);
      }
    }
    
    // Fallback: determine client limit based on plan if license API fails
    if (clientLimit === null) {
      const plan = (limRows[0]?.current_plan || 'enterprise').toLowerCase();
      const planClientLimits = {
        starter: 100,
        professional: 500,
        business: 2000,
        enterprise: null  // null = unlimited
      };
      clientLimit = planClientLimits[plan] || null;
      isClientUnlimited = (clientLimit === null || clientLimit === 0);
      console.log(`📊 expandCapacityData: using fallback client_limit=${clientLimit || 'unlimited'} for plan=${plan}`);
    }
    
    // Use user limit from license if available, otherwise use DB value
    const userLimitNum = (userLimitFromLicense !== null && userLimitFromLicense > 0) 
      ? userLimitFromLicense 
      : parseInt(limRows[0]?.user_limit || 1000, 10);
    
    const userCount = parseInt(uRows[0].cnt, 10);
    const clientCount = parseInt(cRows[0].cnt, 10);
    const currentPlan = (limRows[0]?.current_plan || 'enterprise').toLowerCase();
    
    // Calculate remaining slots
    const userRemaining = Math.max(0, userLimitNum - userCount);
    const clientRemaining = isClientUnlimited ? null : Math.max(0, clientLimit - clientCount);
    
    // Calculate percentages for progress bars
    const userPercent = userLimitNum > 0 ? Math.min(100, (userCount / userLimitNum) * 100) : 0;
    const clientPercent = (!isClientUnlimited && clientLimit > 0) ? Math.min(100, (clientCount / clientLimit) * 100) : 100;
    
    // Get slot price based on current plan
    const slotPrices = {
      starter: 100,
      professional: 75,
      business: 60,
      enterprise: 50
    };
    const userSlotPrice = slotPrices[currentPlan] || 50;
    
    const planRes = await pool.query(
      "SELECT COALESCE(current_plan,'enterprise') AS current_plan FROM companies WHERE id = $1", [company_id]
    ).catch(() => ({ rows: [{ current_plan: 'enterprise' }] }));
    
    res.json({
      company: company_name,
      user_count: userCount,
      client_count: clientCount,
      user_limit: userLimitNum,
      client_limit: clientLimit,
      is_client_unlimited: isClientUnlimited,
      user_remaining: userRemaining,
      client_remaining: clientRemaining,
      user_percent: userPercent,
      client_percent: clientPercent,
      user_slot_price: userSlotPrice,
      current_plan: currentPlan,
      me: adminUser,
      license: licenseData
    });
  } catch(e) {
    console.error("❌ expandCapacityData:", e.message);
    res.status(500).json({ error: e.message });
  }
};
export const expandCapacityOrder = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { userSlots = 0, clientSlots = 0, totalAmount = 0, payerName, payerEmail, payerPhone } = req.body;
    if (userSlots < 0 || clientSlots < 0) return res.status(400).json({ error: "InvalidSlots" });
    if (userSlots === 0 && clientSlots === 0) return res.status(400).json({ error: "NoSlots" });
    await ensureSlotOrdersTable();
    await pool.query(
      `INSERT INTO slot_orders (company_id, user_slots, client_slots, total_amount, payer_name, payer_email, payer_phone, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
      [company_id, userSlots, clientSlots, totalAmount, payerName||null, payerEmail||null, payerPhone||null]
    );
    let newUserLimit = 1000;
    if (userSlots > 0) {
      const upd = await pool.query(
        `UPDATE companies SET user_limit = COALESCE(user_limit, 1000) + $1 WHERE id = $2 RETURNING COALESCE(user_limit, 1000) AS user_limit`,
        [userSlots, company_id]
      ).catch(() => null);
      if (upd?.rows?.length) newUserLimit = upd.rows[0].user_limit;
    }
    res.json({ message: "OrderPlaced", new_user_limit: newUserLimit, user_slots: userSlots, client_slots: clientSlots, total_amount: totalAmount });
  } catch(e) {
    console.error("❌ expandCapacityOrder:", e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── Billing Plans ─────────────────────────────────────────────
async function ensurePlanOrdersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_upgrade_orders (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, plan_key TEXT NOT NULL,
      payer_name TEXT, payer_email TEXT, payer_phone TEXT,
      status TEXT DEFAULT 'completed', created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )
  `);
}

export const billingPlansLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const member_id = req.query.member_id || req.body?.member_id || "";
    const DOMAIN    = req.query.DOMAIN    || req.body?.DOMAIN    || "world.bitrix24.com";
    const company   = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.redirect(`/bitrix/app?DOMAIN=${DOMAIN}&member_id=${member_id}`);
    const company_id_param = req.query.company_id || req.body?.company_id || String(company.company_id);
    const html = renderView("billing.plans.html", { member_id, DOMAIN, company_id: company_id_param });
    return res.send(html);
  } catch(e) {
    console.error("❌ billingPlansLauncher:", e.message);
    return res.status(500).send("<pre>billingPlansLauncher Error: " + e.message + "</pre>");
  }
};

// ── External License API constants ───────────────────────────────
// Same endpoints used in BillingPlansPage.js (React app)
const LICENSE_API_BASE  = "https://geo-track-1.onrender.com";
const LICENSES_API_BASE = "https://lisence-system.onrender.com";
const BILLING_PRODUCT_ID = "69589d3ba7306459dd47fd87";

export const billingPlansData = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(200).json({ error: "NO_COMPANY" });
    const { company_id, company_name } = company;

    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS current_plan TEXT DEFAULT 'enterprise'`).catch(() => {});

    // ── Step 1: All local DB queries in parallel ──────────────────
    const [uRes, cRes, mRes, mDoneRes, svcRes, expRes, logRes, planRes, admins] = await Promise.all([
      // Team members only — exclude admins (they don't consume user slots)
      pool.query(
        "SELECT COUNT(*) AS cnt FROM users WHERE company_id = $1 AND is_admin = false AND is_super_admin = false",
        [company_id]
      ),
      pool.query("SELECT COUNT(*) AS cnt FROM clients     WHERE company_id = $1", [company_id]),
      pool.query("SELECT COUNT(*) AS cnt FROM meetings    WHERE company_id = $1", [company_id]),
      pool.query("SELECT COUNT(*) AS cnt FROM meetings    WHERE company_id = $1 AND status = 'COMPLETED'", [company_id]),
      pool.query("SELECT COUNT(*) AS cnt FROM client_services WHERE company_id = $1", [company_id]).catch(() => ({ rows: [{ cnt: 0 }] })),
      pool.query("SELECT COUNT(*) AS cnt FROM trip_expenses   WHERE company_id = $1", [company_id]).catch(() => ({ rows: [{ cnt: 0 }] })),
      pool.query("SELECT COUNT(*) AS cnt FROM location_logs   WHERE company_id = $1", [company_id]).catch(() => ({ rows: [{ cnt: 0 }] })),
      pool.query(
        "SELECT COALESCE(current_plan,'enterprise') AS current_plan, COALESCE(user_limit,1000) AS user_limit FROM companies WHERE id = $1",
        [company_id]
      ).catch(() => ({ rows: [{ current_plan: 'enterprise', user_limit: 1000 }] })),
      pool.query(
        `SELECT u.id, u.email, u.is_admin, u.is_super_admin, p.full_name
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.company_id = $1 AND (u.is_admin = true OR u.is_super_admin = true)
         ORDER BY u.is_super_admin DESC LIMIT 1`,
        [company_id]
      ),
    ]);

    const adminUser     = admins.rows[0] || null;
    let   currentPlan   = (planRes.rows[0]?.current_plan || 'enterprise').toLowerCase();
    let   userLimit     = parseInt(planRes.rows[0]?.user_limit || 1000, 10);

    // ── Step 2: Fetch LIVE plan data from external license API ────
    // Uses the same endpoints as BillingPlansPage.js (React app).
    // Primary:  GET /api/license/my-license       → admin's current plan
    // Secondary: GET /api/license/my-license/user-count → live usage counts
    // Plans list: GET /api/license/licenses-by-product/:productId
    let liveLicense   = null;   // { plan, isActive, isExpired, expiresAt, licenseKey, maxLimits }
    let availablePlans = [];    // Array of license plan objects from the license system
    let liveUserCount  = null;  // { currentUsers, clientCount, ... }

    if (adminUser?.email) {
      try {
        // Try to get admin's auth token from user_sessions table
        const { rows: sessionRows } = await pool.query(
          `SELECT token FROM user_sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
          [adminUser.id]
        ).catch(() => ({ rows: [] }));

        const authToken = sessionRows[0]?.token || null;
        const authHeaders = authToken
          ? { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }
          : { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" };

        // Fetch current license + user counts in parallel
        const [licenseResp, userCountResp] = await Promise.allSettled([
          axios.get(`${LICENSE_API_BASE}/api/license/my-license`, { headers: authHeaders, timeout: 8000 }),
          axios.get(`${LICENSE_API_BASE}/api/license/my-license/user-count`, { headers: authHeaders, timeout: 8000 }),
        ]);

        if (licenseResp.status === 'fulfilled' && licenseResp.value?.data) {
          const ld = licenseResp.value.data;
          const lp = ld.license?.plan?.toLowerCase?.() || currentPlan;
          liveLicense = {
            plan:       lp,
            isActive:   ld.license?.isActive    ?? true,
            isExpired:  ld.license?.isExpired   ?? false,
            expiresAt:  ld.license?.expiresAt   || null,
            licenseKey: ld.license?.licenseKey  || null,
            maxLimits:  ld.license?.maxLimits   || null,
          };
          currentPlan = lp;
          // Sync plan back to DB so next load is instant
          pool.query(`UPDATE companies SET current_plan = $1 WHERE id = $2`, [currentPlan, company_id]).catch(() => {});
          // Also pick up user_limit from the live license if available
          if (ld.license?.maxLimits?.users) {
            userLimit = parseInt(ld.license.maxLimits.users, 10);
            pool.query(`UPDATE companies SET user_limit = $1 WHERE id = $2`, [userLimit, company_id]).catch(() => {});
          }
          console.log(`✅ billingPlansData: live plan="${currentPlan}" from license API`);
        } else {
          console.warn("⚠️ billingPlansData: could not fetch live license, using DB plan:", currentPlan);
        }

        if (userCountResp.status === 'fulfilled' && userCountResp.value?.data) {
          liveUserCount = userCountResp.value.data;
          // FIX: The /user-count API returns "maxAllowedUsers" (not "maxUsers").
          // Previous code checked liveUserCount.maxUsers which was always undefined.
          // Now we read all possible field names the API might use.
          const rawMax =
            liveUserCount.maxAllowedUsers ??  // ← actual field from logs
            liveUserCount.maxUsers        ??  // ← alternate name (future-proof)
            liveUserCount.maxAllowed      ??  // ← another possible alias
            null;
          if (rawMax !== null) {
            const parsedMax = parseInt(rawMax, 10);
            if (!isNaN(parsedMax) && parsedMax > 0) {
              userLimit = parsedMax;
              pool.query(`UPDATE companies SET user_limit = $1 WHERE id = $2`, [userLimit, company_id]).catch(() => {});
              console.log(`✅ billingPlansData: userLimit=${userLimit} from maxAllowedUsers`);
            }
          }
          console.log("✅ billingPlansData: live user count fetched:", liveUserCount);
        }
      } catch (licErr) {
        console.warn("⚠️ billingPlansData: license API error (non-fatal):", licErr.message);
      }
    }

    // ── Step 3: Fetch available plans list from license system ────
    try {
      const plansResp = await axios.get(
        `${LICENSES_API_BASE}/api/license/licenses-by-product/${BILLING_PRODUCT_ID}`,
        { headers: { "ngrok-skip-browser-warning": "true" }, timeout: 8000 }
      );
      availablePlans = plansResp.data?.licenses || [];
      console.log(`✅ billingPlansData: fetched ${availablePlans.length} available plans`);
    } catch (plansErr) {
      console.warn("⚠️ billingPlansData: could not fetch plans list:", plansErr.message);
    }

    let synced_count = 0;
    try { const synced = loadSynced(); synced_count = Object.keys((synced[member_id]||{}).clients||{}).length; } catch(_) {}

    // ── Step 4: Build unified response ───────────────────────────
    // Prefer live data from license API; fall back to local DB counts.
    res.json({
      company:              company_name,
      current_plan:         currentPlan,

      // Usage counts — prefer live API counts, fall back to local DB
      user_count:           liveUserCount?.currentUsers  ?? parseInt(uRes.rows[0].cnt, 10),
      client_count:         liveUserCount?.clientCount   ?? parseInt(cRes.rows[0].cnt, 10),
      user_limit:           userLimit,

      // Activity counts — always from local DB (license API doesn't have these)
      total_meetings:       parseInt(mRes.rows[0].cnt,    10),
      completed_meetings:   parseInt(mDoneRes.rows[0].cnt, 10),
      total_services:       parseInt(svcRes.rows[0].cnt,   10),
      total_expenses:       parseInt(expRes.rows[0].cnt,   10),
      location_logs:        parseInt(logRes.rows[0].cnt,   10),
      synced_count,

      // Live license details (null if API unreachable)
      license:              liveLicense,

      // Full plans list from license system — used by billing_plans.html
      // to render the Compare Plans grid with real prices/limits
      plans:                availablePlans,

      // Admin user info
      me:                   adminUser,
    });
  } catch(e) {
    console.error("❌ billingPlansData:", e.message);
    res.status(500).json({ error: e.message });
  }
};

export const billingPlansUpgrade = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { member_id } = req.query;
    const company = await resolveCompanyForRequest(req, member_id);
    if (!company?.company_id) return res.status(400).json({ error: "NO_COMPANY" });
    const { company_id } = company;
    const { plan, payerName, payerEmail, payerPhone } = req.body;
    if (!plan) return res.status(400).json({ error: "plan required" });
    const validPlans = ["starter", "professional", "business", "enterprise"];
    if (!validPlans.includes(plan)) return res.status(400).json({ error: "InvalidPlan" });
    await ensurePlanOrdersTable();
    await pool.query(
      `INSERT INTO plan_upgrade_orders (company_id, plan_key, payer_name, payer_email, payer_phone, status) VALUES ($1, $2, $3, $4, $5, 'completed')`,
      [company_id, plan, payerName||null, payerEmail||null, payerPhone||null]
    );
    try {
      await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS current_plan TEXT DEFAULT 'enterprise'`);
      await pool.query(`UPDATE companies SET current_plan = $1 WHERE id = $2`, [plan, company_id]);
    } catch(_) {}
    res.json({ message: "PlanUpgraded", plan });
  } catch(e) {
    console.error("❌ billingPlansUpgrade:", e.message);
    res.status(500).json({ error: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// BITRIX ADMIN LOGIN
// ═══════════════════════════════════════════════════════════════

export const bitrixLoginLauncher = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const DOMAIN    = req.query.DOMAIN    || req.body?.DOMAIN    || "world.bitrix24.com";
    const member_id = req.query.member_id || req.body?.member_id || "";
    const html = renderView("bitrix.login.html", { member_id, DOMAIN });
    return res.send(html);
  } catch(e) {
    console.error("❌ bitrixLoginLauncher:", e.message);
    return res.status(500).send(`<html><body><h3 style="color:red;padding:20px">Error: ${e.message}</h3></body></html>`);
  }
};

export const bitrixLogout = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  const DOMAIN    = req.query.DOMAIN    || "world.bitrix24.com";
  const member_id = req.query.member_id || "";
  const p = "?DOMAIN="+encodeURIComponent(DOMAIN)+"&member_id="+encodeURIComponent(member_id);
  return res.redirect("/bitrix/login"+p);
};

// ── bitrixLoginResolve ────────────────────────────────────────
export const bitrixLoginResolve = async (req, res) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  try {
    const { email, token } = req.body;
    if (!email || !token) return res.status(400).json({ error: "email and token are required" });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch(e) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const tokenEmail = payload.email || payload.sub || "";
    if (tokenEmail.toLowerCase() !== email.toLowerCase()) {
      return res.status(401).json({ error: "Token email mismatch" });
    }

    if (!payload.isAdmin && !payload.is_admin) {
      return res.status(403).json({ error: "Not authorized — admin access required" });
    }

    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.company_id, u.is_admin, u.is_super_admin,
              c.name AS company_name, p.full_name
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       LEFT JOIN profiles  p ON p.user_id = u.id
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email]
    );

    if (!rows.length) return res.status(404).json({ error: "User not found in database" });

    const user = rows[0];
    if (!user.is_admin && !user.is_super_admin) {
      return res.status(403).json({ error: "This account is not an admin" });
    }
    if (!user.company_id) {
      return res.status(404).json({ error: "No company linked to this account" });
    }

    console.log(`✅ bitrixLoginResolve: ${email} → company "${user.company_name}" (id=${user.company_id})`);
    return res.json({
      company_id:   user.company_id,
      company_name: user.company_name || "GeoTrack",
      user_id:      user.user_id,
      full_name:    user.full_name || email,
    });
  } catch(e) {
    console.error("❌ bitrixLoginResolve:", e.message);
    return res.status(500).json({ error: e.message });
  }
};