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
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const waiting = new Map();
const peers = new Map();
const pairSessions = new Map();
const eventWindows = new Map();
const socketClients = new Map();
// Bounded in-memory report queue; durable storage is still required for public launch.
const reports = [];
const MAX_REPORTS = 500;
const VALID_REPORT_REASONS = new Set(["harassment", "sexual_content", "underage", "spam_or_scam", "threats", "other"]);

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
  if (data.type === "audio-fallback") {
    return data.data && typeof data.data === "object" && data.data.reason === "turn-relay";
  }
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

function compatible(want, actual) {
  return !want || want === "any" || (Boolean(actual) && actual !== "any" && want === actual);
}

function canPair(prefs, otherPrefs) {
  const leftId = prefs.clientId;
  const rightId = otherPrefs.clientId;
  if (leftId && rightId && leftId === rightId) return false;
  if (leftId && otherPrefs.blockedIds.includes(leftId)) return false;
  if (rightId && prefs.blockedIds.includes(rightId)) return false;
  return prefs.mode === otherPrefs.mode &&
    compatible(prefs.wantGender, otherPrefs.gender) &&
    compatible(prefs.wantNationality, otherPrefs.nationality) &&
    compatible(otherPrefs.wantGender, prefs.gender) &&
    compatible(otherPrefs.wantNationality, prefs.nationality);
}

function normalizePrefs(prefs) {
  const genders = ["", "female", "male", "other"];
  const nationalities = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");
  return {
    mode: prefs?.mode === "voice" ? "voice" : "video",
    gender: genders.includes(prefs?.gender) ? prefs.gender : "",
    nationality: nationalities.includes(prefs?.nationality) ? prefs.nationality : "",
    avatar: typeof prefs?.avatar === "string" && prefs.avatar.length <= 60000 && /^data:image\/(jpeg|png|webp);base64,/.test(prefs.avatar) ? prefs.avatar : "",
    wantGender: ["any", "female", "male", "other"].includes(prefs?.wantGender) ? prefs.wantGender : "any",
    wantNationality: ["any", ...nationalities].includes(prefs?.wantNationality) ? prefs.wantNationality : "any",
    clientId: typeof prefs?.clientId === "string" && /^[0-9a-f-]{36}$/i.test(prefs.clientId) ? prefs.clientId : "",
    blockedIds: Array.isArray(prefs?.blockedIds) ? prefs.blockedIds.filter(id => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200) : [],
    recentMatches: Array.isArray(prefs?.recentMatches) ? prefs.recentMatches.filter(id => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(-20) : []
  };
}

function match(id, prefs) {
  console.log("[match] find received", JSON.stringify({
    socket: id.slice(0, 8),
    mode: prefs.mode,
    wantGender: prefs.wantGender,
    wantNationality: prefs.wantNationality,
    waitingCount: waiting.size
  }));
  for (const [other, otherPrefs] of waiting) {
    if (other === id) continue;
    if (!canPair(prefs, otherPrefs)) {
      console.log("[match] candidate rejected", JSON.stringify({
        socket: id.slice(0, 8),
        candidate: other.slice(0, 8),
        sameMode: prefs.mode === otherPrefs.mode,
        leftWantsGenderCompatible: compatible(prefs.wantGender, otherPrefs.gender),
        leftWantsNationalityCompatible: compatible(prefs.wantNationality, otherPrefs.nationality),
        rightWantsGenderCompatible: compatible(otherPrefs.wantGender, prefs.gender),
        rightWantsNationalityCompatible: compatible(otherPrefs.wantNationality, prefs.nationality),
        sameClient: Boolean(prefs.clientId && otherPrefs.clientId && prefs.clientId === otherPrefs.clientId),
        blocked: Boolean(
          (prefs.clientId && otherPrefs.blockedIds.includes(prefs.clientId)) ||
          (otherPrefs.clientId && prefs.blockedIds.includes(otherPrefs.clientId))
        )
      }));
      continue;
    }

    waiting.delete(other);
    waiting.delete(id);
    const sessionId = randomUUID();
    peers.set(id, other);
    peers.set(other, id);
    pairSessions.set(id, sessionId);
    pairSessions.set(other, sessionId);
    console.log("[match] paired", JSON.stringify({ left: id.slice(0, 8), right: other.slice(0, 8), mode: prefs.mode }));
    io.to(id).emit("matched", { peerId: other, peerClientId: otherPrefs.clientId || "", peerAvatar: otherPrefs.avatar || "", initiator: true, sessionId });
    io.to(other).emit("matched", { peerId: id, peerClientId: prefs.clientId || "", peerAvatar: prefs.avatar || "", initiator: false, sessionId });
    return;
  }

  waiting.set(id, prefs);
  console.log("[match] waiting", JSON.stringify({ socket: id.slice(0, 8), waitingCount: waiting.size }));
  io.to(id).emit("status", "Waiting for other users…");
}

io.on("connection", socket => {
  console.log("[socket] connected", socket.id.slice(0, 8));
  socket.on("find", prefs => {
    if (!allowEvent(socket, "find", 2, 1000)) {
      socket.emit("status", "You are doing that too quickly. Please wait a moment and try again.");
      return;
    }
    endPair(socket.id);
    waiting.delete(socket.id);
    const normalized = normalizePrefs(prefs);
    socketClients.set(socket.id, normalized.clientId);
    match(socket.id, normalized);
  });

  socket.on("skip", prefs => {
    if (!allowEvent(socket, "skip", 5, 1000)) {
      socket.emit("status", "You are doing that too quickly. Please wait a moment and try again.");
      return;
    }
    endPair(socket.id);
    waiting.delete(socket.id);
    const normalized = normalizePrefs(prefs);
    socketClients.set(socket.id, normalized.clientId);
    match(socket.id, normalized);
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

  socket.on("block", data => {
    if (!allowEvent(socket, "block", 5, 60000)) {
      socket.emit("status", "Too many block requests. Please wait a moment.");
      return;
    }
    const other = peers.get(socket.id);
    const currentSession = pairSessions.get(socket.id);
    if (!other || !data || typeof data.sessionId !== "string" ||
        data.sessionId !== currentSession || pairSessions.get(other) !== currentSession) return;
    const blockedClientId = socketClients.get(other);
    endPair(socket.id);
    waiting.delete(socket.id);
    waiting.delete(other);
    socket.emit("blocked", { clientId: blockedClientId || "" });
  });

  socket.on("report", data => {
    if (!allowEvent(socket, "report", 3, 60000)) {
      socket.emit("report-result", { ok: false, message: "Too many reports. Please wait before trying again." });
      return;
    }
    const other = peers.get(socket.id);
    const currentSession = pairSessions.get(socket.id);
    if (!other || !data || typeof data.sessionId !== "string" ||
        data.sessionId !== currentSession || pairSessions.get(other) !== currentSession) {
      socket.emit("report-result", { ok: false, message: "This chat has already ended. Reconnect before submitting a report." });
      return;
    }
    if (!VALID_REPORT_REASONS.has(data.reason)) {
      socket.emit("report-result", { ok: false, message: "Choose a valid report reason." });
      return;
    }
    const report = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      reason: data.reason,
      reporterId: socketClients.get(socket.id) || "",
      reportedId: socketClients.get(other) || "",
      sessionId: currentSession
    };
    reports.push(report);
    if (reports.length > MAX_REPORTS) reports.shift();
    socket.emit("report-result", { ok: true, message: "Report received. Thank you for helping keep RandomMeet safer. End this chat if you feel unsafe." });
    endPair(socket.id);
    waiting.delete(socket.id);
  });

  socket.on("disconnect", reason => {
    console.log("[socket] disconnected", JSON.stringify({ socket: socket.id.slice(0, 8), reason }));
    waiting.delete(socket.id);
    endPair(socket.id);
    socketClients.delete(socket.id);
    for (const key of eventWindows.keys()) {
      if (key.startsWith(socket.id + ":")) eventWindows.delete(key);
    }
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "RandomMeet" }));
app.get("/admin/reports", (req, res) => {
  const token = process.env.REPORT_ADMIN_TOKEN;
  if (!token) return res.status(503).json({ error: "Report administration is not configured." });
  if (req.get("x-admin-token") !== token) return res.status(401).json({ error: "Unauthorized." });
  res.setHeader("Cache-Control", "no-store");
  res.json({ reports: reports.slice().reverse(), note: "Reports are held in volatile process memory and may be lost on restart or redeploy." });
});
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
