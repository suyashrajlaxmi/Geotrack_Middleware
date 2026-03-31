import { Router } from "express";
import {
  installGet, installPost, uninstall,
  appLauncher, selectCompany, selectCompanyAjax, resetCompany,
  journeyLauncher, journeyAgents, journeyData,
  appData, doSyncAjax,
  mapLauncher, mapData,
  getStatus, webhookHandler,
  // ── Clients + Client Services ──────────────────────────────
  clientsLauncher,  clientsData,       clientsSave,
  servicesLauncher, servicesData,      servicesSave,
  // ── Team Activity ──────────────────────────────────────────
  teamActivityLauncher, teamData,
  teamLogsLauncher,     teamLogsData,
  teamMeetingsLauncher, teamMeetingsData,
  teamExpensesLauncher, teamExpensesData, teamExpensePay,
  // ── Debug ──────────────────────────────────────────────────
  debugTeam,
  debugCompany,
  // ── Legacy ────────────────────────────────────────────────
  saveEmail, connectEmail, connectEmailAjax, resetEmail, doSync,
  syncClients, syncMeetings, syncClientsInternal, syncMeetingsInternal,
  // ── User Management ───────────────────────────────────────
  userManagementLauncher,
  userManagementData,
  userManagementCreate,
  userManagementUpdate,
  userManagementDelete,
  userManagementResetPassword,
  // ── Bank Account ──────────────────────────────────────────
  bankAccountLauncher,
  bankAccountData,
  bankAccountSave,
  // ── Expand Capacity ───────────────────────────────────────
  expandCapacityLauncher,
  expandCapacityData,
  expandCapacityOrder,
  // ── Billing Plans ─────────────────────────────────────────
  billingPlansLauncher,
  billingPlansData,
  billingPlansUpgrade,
  // ── Bitrix Admin Login ─────────────────────────────────────
  bitrixLoginLauncher,
  bitrixLogout,
  bitrixLoginResolve,      // ← NEW: resolves company_id for the logged-in admin
} from "../controllers/bitrix.controller.js";

import { authenticateToken }    from "../middleware/auth.js";
import { attachCompanyContext } from "../middleware/company.js";
import { asyncHandler }         from "../middleware/errorHandler.js";
import { blockTrialUserWrites } from "../middleware/trialUser.js";

const router = Router();

// ── Global middleware ─────────────────────────────────────────
router.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// ── Bitrix24 lifecycle ────────────────────────────────────────
router.get ("/install",   installGet);
router.post("/install",   asyncHandler(installPost));
router.post("/uninstall", asyncHandler(uninstall));
router.post("/webhook",   webhookHandler);
router.get ("/status",    getStatus);

// ── Admin Login ───────────────────────────────────────────────
// /login-resolve is the KEY fix: returns the specific company_id
// for the admin who just logged in, instead of always picking the
// "largest company" in the database.
router.all ("/login",         asyncHandler(bitrixLoginLauncher));
router.all ("/logout",        asyncHandler(bitrixLogout));
router.post("/login-resolve", asyncHandler(bitrixLoginResolve));   // ← NEW

// ── Core app pages ────────────────────────────────────────────
router.all ("/app",  asyncHandler(appLauncher));
router.all ("/map",  asyncHandler(mapLauncher));

// ── Clients ───────────────────────────────────────────────────
router.all ("/clients",         asyncHandler(clientsLauncher));
router.get ("/clients-data",    asyncHandler(clientsData));
router.post("/clients-save",    asyncHandler(clientsSave));

// ── Client Services ───────────────────────────────────────────
router.all ("/client-services", asyncHandler(servicesLauncher));
router.get ("/services-data",   asyncHandler(servicesData));
router.post("/services-save",   asyncHandler(servicesSave));

// ── Team Activity ─────────────────────────────────────────────
router.all ("/team-activity",      asyncHandler(teamActivityLauncher));
router.get ("/team-data",          asyncHandler(teamData));
router.all ("/team-logs",          asyncHandler(teamLogsLauncher));
router.get ("/team-logs-data",     asyncHandler(teamLogsData));
router.all ("/team-meetings",      asyncHandler(teamMeetingsLauncher));
router.get ("/team-meetings-data", asyncHandler(teamMeetingsData));
router.all ("/team-expenses",      asyncHandler(teamExpensesLauncher));
router.get ("/team-expenses-data", asyncHandler(teamExpensesData));
router.post("/team-expense-pay",   asyncHandler(teamExpensePay));

// ── User Management ───────────────────────────────────────────
router.all ("/user-management",                asyncHandler(userManagementLauncher));
router.get ("/user-management-data",           asyncHandler(userManagementData));
router.post("/user-management-create",         asyncHandler(userManagementCreate));
router.post("/user-management-update",         asyncHandler(userManagementUpdate));
router.post("/user-management-delete",         asyncHandler(userManagementDelete));
router.post("/user-management-reset-password", asyncHandler(userManagementResetPassword));

// ── Bank Account ──────────────────────────────────────────────
router.all ("/bank-account",      asyncHandler(bankAccountLauncher));
router.get ("/bank-account-data", asyncHandler(bankAccountData));
router.post("/bank-account-save", asyncHandler(bankAccountSave));

// ── Expand Capacity ───────────────────────────────────────────
router.all ("/expand-capacity",       asyncHandler(expandCapacityLauncher));
router.get ("/expand-capacity-data",  asyncHandler(expandCapacityData));
router.post("/expand-capacity-order", asyncHandler(expandCapacityOrder));

// ── Billing Plans ─────────────────────────────────────────────
router.all ("/billing-plans",         asyncHandler(billingPlansLauncher));
router.get ("/billing-plans-data",    asyncHandler(billingPlansData));
router.post("/billing-plans-upgrade", asyncHandler(billingPlansUpgrade));

// ── Debug ─────────────────────────────────────────────────────
router.get ("/debug-team",    asyncHandler(debugTeam));
router.get ("/debug-company", asyncHandler(debugCompany));

// ── Company picker ────────────────────────────────────────────
router.post("/select-company",      asyncHandler(selectCompany));
router.post("/select-company-ajax", asyncHandler(selectCompanyAjax));
router.post("/reset-company",       asyncHandler(resetCompany));

// ── Data APIs ─────────────────────────────────────────────────
router.get ("/data",           asyncHandler(appData));
router.get ("/map-data",       asyncHandler(mapData));
router.all ("/journey",        asyncHandler(journeyLauncher));
router.get ("/journey-agents", asyncHandler(journeyAgents));
router.get ("/journey-data",   asyncHandler(journeyData));

// ── Sync ──────────────────────────────────────────────────────
router.post("/do-sync-ajax", asyncHandler(doSyncAjax));

// ── Legacy ────────────────────────────────────────────────────
router.post("/config",         asyncHandler(saveEmail));
router.post("/connect",        asyncHandler(connectEmail));
router.post("/connect-ajax",   asyncHandler(connectEmailAjax));
router.post("/reset-email",    asyncHandler(resetEmail));
router.post("/do-sync",        asyncHandler(doSync));
router.post("/sync/clients/internal",  asyncHandler(syncClientsInternal));
router.post("/sync/meetings/internal", asyncHandler(syncMeetingsInternal));
router.post("/sync/clients",  authenticateToken, attachCompanyContext, blockTrialUserWrites, asyncHandler(syncClients));
router.post("/sync/meetings", authenticateToken, attachCompanyContext, blockTrialUserWrites, asyncHandler(syncMeetings));

export default router;