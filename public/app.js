(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const local = $("local");
  const remote = $("remote");
  const status = $("status");
  const startBtn = $("start");
  const skipBtn = $("skip");
  const hangupBtn = $("hangup");
  const reportBtn = $("report");

  let stream = null;
  let pc = null;
  let peerId = null;
  let searching = false;
  let generation = 0;
  let pendingIce = [];

  const mode = () => document.querySelector('input[name="mode"]:checked').value;
  const say = message => { status.textContent = message; };

  function setSessionControls(active) {
    startBtn.disabled = active || !socket.connected;
    skipBtn.disabled = !active;
    hangupBtn.disabled = !active;
    reportBtn.disabled = !active;
  }

  function cleanup(stopMedia = false) {
    generation += 1;
    pendingIce = [];
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    peerId = null;
    remote.srcObject = null;
    $("remoteText").hidden = false;
    if (stopMedia && stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
      local.srcObject = null;
      $("localText").hidden = false;
    }
  }

  async function startMedia() {
    if (stream && stream.getTracks().some(track => track.readyState === "live")) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode() === "video"
    });
    local.srcObject = stream;
    $("localText").hidden = true;
  }

  async function flushPendingIce(connection, gen) {
    if (pc !== connection || generation !== gen || !connection.remoteDescription) return;
    const candidates = pendingIce;
    pendingIce = [];
    for (const candidate of candidates) {
      if (pc !== connection || generation !== gen) return;
      await connection.addIceCandidate(candidate);
    }
  }

  async function connect(initiator, gen) {
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pc = connection;
    pendingIce = [];

    stream.getTracks().forEach(track => connection.addTrack(track, stream));
    connection.ontrack = event => {
      if (pc !== connection || generation !== gen) return;
      remote.srcObject = event.streams[0];
      $("remoteText").hidden = true;
    };
    connection.onicecandidate = event => {
      if (!event.candidate || pc !== connection || generation !== gen || !peerId) return;
      socket.emit("signal", { type: "ice", data: event.candidate });
    };
    connection.onconnectionstatechange = () => {
      if (pc !== connection || generation !== gen) return;
      if (connection.connectionState === "connected") {
        say("已连接，可以开始聊天。");
      } else if (connection.connectionState === "failed") {
        say("连接失败，可能是网络限制。请点击“跳过”重试。");
      }
    };

    if (initiator) {
      const offer = await connection.createOffer();
      if (pc !== connection || generation !== gen) return;
      await connection.setLocalDescription(offer);
      if (pc !== connection || generation !== gen) return;
      socket.emit("signal", { type: "offer", data: connection.localDescription });
    }
  }

  startBtn.onclick = async () => {
    if (!socket.connected) {
      say("正在连接服务器，请稍后再试。");
      return;
    }
    try {
      await startMedia();
      cleanup(false);
      searching = true;
      setSessionControls(true);
      say("正在寻找在线用户…");
      socket.emit("find", { mode: mode() });
    } catch (error) {
      cleanup(true);
      searching = false;
      setSessionControls(false);
      say("无法启用摄像头或麦克风，请检查浏览器权限及 HTTPS。");
    }
  };

  skipBtn.onclick = () => {
    if (!searching || !socket.connected) return;
    cleanup(false);
    say("正在寻找下一位…");
    socket.emit("skip", { mode: mode() });
  };

  hangupBtn.onclick = () => {
    cleanup(true);
    socket.emit("leave");
    searching = false;
    setSessionControls(false);
    say("已挂断。");
  };

  reportBtn.onclick = () => {
    socket.emit("report");
    say("举报按钮目前仅显示提示，尚未保存举报或通知审核人员。");
  };

  socket.on("connect", () => {
    if (!searching) startBtn.disabled = false;
  });
  socket.on("disconnect", () => {
    cleanup(true);
    searching = false;
    setSessionControls(false);
    say("与服务器断开连接，正在尝试恢复…");
  });
  socket.on("connect_error", () => {
    say("暂时无法连接服务器，请检查网络后重试。");
  });
  socket.on("status", message => say(message));

  socket.on("matched", async data => {
    cleanup(false);
    peerId = data.peerId;
    const gen = generation;
    say("已匹配，正在建立连接…");
    try {
      await connect(Boolean(data.initiator), gen);
    } catch (error) {
      if (generation !== gen) return;
      cleanup(false);
      say("连接协商失败，请点击“跳过”重试。");
    }
  });

  socket.on("signal", async message => {
    const connection = pc;
    const gen = generation;
    if (!connection || !message || !["offer", "answer", "ice"].includes(message.type)) return;
    try {
      if (message.type === "ice") {
        if (!message.data || pc !== connection || generation !== gen) return;
        if (connection.remoteDescription) {
          await connection.addIceCandidate(message.data);
        } else {
          pendingIce.push(message.data);
        }
        return;
      }

      if (!message.data || pc !== connection || generation !== gen) return;
      if (message.type === "offer") {
        await connection.setRemoteDescription(message.data);
        await flushPendingIce(connection, gen);
        if (pc !== connection || generation !== gen) return;
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (pc !== connection || generation !== gen) return;
        socket.emit("signal", { type: "answer", data: connection.localDescription });
      } else if (message.type === "answer") {
        await connection.setRemoteDescription(message.data);
        await flushPendingIce(connection, gen);
      }
    } catch (error) {
      if (generation === gen) say("网络连接协商失败，请点击“跳过”重新匹配。");
    }
  });

  socket.on("peer-ended", () => {
    cleanup(true);
    searching = false;
    setSessionControls(false);
    say("对方已离开，可重新匹配。");
  });

  window.addEventListener("beforeunload", () => {
    cleanup(true);
    socket.emit("leave");
  });
})();