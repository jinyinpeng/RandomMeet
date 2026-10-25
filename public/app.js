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
  let sessionId = null;
  let searching = false;
  let generation = 0;
  let pendingIce = [];
  let earlySignals = [];
  let configuredIceServers = null;
  let currentInitiator = false;
  let iceRestartAttempted = false;
  let connectionWatchdog = null;
  let mediaWatchdog = null;

  // Require an explicit 18+ confirmation on every visit; first-time visitors must complete their profile.
  const ageGate = $("ageGate");
  const profileGate = $("profileGate");
  const profileKey = "randommeet_profile_v1";
  const savedProfile = () => { try { return JSON.parse(localStorage.getItem(profileKey) || "null"); } catch (_) { return null; } };
  const validProfile = value => value && ["female","male","other"].includes(value.gender) && ["CN","IT","US","GB","JP","KR","FR","DE","ES","BR","IN","CA","AU","OTHER"].includes(value.nationality);
  const enterApp = () => { ageGate.hidden = true; profileGate.hidden = true; };
  $("ageConfirm").addEventListener("click", () => {
    const profile = savedProfile();
    if (validProfile(profile)) {
      $("myGender").value = profile.gender; $("myNationality").value = profile.nationality; enterApp();
    } else { ageGate.hidden = true; profileGate.hidden = false; $("onboardingGender").focus(); }
  });
  $("ageDeny").addEventListener("click", () => {
    $("ageMessage").textContent = "抱歉，RandomMeet 仅供年满 18 周岁的用户使用。你不能继续进入。";
    $("ageConfirm").disabled = true; $("ageDeny").disabled = true;
  });
  $("profileForm").addEventListener("submit", event => {
    event.preventDefault();
    const gender = $("onboardingGender").value, nationality = $("onboardingNationality").value;
    if (!gender || !nationality) return;
    const profile = {gender,nationality};
    try { localStorage.setItem(profileKey, JSON.stringify(profile)); } catch (_) {}
    $("myGender").value = gender; $("myNationality").value = nationality; enterApp();
    say("资料已保存。选择聊天方式和遇见偏好，开始你的随机相遇。");
  });
  const mode = () => document.querySelector('input[name="mode"]:checked').value;
  const preferences = () => ({ mode: mode(), gender: $("myGender").value || "", nationality: $("myNationality").value || "", wantGender: $("wantGender").value || "any", wantNationality: $("wantNationality").value || "any" });
  const say = message => { status.textContent = message; };

  function setSessionControls(active) {
    startBtn.disabled = active || !socket.connected;
    skipBtn.disabled = !active;
    hangupBtn.disabled = !active;
    reportBtn.disabled = !active;
  }

  function cleanup(stopMedia = false) {
    generation += 1;
    if (connectionWatchdog) clearTimeout(connectionWatchdog);
    if (mediaWatchdog) clearTimeout(mediaWatchdog);
    connectionWatchdog = null;
    mediaWatchdog = null;
    iceRestartAttempted = false;
    pendingIce = [];
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    peerId = null;
    sessionId = null;
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

  async function loadIceConfig() {
    if (configuredIceServers) return;
    configuredIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    try {
      const response = await fetch("/ice-config", { cache: "no-store" });
      if (response.ok) {
        const config = await response.json();
        if (Array.isArray(config.iceServers) && config.iceServers.length) {
          configuredIceServers = config.iceServers;
        }
      }
    } catch (error) {
      // Keep the public STUN fallback if the optional configuration endpoint is unavailable.
    }
  }

  async function connect(initiator, gen) {
    if (generation !== gen || !peerId || !sessionId) return;
    const connection = new RTCPeerConnection({
      iceServers: configuredIceServers || [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pc = connection;
    pendingIce = [];

    stream.getTracks().forEach(track => connection.addTrack(track, stream));
    connection.ontrack = event => {
      if (pc !== connection || generation !== gen) return;
      // Some browsers may provide a track without an associated stream.
      const incoming = event.streams && event.streams[0]
        ? event.streams[0]
        : new MediaStream([event.track]);
      remote.srcObject = incoming;
      $("remoteText").hidden = true;
      if (mediaWatchdog) clearTimeout(mediaWatchdog);
      mediaWatchdog = null;
      // Explicitly start playback and surface autoplay failures instead of silently appearing connected.
      const playback = remote.play();
      if (playback && typeof playback.catch === "function") {
        playback.catch(() => say("已收到对方媒体，但浏览器阻止了播放。请点击对方画面或检查标签页静音设置。"));
      }
    };
    connection.onicecandidate = event => {
      if (!event.candidate || pc !== connection || generation !== gen || !peerId) return;
      socket.emit("signal", { type: "ice", data: event.candidate, sessionId });
    };
    connection.onconnectionstatechange = () => {
      if (pc !== connection || generation !== gen) return;
      if (connection.connectionState === "connected") {
        if (connectionWatchdog) clearTimeout(connectionWatchdog);
        connectionWatchdog = null;
        say("已连接，可以开始聊天。");
      } else if (connection.connectionState === "failed") {
        say("媒体连接失败：已尝试自动恢复；如果仍未连接，请点击“跳过”重新匹配。");
      } else if (connection.connectionState === "disconnected") {
        say("媒体连接暂时中断，正在等待网络恢复…");
      }
    };
    connection.oniceconnectionstatechange = () => {
      if (pc !== connection || generation !== gen) return;
      const state = connection.iceConnectionState;
      if (state === "checking") say("信令已启动，正在检查两端媒体网络…");
      else if (state === "connected" || state === "completed") say("网络通道已建立，正在启用媒体…");
      else if (state === "failed") {
        if (currentInitiator && !iceRestartAttempted) {
          iceRestartAttempted = true;
          say("媒体网络连接失败，正在自动尝试重新协商…");
          (async () => {
            try {
              const offer = await connection.createOffer({ iceRestart: true });
              if (pc !== connection || generation !== gen) return;
              await connection.setLocalDescription(offer);
              if (pc !== connection || generation !== gen) return;
              socket.emit("signal", { type: "offer", data: connection.localDescription, sessionId });
              console.info("[RandomMeet] ICE restart offer sent", { sessionId });
            } catch (error) {
              if (pc === connection && generation === gen) {
                say("自动恢复失败：请点击“跳过”重新匹配，或尝试更换网络。");
              }
            }
          })();
        } else if (iceRestartAttempted) {
          say("自动恢复后媒体网络仍未连通。请点击“跳过”重试；若反复失败，服务器可能需要配置 TURN 中继。");
        } else {
          say("正在等待对方尝试恢复媒体连接…");
        }
      } else if (state === "disconnected") say("媒体网络暂时中断，正在尝试恢复…");
    };
    connection.onsignalingstatechange = () => {
      if (pc === connection && generation === gen) {
        console.info("[RandomMeet] signalingState:", connection.signalingState);
      }
    };
    connection.onicegatheringstatechange = () => {
      if (pc === connection && generation === gen) {
        console.info("[RandomMeet] iceGatheringState:", connection.iceGatheringState);
      }
    };

    if (initiator) {
      const offer = await connection.createOffer();
      if (pc !== connection || generation !== gen) return;
      await connection.setLocalDescription(offer);
      if (pc !== connection || generation !== gen) return;
      socket.emit("signal", { type: "offer", data: connection.localDescription, sessionId });
      say("已发送连接请求，等待对方建立媒体通道…");
      console.info("[RandomMeet] offer sent", { sessionId });
    }
  }

  startBtn.onclick = async () => {
    if (!socket.connected) {
      say("正在连接服务器，请稍后再试。");
      return;
    }
    try {
      await startMedia();
      await loadIceConfig();
      cleanup(false);
      searching = true;
      setSessionControls(true);
      say("正在寻找在线用户…");
      socket.emit("find", preferences());
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
    socket.emit("skip", preferences());
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
    sessionId = data.sessionId || null;
    currentInitiator = Boolean(data.initiator);
    const gen = generation;
    say("已匹配，正在建立连接…");
    connectionWatchdog = setTimeout(() => {
      if (generation !== gen || !pc || pc.connectionState === "connected") return;
      if (pc.iceConnectionState === "failed") return;
      say("连接等待超过 15 秒：正在尝试建立媒体通道。请确认双方都允许摄像头/麦克风；若持续无画面声音，请点击“跳过”重试。");
    }, 15000);
    mediaWatchdog = setTimeout(() => {
      if (generation !== gen || !pc || pc.connectionState !== "connected" || remote.srcObject) return;
      say("连接已建立，但还没有收到对方媒体。请确认对方已允许摄像头/麦克风，并检查是否选择了相同模式。");
    }, 20000);
    try {
      await connect(Boolean(data.initiator), gen);
      // Socket events from the two peers can cross in flight: an offer may arrive
      // just before this client's "matched" event. Replay only signals for this session.
      const queued = earlySignals.filter(message => message.sessionId === sessionId);
      earlySignals = [];
      for (const message of queued) await processSignal(message);
    } catch (error) {
      if (generation !== gen) return;
      cleanup(false);
      say("连接协商失败，请点击“跳过”重试。");
    }
  });

  async function processSignal(message) {
    const connection = pc;
    const gen = generation;
    if (!connection || !message || !["offer", "answer", "ice"].includes(message.type)) return;
    if (!sessionId || message.sessionId !== sessionId) return;
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
        console.info("[RandomMeet] offer received", { sessionId });
        say("已收到对方连接请求，正在协商媒体…");
        await connection.setRemoteDescription(message.data);
        await flushPendingIce(connection, gen);
        if (pc !== connection || generation !== gen) return;
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (pc !== connection || generation !== gen) return;
        socket.emit("signal", { type: "answer", data: connection.localDescription, sessionId });
        say("已回复连接请求，正在建立媒体通道…");
        console.info("[RandomMeet] answer sent", { sessionId });
      } else if (message.type === "answer") {
        console.info("[RandomMeet] answer received", { sessionId });
        say("已收到对方回应，正在建立媒体通道…");
        await connection.setRemoteDescription(message.data);
        await flushPendingIce(connection, gen);
      }
    } catch (error) {
      if (generation === gen) say("网络连接协商失败，请点击“跳过”重新匹配。");
    }
  }

  socket.on("signal", message => {
    if (!message || !["offer", "answer", "ice"].includes(message.type)) return;
    if (sessionId) {
      if (message.sessionId !== sessionId) {
        console.info("[RandomMeet] ignored stale signal");
        return;
      }
      console.info("[RandomMeet] signal received:", message.type);
      void processSignal(message);
      return;
    }
    // Keep a small bounded queue for the rare signal-before-matched race.
    if (typeof message.sessionId === "string" && earlySignals.length < 20) {
      earlySignals.push(message);
    }
  });

  socket.on("peer-ended", data => {
    if (data?.sessionId && (!sessionId || data.sessionId !== sessionId)) return;
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