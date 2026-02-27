require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Server } = require("socket.io");

const {
  getUserByName,
  getUserById,
  searchUsers,
  createUser,
  createOrGetDirectChat,
  getChatById,
  listUserChatIds,
  isUserInChat,
  listChatsForUser,
  listMessagesForChat,
  markChatAsRead,
  getChatParticipants,
  addMessage,
  toPublicUser
} = require("./store");
const { signToken, verifyToken, authMiddleware } = require("./auth");

const PORT = Number(process.env.PORT || 4000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 50);
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

function buildAuthResponse(publicUser) {
  const token = signToken(publicUser);
  return {
    token,
    user: publicUser
  };
}

function validateName(name) {
  const value = String(name || "").trim();
  return value.length >= 2 && value.length <= 40;
}

function validatePassword(password) {
  const value = String(password || "");
  return value.length >= 4 && value.length <= 120;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const raw = String(storedHash || "");
  const parts = raw.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  if (!salt || !hashHex) return false;

  const hashBuffer = Buffer.from(hashHex, "hex");
  const calculated = crypto.scryptSync(String(password || ""), salt, hashBuffer.length);
  if (calculated.length !== hashBuffer.length) return false;
  return crypto.timingSafeEqual(calculated, hashBuffer);
}

function sanitizeText(value) {
  const text = String(value || "").trim();
  return text.slice(0, 2000);
}

function inferKindFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function normalizeMessageKind(kind, fallbackMime) {
  const value = String(kind || "").trim().toLowerCase();
  if (["text", "image", "video", "audio", "file"].includes(value)) return value;
  return inferKindFromMime(fallbackMime);
}

function parseOptionalNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildWebCallUrl(callId, kind) {
  const base = `https://meet.jit.si/chat-together-${callId}`;
  if (kind === "audio") {
    return `${base}#config.startWithVideoMuted=true&config.disableFilmstrip=true`;
  }
  return base;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10);
      const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "") || "";
      cb(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
    }
  }),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "");
    const allowed =
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime === "application/pdf";

    if (!allowed) {
      cb(new Error("Неподдерживаемый тип файла"));
      return;
    }
    cb(null, true);
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN
  }
});

const activeCalls = new Map();

function emitChatUpdated(chatId) {
  const participants = getChatParticipants(chatId);
  for (const participant of participants) {
    io.to(`user:${participant.id}`).emit("chat_updated", { chatId });
  }
}

function emitNewMessage(chatId, message) {
  const participants = getChatParticipants(chatId);
  for (const participant of participants) {
    io.to(`user:${participant.id}`).emit("new_message", message);
  }
  emitChatUpdated(chatId);
}

function sendMessageAndBroadcast({ chatId, sender, kind, text, media }) {
  const message = addMessage({
    chatId,
    senderId: sender.id,
    senderName: sender.name,
    kind,
    text,
    media
  });
  emitNewMessage(chatId, message);
  return message;
}

function ensureChatAccess(chatId, userId) {
  const chat = getChatById(chatId);
  if (!chat) {
    return { error: { status: 404, message: "Чат не найден" } };
  }
  if (!isUserInChat(chat, userId)) {
    return { error: { status: 403, message: "Нет доступа к этому чату" } };
  }
  return { chat };
}

function emitCallEvent(call, eventName, payload) {
  for (const userId of call.participantIds) {
    io.to(`user:${userId}`).emit(eventName, payload);
  }
}

function createCall({ chatId, caller, kind }) {
  const chat = getChatById(chatId);
  if (!chat) {
    throw new Error("Чат не найден");
  }

  const participantIds = Array.isArray(chat.participantIds) ? chat.participantIds : [];
  const callId = crypto.randomUUID();
  const call = {
    id: callId,
    chatId,
    kind: kind === "video" ? "video" : "audio",
    callerId: caller.id,
    callerName: caller.name,
    participantIds,
    roomUrl: buildWebCallUrl(callId, kind),
    status: "ringing",
    createdAt: new Date().toISOString()
  };

  activeCalls.set(callId, call);
  return call;
}

function getCallById(callId) {
  return activeCalls.get(callId) || null;
}

function endCall(callId, reason, endedByUserId = null) {
  const call = getCallById(callId);
  if (!call) return null;

  activeCalls.delete(callId);
  emitCallEvent(call, "call_ended", {
    callId: call.id,
    chatId: call.chatId,
    reason: reason || "ended",
    endedByUserId
  });
  return call;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post("/api/auth/register", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "");

  if (!validateName(name)) {
    return res
      .status(400)
      .json({ error: "Имя должно быть от 2 до 40 символов" });
  }
  if (!validatePassword(password)) {
    return res
      .status(400)
      .json({ error: "Пароль должен быть от 4 до 120 символов" });
  }

  if (getUserByName(name)) {
    return res.status(409).json({ error: "Пользователь с таким именем уже существует" });
  }

  try {
    const publicUser = createUser({
      name,
      login: name,
      passwordHash: hashPassword(password)
    });
    return res.status(201).json(buildAuthResponse(publicUser));
  } catch (err) {
    return res.status(409).json({ error: err.message || "Не удалось создать пользователя" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "");

  if (!validateName(name)) {
    return res
      .status(400)
      .json({ error: "Укажите корректное имя пользователя" });
  }
  if (!validatePassword(password)) {
    return res
      .status(400)
      .json({ error: "Укажите корректный пароль" });
  }

  const user = getUserByName(name);
  if (!user) {
    return res.status(401).json({ error: "Неверное имя или пароль" });
  }
  if (!user.passwordHash) {
    return res
      .status(401)
      .json({ error: "Для этого аккаунта пароль не установлен. Создайте новый аккаунт" });
  }

  const ok = verifyPassword(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Неверное имя или пароль" });
  }

  return res.json(buildAuthResponse(toPublicUser(user)));
});

app.get("/api/me", authMiddleware, (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  return res.json({ user: toPublicUser(user) });
});

app.get("/api/users/search", authMiddleware, (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  const query = String(req.query?.q || "").trim();
  if (query.length < 2) {
    return res.status(400).json({ error: "Минимум 2 символа для поиска" });
  }

  const users = searchUsers(query, user.id);
  return res.json({ users });
});

app.post("/api/chats/direct", authMiddleware, (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  const contactName = String(req.body?.name || "").trim();
  if (!validateName(contactName)) {
    return res
      .status(400)
      .json({ error: "Укажите корректное имя контакта" });
  }

  const otherUser = getUserByName(contactName);
  if (!otherUser) {
    return res.status(404).json({ error: "Пользователь с таким именем не найден" });
  }

  try {
    const chat = createOrGetDirectChat(user.id, otherUser.id);
    const summary = listChatsForUser(user.id).find((c) => c.id === chat.id);
    return res.status(201).json({
      chat: summary || {
        id: chat.id,
        type: chat.type,
        participantIds: chat.participantIds,
        contact: toPublicUser(otherUser),
        updatedAt: chat.updatedAt,
        lastMessage: null,
        unreadCount: 0
      }
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Не удалось создать чат" });
  }
});

app.get("/api/chats", authMiddleware, (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  return res.json({ chats: listChatsForUser(user.id) });
});

app.get("/api/chats/:chatId/messages", authMiddleware, (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  const access = ensureChatAccess(req.params.chatId, user.id);
  if (access.error) {
    return res.status(access.error.status).json({ error: access.error.message });
  }

  const messages = listMessagesForChat(access.chat.id, 300);
  return res.json({ messages });
});

app.post("/api/chats/:chatId/read", authMiddleware, (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  const access = ensureChatAccess(req.params.chatId, user.id);
  if (access.error) {
    return res.status(access.error.status).json({ error: access.error.message });
  }

  markChatAsRead(access.chat.id, user.id);
  emitChatUpdated(access.chat.id);
  return res.json({ ok: true });
});

app.post("/api/chats/:chatId/upload", authMiddleware, upload.single("file"), (req, res) => {
  const user = getUserById(req.auth.userId);
  if (!user) {
    return res.status(401).json({ error: "Пользователь не найден" });
  }

  const access = ensureChatAccess(req.params.chatId, user.id);
  if (access.error) {
    if (req.file?.path) {
      fs.rmSync(req.file.path, { force: true });
    }
    return res.status(access.error.status).json({ error: access.error.message });
  }

  if (!req.file) {
    return res.status(400).json({ error: "Файл не передан" });
  }

  const text = sanitizeText(req.body?.caption || "");
  const kind = normalizeMessageKind(req.body?.kind, req.file.mimetype);
  const media = {
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname || req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    durationSec: parseOptionalNumber(req.body?.durationSec),
    width: parseOptionalNumber(req.body?.width),
    height: parseOptionalNumber(req.body?.height)
  };

  try {
    const message = sendMessageAndBroadcast({
      chatId: access.chat.id,
      sender: user,
      kind,
      text,
      media
    });
    return res.status(201).json({ message });
  } catch (err) {
    if (req.file?.path) {
      fs.rmSync(req.file.path, { force: true });
    }
    return res.status(400).json({ error: err.message || "Не удалось отправить файл" });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({ error: `Файл слишком большой (максимум ${MAX_UPLOAD_SIZE_MB}MB)` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || "Ошибка запроса" });
  }
  return res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error("Требуется токен"));
  }

  try {
    const payload = verifyToken(token);
    const user = getUserById(payload.sub);
    if (!user) {
      return next(new Error("Пользователь не найден"));
    }

    socket.data.user = {
      id: user.id,
      name: user.name,
      login: user.login || user.name,
      email: user.email
    };
    return next();
  } catch (_err) {
    return next(new Error("Невалидный токен"));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  socket.join(`user:${user.id}`);

  const chatIds = listUserChatIds(user.id);
  for (const chatId of chatIds) {
    socket.join(`chat:${chatId}`);
  }

  socket.on("send_message", (payload, ack) => {
    const chatId = String(payload?.chatId || "").trim();
    const kind = normalizeMessageKind(payload?.kind, payload?.media?.mimeType);
    const text = sanitizeText(payload?.text || "");
    const media =
      payload?.media && typeof payload.media === "object" ? payload.media : null;

    if (!chatId) {
      if (typeof ack === "function") ack({ error: "Не передан chatId" });
      return;
    }

    if (kind === "text" && !text) {
      if (typeof ack === "function") ack({ error: "Пустое сообщение" });
      return;
    }

    const access = ensureChatAccess(chatId, user.id);
    if (access.error) {
      if (typeof ack === "function") ack({ error: access.error.message });
      return;
    }

    try {
      const message = sendMessageAndBroadcast({
        chatId: access.chat.id,
        sender: user,
        kind,
        text,
        media
      });
      if (typeof ack === "function") ack({ ok: true, messageId: message.id });
    } catch (err) {
      if (typeof ack === "function") ack({ error: err.message || "Ошибка отправки" });
    }
  });

  socket.on("open_chat", (payload, ack) => {
    const chatId = String(payload?.chatId || "").trim();
    if (!chatId) {
      if (typeof ack === "function") ack({ error: "Не передан chatId" });
      return;
    }

    const access = ensureChatAccess(chatId, user.id);
    if (access.error) {
      if (typeof ack === "function") ack({ error: access.error.message });
      return;
    }

    socket.join(`chat:${chatId}`);
    markChatAsRead(chatId, user.id);
    emitChatUpdated(chatId);
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("call_invite", (payload, ack) => {
    const chatId = String(payload?.chatId || "").trim();
    const kind = String(payload?.kind || "audio").toLowerCase() === "video" ? "video" : "audio";

    if (!chatId) {
      if (typeof ack === "function") ack({ error: "Не передан chatId" });
      return;
    }

    const access = ensureChatAccess(chatId, user.id);
    if (access.error) {
      if (typeof ack === "function") ack({ error: access.error.message });
      return;
    }

    try {
      const call = createCall({ chatId, caller: user, kind });
      emitCallEvent(call, "incoming_call", {
        callId: call.id,
        chatId: call.chatId,
        fromUserId: user.id,
        fromUserName: user.name,
        kind: call.kind,
        roomUrl: call.roomUrl,
        createdAt: call.createdAt
      });
      if (typeof ack === "function") ack({ ok: true, call });
    } catch (err) {
      if (typeof ack === "function") ack({ error: err.message || "Не удалось начать звонок" });
    }
  });

  socket.on("call_answer", (payload, ack) => {
    const callId = String(payload?.callId || "").trim();
    const accepted = Boolean(payload?.accepted);

    const call = getCallById(callId);
    if (!call) {
      if (typeof ack === "function") ack({ error: "Звонок не найден" });
      return;
    }

    if (!call.participantIds.includes(user.id)) {
      if (typeof ack === "function") ack({ error: "Нет доступа к звонку" });
      return;
    }

    if (!accepted) {
      emitCallEvent(call, "call_answered", {
        callId: call.id,
        chatId: call.chatId,
        accepted: false,
        answeredByUserId: user.id,
        answeredByName: user.name
      });
      activeCalls.delete(call.id);
      if (typeof ack === "function") ack({ ok: true });
      return;
    }

    call.status = "active";
    emitCallEvent(call, "call_answered", {
      callId: call.id,
      chatId: call.chatId,
      accepted: true,
      answeredByUserId: user.id,
      answeredByName: user.name,
      roomUrl: call.roomUrl,
      kind: call.kind
    });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("call_end", (payload, ack) => {
    const callId = String(payload?.callId || "").trim();
    const call = getCallById(callId);
    if (!call) {
      if (typeof ack === "function") ack({ error: "Звонок не найден" });
      return;
    }
    if (!call.participantIds.includes(user.id)) {
      if (typeof ack === "function") ack({ error: "Нет доступа к звонку" });
      return;
    }

    endCall(callId, "ended", user.id);
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("webrtc_offer", (payload, ack) => {
    const callId = String(payload?.callId || "").trim();
    const toUserId = String(payload?.toUserId || "").trim();
    const call = getCallById(callId);
    if (!call) {
      if (typeof ack === "function") ack({ error: "Звонок не найден" });
      return;
    }
    if (!call.participantIds.includes(user.id) || !call.participantIds.includes(toUserId)) {
      if (typeof ack === "function") ack({ error: "Нет доступа к звонку" });
      return;
    }

    io.to(`user:${toUserId}`).emit("webrtc_offer", {
      callId,
      fromUserId: user.id,
      sdp: payload?.sdp
    });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("webrtc_answer", (payload, ack) => {
    const callId = String(payload?.callId || "").trim();
    const toUserId = String(payload?.toUserId || "").trim();
    const call = getCallById(callId);
    if (!call) {
      if (typeof ack === "function") ack({ error: "Звонок не найден" });
      return;
    }
    if (!call.participantIds.includes(user.id) || !call.participantIds.includes(toUserId)) {
      if (typeof ack === "function") ack({ error: "Нет доступа к звонку" });
      return;
    }

    io.to(`user:${toUserId}`).emit("webrtc_answer", {
      callId,
      fromUserId: user.id,
      sdp: payload?.sdp
    });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("webrtc_ice_candidate", (payload, ack) => {
    const callId = String(payload?.callId || "").trim();
    const toUserId = String(payload?.toUserId || "").trim();
    const call = getCallById(callId);
    if (!call) {
      if (typeof ack === "function") ack({ error: "Звонок не найден" });
      return;
    }
    if (!call.participantIds.includes(user.id) || !call.participantIds.includes(toUserId)) {
      if (typeof ack === "function") ack({ error: "Нет доступа к звонку" });
      return;
    }

    io.to(`user:${toUserId}`).emit("webrtc_ice_candidate", {
      callId,
      fromUserId: user.id,
      candidate: payload?.candidate
    });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const calls = [...activeCalls.values()].filter((call) => call.participantIds.includes(user.id));
    for (const call of calls) {
      if (call.status === "ringing") {
        endCall(call.id, "missed", user.id);
      } else if (call.status === "active") {
        endCall(call.id, "ended", user.id);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Chat backend started on http://localhost:${PORT}`);
});
