const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "chat-data.json");
const MAX_MESSAGES = 3000;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initialData = { users: [], chats: [], messages: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
    return;
  }

  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  let changed = false;

  if (!Array.isArray(parsed.users)) {
    parsed.users = [];
    changed = true;
  }

  if (!Array.isArray(parsed.chats)) {
    parsed.chats = [];
    changed = true;
  }

  if (!Array.isArray(parsed.messages)) {
    parsed.messages = [];
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2));
  }
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  return JSON.parse(raw);
}

function writeData(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    login: user.login || user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getUserByEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const data = readData();
  return data.users.find((u) => String(u.email || "").toLowerCase() === normalizedEmail) || null;
}

function getUserByName(name) {
  const normalized = normalizeLogin(name);
  const data = readData();
  return data.users.find((u) => normalizeLogin(u.login || u.name) === normalized) || null;
}

function getUserById(userId) {
  const data = readData();
  return data.users.find((u) => u.id === userId) || null;
}

function searchUsers(query, excludeUserId) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const data = readData();
  return data.users
    .filter((u) => u.id !== excludeUserId)
    .filter((u) => {
      const normalizedName = String(u.name || "").toLowerCase();
      const normalizedLogin = normalizeLogin(u.login || u.name);
      const normalizedEmail = String(u.email || "").toLowerCase();
      return (
        normalizedName.includes(q) ||
        normalizedLogin.includes(q) ||
        normalizedEmail.includes(q)
      );
    })
    .slice(0, 20)
    .map(toPublicUser);
}

function createUser({ name, login, email = null, passwordHash = null }) {
  const normalizedLogin = normalizeLogin(login || name);
  const normalizedName = String(name || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase() || null;
  const data = readData();

  const existing = data.users.find((u) => normalizeLogin(u.login || u.name) === normalizedLogin);
  if (existing) {
    throw new Error("Пользователь с таким именем уже существует");
  }

  const user = {
    id: crypto.randomUUID(),
    name: normalizedName,
    login: normalizedLogin,
    email: normalizedEmail,
    passwordHash,
    createdAt: new Date().toISOString()
  };

  data.users.push(user);
  writeData(data);

  return toPublicUser(user);
}

function normalizePair(userA, userB) {
  return [userA, userB].sort((a, b) => String(a).localeCompare(String(b)));
}

function findDirectChat(data, userA, userB) {
  const pair = normalizePair(userA, userB);
  return (
    data.chats.find((chat) => {
      if (chat.type !== "direct") return false;
      if (!Array.isArray(chat.participantIds) || chat.participantIds.length !== 2) return false;
      const ids = [...chat.participantIds].sort((a, b) => String(a).localeCompare(String(b)));
      return ids[0] === pair[0] && ids[1] === pair[1];
    }) || null
  );
}

function createOrGetDirectChat(userA, userB) {
  const [firstId, secondId] = normalizePair(userA, userB);
  if (firstId === secondId) {
    throw new Error("Нельзя создать чат с самим собой");
  }

  const data = readData();
  const existing = findDirectChat(data, firstId, secondId);
  if (existing) {
    return existing;
  }

  const chat = {
    id: crypto.randomUUID(),
    type: "direct",
    participantIds: [firstId, secondId],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.chats.push(chat);
  writeData(data);
  return chat;
}

function getChatById(chatId) {
  const data = readData();
  return data.chats.find((c) => c.id === chatId) || null;
}

function listUserChatIds(userId) {
  const data = readData();
  return data.chats
    .filter((chat) => Array.isArray(chat.participantIds) && chat.participantIds.includes(userId))
    .map((chat) => chat.id);
}

function isUserInChat(chat, userId) {
  return Boolean(chat && Array.isArray(chat.participantIds) && chat.participantIds.includes(userId));
}

function normalizeMedia(media) {
  if (!media || typeof media !== "object") return null;

  const url = String(media.url || "").trim();
  if (!url) return null;

  return {
    url,
    fileName: String(media.fileName || "").trim() || null,
    mimeType: String(media.mimeType || "").trim() || null,
    size: Number.isFinite(Number(media.size)) ? Number(media.size) : null,
    durationSec: Number.isFinite(Number(media.durationSec)) ? Number(media.durationSec) : null,
    width: Number.isFinite(Number(media.width)) ? Number(media.width) : null,
    height: Number.isFinite(Number(media.height)) ? Number(media.height) : null
  };
}

function normalizeKind(kind, media) {
  const value = String(kind || "").trim().toLowerCase();
  if (["text", "image", "video", "audio", "file", "system"].includes(value)) return value;
  return media ? "file" : "text";
}

function normalizeMessage(message) {
  const media = normalizeMedia(message.media);
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    senderName: message.senderName,
    kind: normalizeKind(message.kind, media),
    text: String(message.text || ""),
    media,
    createdAt: message.createdAt,
    readBy: Array.isArray(message.readBy) ? message.readBy : []
  };
}

function addMessage({ chatId, senderId, senderName, text, kind = "text", media = null }) {
  const normalizedMedia = normalizeMedia(media);
  const message = {
    id: crypto.randomUUID(),
    chatId,
    senderId,
    senderName,
    kind: normalizeKind(kind, normalizedMedia),
    text: String(text || ""),
    media: normalizedMedia,
    createdAt: new Date().toISOString(),
    readBy: [senderId]
  };

  const data = readData();
  const chat = data.chats.find((c) => c.id === chatId);
  if (!chat) {
    throw new Error("Чат не найден");
  }

  data.messages.push(message);
  chat.updatedAt = message.createdAt;

  if (data.messages.length > MAX_MESSAGES) {
    data.messages = data.messages.slice(-MAX_MESSAGES);
  }

  writeData(data);
  return normalizeMessage(message);
}

function listMessagesForChat(chatId, limit = 200) {
  const data = readData();
  return data.messages
    .filter((m) => m.chatId === chatId)
    .slice(-Math.max(1, limit))
    .map(normalizeMessage);
}

function markChatAsRead(chatId, userId) {
  const data = readData();
  let changed = false;

  for (const message of data.messages) {
    if (message.chatId !== chatId) continue;
    if (!Array.isArray(message.readBy)) {
      message.readBy = [];
      changed = true;
    }
    if (!message.readBy.includes(userId)) {
      message.readBy.push(userId);
      changed = true;
    }
  }

  if (changed) {
    writeData(data);
  }
}

function computeUnreadForChat(data, chatId, userId) {
  return data.messages.filter((m) => {
    if (m.chatId !== chatId) return false;
    if (m.senderId === userId) return false;
    if (!Array.isArray(m.readBy)) return true;
    return !m.readBy.includes(userId);
  }).length;
}

function buildLastMessagePreview(message) {
  const normalized = normalizeMessage(message);
  if (normalized.kind === "text") return normalized.text || "Сообщение";
  if (normalized.kind === "image") return "Фото";
  if (normalized.kind === "video") return "Видео";
  if (normalized.kind === "audio") return "Голосовое сообщение";
  if (normalized.kind === "file") {
    return normalized.media?.fileName
      ? `Файл: ${normalized.media.fileName}`
      : "Файл";
  }
  return "Служебное сообщение";
}

function listChatsForUser(userId) {
  const data = readData();

  const chats = data.chats
    .filter((chat) => isUserInChat(chat, userId))
    .map((chat) => {
      const otherUserId = chat.participantIds.find((id) => id !== userId) || null;
      const otherUser = data.users.find((u) => u.id === otherUserId) || null;

      const messages = data.messages.filter((m) => m.chatId === chat.id);
      const lastMessageRaw = messages[messages.length - 1] || null;
      const lastMessage = lastMessageRaw ? normalizeMessage(lastMessageRaw) : null;

      return {
        id: chat.id,
        type: chat.type,
        participantIds: chat.participantIds,
        contact: otherUser ? toPublicUser(otherUser) : null,
        updatedAt: lastMessage?.createdAt || chat.updatedAt || chat.createdAt,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              senderId: lastMessage.senderId,
              senderName: lastMessage.senderName,
              kind: lastMessage.kind,
              text: lastMessage.text,
              media: lastMessage.media,
              preview: buildLastMessagePreview(lastMessage),
              createdAt: lastMessage.createdAt
            }
          : null,
        unreadCount: computeUnreadForChat(data, chat.id, userId)
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  return chats;
}

function getChatParticipants(chatId) {
  const data = readData();
  const chat = data.chats.find((c) => c.id === chatId);
  if (!chat) return [];
  return data.users.filter((u) => chat.participantIds.includes(u.id)).map(toPublicUser);
}

module.exports = {
  getUserByEmail,
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
  normalizeMessage,
  toPublicUser
};
