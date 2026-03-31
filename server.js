// server.js
// UPDATED: Added API key authentication support

import express from "express";
import cors from "cors";
import { pool } from "./db.js";
import { CORS_ORIGIN, PORT, API_KEY } from "./config/constants.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authenticateToken } from "./middleware/auth.js";
import { attachCompanyContext } from "./middleware/company.js";
import { attachPlanFeatures } from "./middleware/featureAuth.js";
import { startBackgroundGeocode } from "./utils/geocodeBatch.js";

// Route imports
import authRoutes from "./routes/auth.routes.js";
import clientRoutes from "./routes/clients.routes.js";
import locationRoutes from "./routes/location.routes.js";
import meetingRoutes from "./routes/meetings.routes.js";
import expenseRoutes from "./routes/expenses.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import syncRoutes from "./routes/sync.routes.js";
import servicesRoutes from './routes/services.routes.js';
import manualClientRoutes from './routes/manualClient.routes.js';
import companyRoutes from './routes/company.routes.js';
import integrationRoutes from "./routes/integrations.routes.js";
import licenseRoutes from './routes/license.routes.js';
import planRoutes from './routes/plan.routes.js';
import quickVisitsRoutes from './routes/quickVisits.routes.js';
import bitrixRoutes from './routes/bitrix.routes.js';

const app = express();

// API Key Middleware for external service authentication
export const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ 
      error: "API_KEY_REQUIRED",
      message: "x-api-key header is required" 
    });
  }
  
  if (apiKey !== API_KEY) {
    console.warn(`⚠️ Invalid API key attempt from ${req.ip}`);
    return res.status(403).json({ 
      error: "INVALID_API_KEY",
      message: "Invalid API key" 
    });
  }
  
  console.log(`✅ API Key authenticated for ${req.method} ${req.originalUrl}`);
  next();
};

// Middleware
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-company-id", "x-api-key"]
}));
app.options("*", cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ← NEW: Serve static HTML files from bitrix_ui folder
app.use(express.static('bitrix_ui'));

// Request logging
app.use((req, res, next) => {
  console.log(`🔥 ${req.method} ${req.originalUrl}`);
  next();
});

// Test DB connection
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Database connected successfully");
  }
});

// ============================================
// API KEY PROTECTED ROUTES (External Services)
// ============================================
app.use("/api/external", authenticateApiKey, (req, res, next) => {
  console.log(`🔑 External API access from ${req.ip}`);
  next();
});

// ============================================
// PUBLIC ROUTES (No Authentication)
// ============================================
app.use("/auth", authRoutes);
app.use("/integrations", integrationRoutes);

// ============================================
// PLAN MANAGEMENT ROUTES (Authenticated)
// ============================================
app.use("/api/plans", authenticateToken, attachCompanyContext, planRoutes);

// ============================================
// LICENSE ROUTES (Authenticated + API Key optional)
// ============================================
app.use("/api/license", authenticateToken, licenseRoutes);
app.use('/bitrix', bitrixRoutes);

// ============================================
// COMPANY-SCOPED ROUTES (Authenticated + Company Context + Plan Features)
// ============================================
app.use("/clients", 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  clientRoutes
);

app.use("/location-logs", 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  locationRoutes
);

app.use("/api/quick-visits", 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  quickVisitsRoutes
);

app.use("/meetings", 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  meetingRoutes
);

app.use("/expenses", 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  expenseRoutes
);

app.use('/services', 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  servicesRoutes
);

app.use('/api/manual-clients', 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  manualClientRoutes
);

// ============================================
// ADMIN ROUTES (Company Admin + Plan Features)
// ============================================
app.use("/admin", 
  authenticateToken, 
  attachCompanyContext, 
  attachPlanFeatures,
  adminRoutes
);

// ============================================
// SUPER ADMIN ROUTES (Cross-Company Management)
// ============================================
app.use("/super-admin/companies", companyRoutes);

// ============================================
// SYNC ROUTES
// ============================================
app.use("/api/sync", syncRoutes);

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({ 
    message: "Multi-Company Client Tracking API with Plan-Based Limitations",
    version: "2.1.0",
    features: [
      "company-scoped", 
      "super-admin", 
      "pincode-filtering",
      "plan-based-limitations",
      "api-key-authentication"
    ]
  });
});

app.get("/dbtest", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    const companyCount = await pool.query("SELECT COUNT(*) FROM companies");
    const planCount = await pool.query("SELECT COUNT(*) FROM plan_features");
    
    res.json({ 
      db_time: result.rows[0].now,
      companies: parseInt(companyCount.rows[0].count),
      plans_configured: parseInt(planCount.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error handling
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🏢 Multi-company mode enabled`);
  console.log(`📍 Pincode-based filtering enabled`);
  console.log(`💎 Plan-based limitations enabled`);
  console.log(`🔑 API Key authentication enabled`);
  console.log(`📦 Request body limit: 10mb`);
});