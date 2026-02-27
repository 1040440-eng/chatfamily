const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const RESEND_API_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

async function sendWithResendApi({ to, subject, text, html }) {
  if (typeof fetch !== "function") {
    throw new Error("Fetch is not available in current Node runtime");
  }

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text,
      html
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details =
      payload?.message ||
      payload?.error?.message ||
      payload?.name ||
      "Unknown error";
    throw new Error(`Resend API error: ${details}`);
  }

  return payload;
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

  if (!RESEND_API_KEY) {
    if (IS_PRODUCTION) {
      throw new Error("Email service is not configured (RESEND_API_KEY)");
    }
    console.log(`[OTP DEV] ${normalizedEmail} => ${normalizedCode}`);
    return { mocked: true };
  }

  await sendWithResendApi({
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
