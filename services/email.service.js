import SibApiV3Sdk from "sib-api-v3-sdk";

const client = SibApiV3Sdk.ApiClient.instance;
client.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;

const transactionalApi = new SibApiV3Sdk.TransactionalEmailsApi();

export const sendPasswordResetEmail = async (toEmail, resetToken) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5000";
  const resetLink = `${frontendUrl}/reset.password.html?token=${resetToken}`;

  const emailPayload = {
    sender: {
      name: "GeoTrack",
      email: process.env.SENDER_EMAIL,
    },
    to: [{ email: toEmail }],
    subject: "Reset your GeoTrack password",
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#1a1a2e;">GeoTrack — Password Reset</h2>
        <p style="color:#64748b;font-size:14px;">
          Click the button below to reset your password. Link expires in <strong>1 hour</strong>.
        </p>
        <a href="${resetLink}"
           style="display:inline-block;padding:13px 32px;background:#6c3ce1;
                  color:#fff;text-decoration:none;border-radius:10px;font-weight:700;margin:20px 0;">
          Reset Password
        </a>
        <p style="color:#94a3b8;font-size:12px;">
          If you didn't request this, ignore this email.
        </p>
        <p style="color:#c4c9d6;font-size:11px;word-break:break-all;">${resetLink}</p>
      </div>
    `,
  };

  try {
    const result = await transactionalApi.sendTransacEmail(emailPayload);
    console.log(`📧 Reset email sent → ${toEmail}`);
    return result;
  } catch (err) {
    const brevoError = err?.response?.body || err.message;
    console.error("❌ Brevo error:", JSON.stringify(brevoError, null, 2));
    throw new Error("Email delivery failed");
  }
};