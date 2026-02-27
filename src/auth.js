const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const JWT_TTL = process.env.JWT_TTL || "30d";

if (!process.env.JWT_SECRET) {
  console.warn(
    "[auth] WARNING: JWT_SECRET env var is not set. Using insecure default secret. Set JWT_SECRET before deploying to production."
  );
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: JWT_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function getBearerToken(authHeader) {
  const value = String(authHeader || "");
  if (!value.startsWith("Bearer ")) {
    return null;
  }
  return value.slice(7).trim();
}

function authMiddleware(req, res, next) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }

  try {
    const payload = verifyToken(token);
    req.auth = {
      userId: payload.sub,
      name: payload.name,
      email: payload.email
    };
    return next();
  } catch (_err) {
    return res.status(401).json({ error: "Невалидный токен" });
  }
}

module.exports = {
  signToken,
  verifyToken,
  getBearerToken,
  authMiddleware
};

