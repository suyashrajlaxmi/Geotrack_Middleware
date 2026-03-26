import crypto from "crypto";

export const verifyLmsSignature = (req, res, next) => {
  const secret = process.env.LICENSE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("❌ LICENSE_WEBHOOK_SECRET is missing in GeoTrack env");
    return res.status(500).json({
      error: "ServerMisconfigured",
      message: "LICENSE_WEBHOOK_SECRET not set",
    });
  }

  const signature = req.headers["x-lms-signature"];
  if (!signature) {
    return res.status(401).json({ error: "MissingSignature" });
  }

  const payload =
    typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);

  const expected = crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payload, "utf8")
    .digest("hex");

  if (signature !== expected) {
    return res.status(401).json({ error: "InvalidSignature" });
  }

  next();
};
