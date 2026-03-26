import express from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { verifyLmsSignature } from "../middleware/integrations.js";
import { handleLicensePurchase } from "../controllers/integrations/lms.controller.js";

const router = express.Router();

router.post(
  "/lms/license-purchase",
  //verifyLmsSignature,
  asyncHandler(handleLicensePurchase)
);

export default router;
