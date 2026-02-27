const nodemailer = require("nodemailer");

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_API_URL = process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email";
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "Chat Together";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "no-reply@chat-together.local";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

let transporter = null;

function getTransporter() {
  if (!SMTP_USER || !SMTP_PASS) {
    return null;
  }
  if (transporter) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  return transporter;
}

async function sendWithBrevoApi({ to, subject, text, html }) {
  if (typeof fetch !== "function") {
    throw new Error("Fetch is not available in current Node runtime");
  }

  const res = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        email: MAIL_FROM,
        name: BREVO_SENDER_NAME
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = payload?.message || payload?.code || "Unknown error";
    throw new Error(`Brevo API error: ${details}`);
  }
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

  if (BREVO_API_KEY) {
    await sendWithBrevoApi({
      to: normalizedEmail,
      subject,
      text,
      html
    });
    return { mocked: false, provider: "brevo" };
  }

  const mailer = getTransporter();
  if (mailer) {
    await mailer.sendMail({
      from: MAIL_FROM,
      to: normalizedEmail,
      subject,
      text,
      html
    });
    return { mocked: false, provider: "smtp" };
  }

  if (!mailer) {
    if (IS_PRODUCTION) {
      throw new Error("Email service is not configured (BREVO_API_KEY or SMTP_USER/SMTP_PASS)");
    }
    console.log(`[OTP DEV] ${normalizedEmail} => ${normalizedCode}`);
    return { mocked: true };
  }
}

module.exports = {
  sendLoginCodeEmail
};
