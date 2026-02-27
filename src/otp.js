const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 10 * 60 * 1000);
const OTP_COOLDOWN_MS = Number(process.env.OTP_COOLDOWN_MS || 60 * 1000);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);

const otpByEmail = new Map();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanupExpired() {
  const now = Date.now();
  for (const [email, value] of otpByEmail.entries()) {
    if (!value || value.expiresAt <= now) {
      otpByEmail.delete(email);
    }
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function issueOtp(email) {
  cleanupExpired();
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  const existing = otpByEmail.get(normalizedEmail);

  if (existing && now - existing.lastSentAt < OTP_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((OTP_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
    return {
      ok: false,
      retryAfterSec
    };
  }

  const code = generateCode();
  otpByEmail.set(normalizedEmail, {
    code,
    expiresAt: now + OTP_TTL_MS,
    lastSentAt: now,
    attemptsLeft: OTP_MAX_ATTEMPTS
  });

  return {
    ok: true,
    code,
    expiresAt: now + OTP_TTL_MS,
    ttlSec: Math.round(OTP_TTL_MS / 1000),
    retryAfterSec: Math.round(OTP_COOLDOWN_MS / 1000)
  };
}

function verifyOtp(email, code) {
  cleanupExpired();
  const normalizedEmail = normalizeEmail(email);
  const normalizedCode = String(code || "").trim();
  const entry = otpByEmail.get(normalizedEmail);

  if (!entry) {
    return {
      ok: false,
      error: "Код не найден или уже истек. Запросите новый код"
    };
  }

  if (entry.expiresAt <= Date.now()) {
    otpByEmail.delete(normalizedEmail);
    return {
      ok: false,
      error: "Код истек. Запросите новый код"
    };
  }

  if (entry.code !== normalizedCode) {
    entry.attemptsLeft -= 1;
    if (entry.attemptsLeft <= 0) {
      otpByEmail.delete(normalizedEmail);
      return {
        ok: false,
        error: "Слишком много неверных попыток. Запросите новый код"
      };
    }

    otpByEmail.set(normalizedEmail, entry);
    return {
      ok: false,
      error: `Неверный код. Осталось попыток: ${entry.attemptsLeft}`
    };
  }

  otpByEmail.delete(normalizedEmail);
  return { ok: true };
}

module.exports = {
  issueOtp,
  verifyOtp
};

