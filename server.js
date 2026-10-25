const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
const waiting = new Map(), peers = new Map();
function endPair(id) {
  const other = peers.get(id);
  peers.delete(id);
  if (other) { peers.delete(other); io.to(other).emit("peer-ended"); }
}
function match(id, prefs) {
  for (const [other, op] of waiting) {
    if (other === id) continue;
    if (prefs.mode !== op.mode) continue;
    waiting.delete(other); waiting.delete(id);
    peers.set(id, other); peers.set(other, id);
    io.to(id).emit("matched", {peerId:other, initiator:true});
    io.to(other).emit("matched", {peerId:id, initiator:false});
    return;
  }
  waiting.set(id, prefs);
  io.to(id).emit("status", "正在等待其他用户…");
}
io.on("connection", socket => {
  socket.on("find", prefs => { endPair(socket.id); waiting.delete(socket.id); match(socket.id, {mode:prefs?.mode === "voice" ? "voice" : "video"}); });
  socket.on("skip", prefs => { endPair(socket.id); waiting.delete(socket.id); match(socket.id, {mode:prefs?.mode === "voice" ? "voice" : "video"}); });
  socket.on("leave", () => { waiting.delete(socket.id); endPair(socket.id); });
  socket.on("signal", data => { const other=peers.get(socket.id); if(other && data && ["offer","answer","ice"].includes(data.type)) io.to(other).emit("signal", data); });
  socket.on("report", () => socket.emit("status", "已收到举报。测试版尚未配置人工审核。"));
  socket.on("disconnect", () => { waiting.delete(socket.id); endPair(socket.id); });
});
app.get("/health", (_req,res) => res.json({ok:true, service:"RandomMeet"}));
app.get("*", (_req,res) => res.sendFile(path.join(__dirname,"public","index.html")));
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log("RandomMeet listening on " + port));
