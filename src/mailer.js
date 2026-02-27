const nodemailer = require("nodemailer");

const RESEND_SMTP_HOST = process.env.RESEND_SMTP_HOST || "smtp.resend.com";
const RESEND_SMTP_PORT = Number(process.env.RESEND_SMTP_PORT || 465);
const RESEND_SMTP_USER = process.env.RESEND_SMTP_USER || "resend";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

let transporter = null;

function getTransporter() {
  if (!RESEND_API_KEY) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: RESEND_SMTP_HOST,
    port: RESEND_SMTP_PORT,
    secure: true,
    auth: {
      user: RESEND_SMTP_USER,
      pass: RESEND_API_KEY
    }
  });

  return transporter;
}

async function sendLoginCodeEmail({ email, code, ttlMinutes = 10 }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedCode = String(code || "").trim();

  const subject = "Ваш код входа в Chat Together";
  const text = [
    `Код входа: ${normalizedCode}`,
    `Код действует ${ttlMinutes} минут.`,
    "Если вы не запрашивали этот код, просто проигнорируйте письмо."
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1b2733;">
      <h2 style="margin:0 0 8px;">Код входа в Chat Together</h2>
      <p style="margin:0 0 12px;">Введите этот код в приложении:</p>
      <div style="font-size:28px;font-weight:700;letter-spacing:4px;margin:0 0 12px;">
        ${normalizedCode}
      </div>
      <p style="margin:0 0 8px;">Код действует ${ttlMinutes} минут.</p>
      <p style="margin:0;color:#647587;">Если вы не запрашивали код, проигнорируйте письмо.</p>
    </div>
  `;

  const mailer = getTransporter();
  if (!mailer) {
    if (IS_PRODUCTION) {
      throw new Error("Email service is not configured (RESEND_API_KEY)");
    }
    console.log(`[OTP DEV] ${normalizedEmail} => ${normalizedCode}`);
    return { mocked: true };
  }

  await mailer.sendMail({
    from: RESEND_FROM_EMAIL,
    to: normalizedEmail,
    subject,
    text,
    html
  });

  return { mocked: false };
}

module.exports = {
  sendLoginCodeEmail
};
