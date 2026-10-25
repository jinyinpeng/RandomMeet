const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID, createHmac } = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 });
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const waiting = new Map();
const peers = new Map();
const pairSessions = new Map();
const eventWindows = new Map();

function allowEvent(socket, name, limit, windowMs) {
  const now = Date.now();
  const key = socket.id + ":" + name;
  const recent = (eventWindows.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= limit) {
    eventWindows.set(key, recent);
    return false;
  }
  recent.push(now);
  eventWindows.set(key, recent);
  return true;
}

function validSignal(data) {
  if (!data || typeof data !== "object" || typeof data.sessionId !== "string") return false;
  if (!["offer", "answer", "ice"].includes(data.type)) return false;
  if (data.type === "offer" || data.type === "answer") {
    return data.data && typeof data.data === "object" &&
      data.data.type === data.type && typeof data.data.sdp === "string" &&
      data.data.sdp.length > 0 && data.data.sdp.length <= 100000;
  }
  return data.data && typeof data.data === "object" &&
    typeof data.data.candidate === "string" && data.data.candidate.length <= 8192;
}

function endPair(id) {
  const other = peers.get(id);
  const sessionId = pairSessions.get(id);
  peers.delete(id);
  pairSessions.delete(id);
  if (other) {
    peers.delete(other);
    pairSessions.delete(other);
    io.to(other).emit("peer-ended", { sessionId });
  }
}

function match(id, prefs) {
  for (const [other, otherPrefs] of waiting) {
    if (other === id) continue;
    if (prefs.mode !== otherPrefs.mode) continue;

    waiting.delete(other);
    waiting.delete(id);
    const sessionId = randomUUID();
    peers.set(id, other);
    peers.set(other, id);
    pairSessions.set(id, sessionId);
    pairSessions.set(other, sessionId);
    io.to(id).emit("matched", { peerId: other, initiator: true, sessionId });
    io.to(other).emit("matched", { peerId: id, initiator: false, sessionId });
    return;
  }

  waiting.set(id, prefs);
  io.to(id).emit("status", "正在等待其他用户…");
}

io.on("connection", socket => {
  socket.on("find", prefs => {
    if (!allowEvent(socket, "match", 2, 1000)) {
      socket.emit("status", "操作太快了，请稍等片刻再试。");
      return;
    }
    endPair(socket.id);
    waiting.delete(socket.id);
    match(socket.id, { mode: prefs?.mode === "voice" ? "voice" : "video" });
  });

  socket.on("skip", prefs => {
    if (!allowEvent(socket, "match", 2, 1000)) {
      socket.emit("status", "操作太快了，请稍等片刻再试。");
      return;
    }
    endPair(socket.id);
    waiting.delete(socket.id);
    match(socket.id, { mode: prefs?.mode === "voice" ? "voice" : "video" });
  });

  socket.on("leave", () => {
    waiting.delete(socket.id);
    endPair(socket.id);
  });

  socket.on("signal", data => {
    if (!allowEvent(socket, "signal", 120, 60000)) return;
    const other = peers.get(socket.id);
    if (!other || !validSignal(data)) return;

    const currentSession = pairSessions.get(socket.id);
    // Require the current session ID so delayed signals from old matches cannot leak across sessions.
    if (!currentSession || data.sessionId !== currentSession ||
        pairSessions.get(other) !== currentSession) return;
    io.to(other).emit("signal", data);
  });

  socket.on("report", () => {
    if (!allowEvent(socket, "report", 3, 60000)) {
      socket.emit("status", "操作太频繁。当前测试版无法提交或处理举报。");
      return;
    }
    // Do not imply that a report was stored: this MVP has no report persistence or moderation workflow.
    socket.emit("status", "当前测试版尚不能提交有效举报，也没有人工审核。请立即挂断并离开不安全的对话。");
  });

  socket.on("disconnect", () => {
    waiting.delete(socket.id);
    endPair(socket.id);
    for (const key of eventWindows.keys()) {
      if (key.startsWith(socket.id + ":")) eventWindows.delete(key);
    }
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "RandomMeet" }));
app.get("/ice-config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",").map(value => value.trim()).filter(Boolean);
  const iceServers = stunUrls.map(url => ({ urls: url }));
  const turnUrls = (process.env.TURN_URLS || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  const sharedSecret = process.env.TURN_SHARED_SECRET;
  if (turnUrls.length && sharedSecret) {
    const configuredTtl = Number.parseInt(process.env.TURN_TTL_SECONDS || "3600", 10);
    const ttl = Number.isFinite(configuredTtl) ? Math.min(86400, Math.max(300, configuredTtl)) : 3600;
    const username = String(Math.floor(Date.now() / 1000) + ttl) + ":" + randomUUID();
    const credential = createHmac("sha1", sharedSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }
  res.json({ iceServers });
});
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log("RandomMeet listening on " + port));
