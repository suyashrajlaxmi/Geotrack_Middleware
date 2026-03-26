import dotenv from "dotenv";
dotenv.config();

export const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-in-production";
export const PORT = process.env.PORT || 5000;
export const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
export const MIDDLEWARE_TOKEN = process.env.MIDDLEWARE_TOKEN || "tally-middleware-secret-key-12345";
export const CORS_ORIGIN = [
  "http://localhost:3000", 
  "https://geo-track-em3s.onrender.com",
  "https://dashboard-tsw3.onrender.com",
  "https://lisence-system.onrender.com"
];

// 🆕 EMAIL CONFIGURATION
export const EMAIL_CONFIG = {
  service: 'gmail',
  user: process.env.EMAIL_USER || 'your-app-email@gmail.com',
  pass: process.env.EMAIL_PASSWORD || 'your-app-password-here',
  from: process.env.EMAIL_FROM || 'GeoTrack <your-app-email@gmail.com>'
};