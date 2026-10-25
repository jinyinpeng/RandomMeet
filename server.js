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

function compatible(want, actual) {
  return !want || want === "any" || (Boolean(actual) && actual !== "any" && want === actual);
}

function canPair(prefs, otherPrefs) {
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
    wantGender: ["any", "female", "male", "other"].includes(prefs?.wantGender) ? prefs.wantGender : "any",
    wantNationality: ["any", ...nationalities].includes(prefs?.wantNationality) ? prefs.wantNationality : "any"
  };
}

function match(id, prefs) {
  for (const [other, otherPrefs] of waiting) {
    if (other === id) continue;
    if (!canPair(prefs, otherPrefs)) continue;

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
  io.to(id).emit("status", "Waiting for other users…");
}

io.on("connection", socket => {
  socket.on("find", prefs => {
    if (!allowEvent(socket, "find", 2, 1000)) {
      socket.emit("status", "You are doing that too quickly. Please wait a moment and try again.");
      return;
    }
    endPair(socket.id);
    waiting.delete(socket.id);
    match(socket.id, normalizePrefs(prefs));
  });

  socket.on("skip", prefs => {
    if (!allowEvent(socket, "skip", 5, 1000)) {
      socket.emit("status", "You are doing that too quickly. Please wait a moment and try again.");
      return;
    }
    endPair(socket.id);
    waiting.delete(socket.id);
    match(socket.id, normalizePrefs(prefs));
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
      socket.emit("status", "Too many reports. This beta cannot submit or process reports.");
      return;
    }
    // Do not imply that a report was stored: this MVP has no report persistence or moderation workflow.
    socket.emit("status", "This beta cannot submit reports and has no human moderation. End and leave unsafe chats immediately.");
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
