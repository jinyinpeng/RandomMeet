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
  const blockBtn = $("block");
  const blockedGate = $("blockedGate");
  const blockedList = $("blockedList");
  const manageBlockedBtn = $("manageBlocked");
  const reportGate = $("reportGate");
  const reportForm = $("reportForm");
  const clientIdKey = "randommeet_client_id_v1";
  const blockedKey = "randommeet_blocked_ids_v1";
  const recentKey = "randommeet_recent_matches_v1";
  const readIdList = key => { try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string") : []; } catch (_) { return []; } };
  const writeIdList = (key, list, max) => { try { localStorage.setItem(key, JSON.stringify(list.slice(-max))); } catch (_) {} };
  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
  let clientId = "";
  try { clientId = localStorage.getItem(clientIdKey) || ""; if (!/^[0-9a-f-]{36}$/i.test(clientId)) clientId = makeId(); localStorage.setItem(clientIdKey, clientId); } catch (_) { clientId = makeId(); }
  let peerClientId = "";

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
  let relayCheckTimer = null;
  let audioFallbackApplied = false;

  // Require an explicit 18+ confirmation on every visit; first-time visitors must complete their profile.
  const ageGate = $("ageGate");
  const profileGate = $("profileGate");
  const profileKey = "randommeet_profile_v1";
  const countryCodes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");
  const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
  const countryOptions = countryCodes.map(code => ({ code, name: countryNames.of(code) || code })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  const fillCountrySelect = (select, firstLabel) => {
    select.replaceChildren(new Option(firstLabel, ""));
    countryOptions.forEach(({code, name}) => select.add(new Option(name, code)));
  };
  fillCountrySelect($("onboardingNationality"), "Select nationality");
  const matchCountry = $("wantNationality");
  matchCountry.replaceChildren(new Option("Any country", "any"));
  countryOptions.forEach(({code, name}) => matchCountry.add(new Option(name, code)));
  const savedProfile = () => { try { return JSON.parse(localStorage.getItem(profileKey) || "null"); } catch (_) { return null; } };
  const validProfile = value => value && ["female","male","other"].includes(value.gender) && countryCodes.includes(value.nationality);
  let currentProfile = validProfile(savedProfile()) ? savedProfile() : null;
  const enterApp = () => { ageGate.hidden = true; profileGate.hidden = true; };
  $("ageConfirm").addEventListener("click", () => {
    const profile = savedProfile();
    if (validProfile(profile)) {
      currentProfile = profile; enterApp();
    } else { ageGate.hidden = true; profileGate.hidden = false; $("onboardingGender").focus(); }
  });
  $("ageDeny").addEventListener("click", () => {
    $("ageMessage").textContent = "Sorry, RandomMeet is for users aged 18 and over only. You cannot continue.";
    $("ageConfirm").disabled = true; $("ageDeny").disabled = true;
  });
  $("profileForm").addEventListener("submit", event => {
    event.preventDefault();
    const gender = $("onboardingGender").value, nationality = $("onboardingNationality").value;
    if (!gender || !nationality) return;
    const profile = {gender,nationality};
    currentProfile = profile;
    try { localStorage.setItem(profileKey, JSON.stringify(profile)); } catch (_) {}
    enterApp();
    say("Profile saved. Choose your chat mode and match preferences to get started.");
  });
  const mode = () => document.querySelector('input[name="mode"]:checked').value;
  const renderBlocked = () => {
    const blocked = readIdList(blockedKey);
    $("blockedCount").textContent = String(blocked.length);
    manageBlockedBtn.textContent = blocked.length ? "Manage blocked users (" + blocked.length + ")" : "Manage blocked users";
    blockedList.replaceChildren();
    if (!blocked.length) {
      const empty = document.createElement("p");
      empty.className = "blocked-empty";
      empty.textContent = "You have not blocked anyone.";
      blockedList.append(empty);
      return;
    }
    blocked.slice().reverse().forEach(id => {
      const row = document.createElement("div");
      row.className = "blocked-entry";
      const details = document.createElement("div");
      details.className = "blocked-details";
      const title = document.createElement("strong");
      title.textContent = "Blocked browser";
      const identifier = document.createElement("small");
      identifier.textContent = "ID ending in " + id.slice(-6);
      details.append(title, identifier);
      const unblock = document.createElement("button");
      unblock.type = "button";
      unblock.className = "secondary-button unblock-button";
      unblock.textContent = "Unblock";
      unblock.addEventListener("click", () => {
        const updated = readIdList(blockedKey).filter(item => item !== id);
        writeIdList(blockedKey, updated, 200);
        renderBlocked();
        say("User unblocked. You may be matched with this browser again.");
      });
      row.append(details, unblock);
      blockedList.append(row);
    });
  };
  const preferences = () => ({ mode: mode(), gender: currentProfile?.gender || "", nationality: currentProfile?.nationality || "", wantGender: $("wantGender").value || "any", wantNationality: $("wantNationality").value || "any", clientId, blockedIds: readIdList(blockedKey).slice(-200), recentMatches: readIdList(recentKey).slice(-20) });
  const say = message => { status.textContent = message; };

  function setSessionControls(active) {
    startBtn.disabled = active || !socket.connected;
    skipBtn.disabled = !active;
    hangupBtn.disabled = !active;
    reportBtn.disabled = !active || !sessionId;
    blockBtn.disabled = !active || !sessionId;
  }

  function cleanup(stopMedia = false) {
    generation += 1;
    if (connectionWatchdog) clearTimeout(connectionWatchdog);
    if (mediaWatchdog) clearTimeout(mediaWatchdog);
    if (relayCheckTimer) clearInterval(relayCheckTimer);
    relayCheckTimer = null;
    audioFallbackApplied = false;
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
    peerClientId = "";
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

  async function fallbackToAudio(notifyPeer = false) {
    if (audioFallbackApplied) return;
    audioFallbackApplied = true;
    try {
      if (pc) {
        const videoSender = pc.getSenders().find(sender => sender.track && sender.track.kind === "video");
        if (videoSender) await videoSender.replaceTrack(null);
      }
    } catch (error) {
      console.warn("[RandomMeet] Could not detach video sender cleanly", error);
    }
    if (stream) {
      stream.getVideoTracks().forEach(track => { track.enabled = false; track.stop(); });
      local.srcObject = stream;
    }
    if (remote.srcObject && typeof remote.srcObject.getVideoTracks === "function") {
      remote.srcObject.getVideoTracks().forEach(track => { track.enabled = false; });
    }
    say("The other person’s network cannot establish a direct video connection. Switched to audio-only.");
    if (notifyPeer && sessionId) socket.emit("signal", { type: "audio-fallback", data: { reason: "turn-relay" }, sessionId });
  }

  async function checkSelectedIcePair(connection, gen) {
    if (pc !== connection || generation !== gen || audioFallbackApplied || mode() !== "video") return;
    try {
      const stats = await connection.getStats();
      const reports = Array.from(stats.values());
      const pair = reports.find(item => item.type === "candidate-pair" &&
        (item.selected === true || (item.nominated === true && item.state === "succeeded")));
      if (!pair) return;
      const localCandidate = stats.get(pair.localCandidateId);
      const remoteCandidate = stats.get(pair.remoteCandidateId);
      // A relay candidate is a valid WebRTC path, not proof that video is broken.
      // Do not disable video just because TURN is selected; that can make a healthy
      // connection appear to have lost its camera. Audio fallback remains available
      // for explicit peer signaling, but relay selection alone must not trigger it.
      if (localCandidate?.candidateType === "relay" || remoteCandidate?.candidateType === "relay") {
        console.info("[RandomMeet] TURN relay selected; keeping video enabled.");
      }
    } catch (error) {
      console.info("[RandomMeet] Could not inspect selected ICE pair", error);
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
      // Prefer the stream supplied by WebRTC. If a browser emits streamless tracks,
      // merge them into one MediaStream instead of replacing the previous track.
      // Replacing srcObject for each streamless event can silently drop audio or video.
      let incoming = remote.srcObject instanceof MediaStream ? remote.srcObject : null;
      if (event.streams && event.streams[0]) {
        incoming = event.streams[0];
      } else {
        if (!incoming) incoming = new MediaStream();
        if (!incoming.getTracks().some(track => track.id === event.track.id)) {
          incoming.addTrack(event.track);
        }
      }
      remote.srcObject = incoming;
      $("remoteText").hidden = false;
      if (mediaWatchdog) clearTimeout(mediaWatchdog);
      mediaWatchdog = null;
      const playback = remote.play();
      if (playback && typeof playback.catch === "function") {
        playback.catch(error => {
          console.warn("[RandomMeet] Remote playback failed", error);
          say("Remote media arrived, but playback was blocked. Click the remote video to start audio/video.");
        });
      }
      console.info("[RandomMeet] remote track received", {
        kind: event.track.kind,
        streamTracks: incoming.getTracks().map(track => track.kind + ":" + track.readyState)
      });
      event.track.addEventListener("ended", () => {
        console.warn("[RandomMeet] remote track ended", event.track.kind);
      }, { once: true });
    };
    connection.onicecandidate = event => {
      if (!event.candidate || pc !== connection || generation !== gen || !peerId) return;
      socket.emit("signal", { type: "ice", data: event.candidate, sessionId });
    };
    connection.onconnectionstatechange = () => {
      if (pc !== connection || generation !== gen) return;
      if (connection.connectionState === "connected") {
        if (connectionWatchdog) clearTimeout(connectionWatchdog);
        if (mode() === "video" && !relayCheckTimer) {
          void checkSelectedIcePair(connection, gen);
          relayCheckTimer = setInterval(() => { void checkSelectedIcePair(connection, gen); }, 4000);
        }
        connectionWatchdog = null;
        say("Connected. You can start chatting.");
      } else if (connection.connectionState === "failed") {
        say("Media connection failed. Automatic recovery was attempted; select “Next” to find another match.");
      } else if (connection.connectionState === "disconnected") {
        say("Media connection interrupted. Waiting for the network to recover…");
      }
    };
    connection.oniceconnectionstatechange = () => {
      if (pc !== connection || generation !== gen) return;
      const state = connection.iceConnectionState;
      if (state === "checking") say("Signaling started. Checking media connectivity…");
      else if (state === "connected" || state === "completed") say("Network channel established. Starting media…");
      else if (state === "failed") {
        if (currentInitiator && !iceRestartAttempted) {
          iceRestartAttempted = true;
          say("Media connection failed. Trying to renegotiate…");
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
                say("Automatic recovery failed. Select “Next” to find another match or try another network.");
              }
            }
          })();
        } else if (iceRestartAttempted) {
          say("Media is still not connected. Select “Next” to retry. A TURN relay may be required.");
        } else {
          say("Waiting for the other person to restore their connection…");
        }
      } else if (state === "disconnected") say("Media connection interrupted. Trying to recover…");
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
      say("Connection offer sent. Waiting for the other person…");
      console.info("[RandomMeet] offer sent", { sessionId });
    }
  }

  startBtn.onclick = async () => {
    if (!socket.connected) {
      say("Connecting to the server. Please try again in a moment.");
      return;
    }
    try {
      await startMedia();
      await loadIceConfig();
      cleanup(false);
      searching = true;
      setSessionControls(true);
      say("Looking for someone online…");
      socket.emit("find", preferences());
    } catch (error) {
      cleanup(true);
      searching = false;
      setSessionControls(false);
      say("Could not access your camera or microphone. Check browser permissions and HTTPS.");
    }
  };

  skipBtn.onclick = () => {
    if (!searching || !socket.connected) return;
    cleanup(false);
    setSessionControls(true);
    say("Looking for your next match…");
    socket.emit("skip", preferences());
  };

  hangupBtn.onclick = () => {
    cleanup(true);
    socket.emit("leave");
    searching = false;
    setSessionControls(false);
    say("Chat ended.");
  };

  reportBtn.onclick = () => {
    if (!sessionId || !socket.connected) return;
    reportGate.hidden = false;
    $("reportReason").focus();
  };

  $("reportCancel").onclick = () => { reportGate.hidden = true; reportForm.reset(); };
  reportForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!sessionId || !socket.connected) {
      reportGate.hidden = true;
      say("This chat has already ended. Find another match before reporting.");
      return;
    }
    socket.emit("report", { sessionId, reason: $("reportReason").value });
    $("reportSubmit").disabled = true;
    say("Submitting report…");
  });

  manageBlockedBtn.onclick = () => {
    renderBlocked();
    blockedGate.hidden = false;
  };
  $("blockedClose").onclick = () => { blockedGate.hidden = true; };

  blockBtn.onclick = () => {
    if (!sessionId || !socket.connected) return;
    if (!window.confirm("Block this person and end the chat? You will not be matched with this browser again unless you clear this site's data.")) return;
    const targetId = peerClientId;
    if (targetId) {
      const blocked = readIdList(blockedKey).filter(id => id !== targetId);
      blocked.push(targetId);
      writeIdList(blockedKey, blocked, 200);
      renderBlocked();
    }
    socket.emit("block", { sessionId });
    cleanup(true);
    searching = false;
    setSessionControls(false);
    say("This person has been blocked on this browser and the chat has ended.");
  };

  renderBlocked();

  socket.on("connect", () => {
    if (!searching) startBtn.disabled = false;
  });
  socket.on("disconnect", () => {
    reportGate.hidden = true;
    $("reportSubmit").disabled = false;
    reportForm.reset();
    cleanup(true);
    searching = false;
    setSessionControls(false);
    say("Disconnected from the server. Reconnecting…");
  });
  socket.on("connect_error", () => {
    say("Could not connect to the server. Check your connection and try again.");
  });
  socket.on("status", message => say(message));
  socket.on("report-result", result => {
    reportGate.hidden = true;
    $("reportSubmit").disabled = false;
    reportForm.reset();
    if (result?.ok) {
      cleanup(true);
      searching = false;
      setSessionControls(false);
    }
    say(result?.message || "We could not submit your report. Please end the chat if you feel unsafe.");
  });
  socket.on("blocked", data => {
    if (data?.clientId) {
      const blocked = readIdList(blockedKey).filter(id => id !== data.clientId);
      blocked.push(data.clientId);
      writeIdList(blockedKey, blocked, 200);
    }
  });

  socket.on("matched", async data => {
    cleanup(false);
    peerId = data.peerId;
    peerClientId = typeof data.peerClientId === "string" ? data.peerClientId : "";
    if (peerClientId) {
      const recent = readIdList(recentKey).filter(id => id !== peerClientId);
      recent.push(peerClientId);
      writeIdList(recentKey, recent, 20);
    }
    sessionId = data.sessionId || null;
    setSessionControls(true);
    currentInitiator = Boolean(data.initiator);
    const gen = generation;
    say("Match found. Connecting…");
    connectionWatchdog = setTimeout(() => {
      if (generation !== gen || !pc || pc.connectionState === "connected") return;
      if (pc.iceConnectionState === "failed") return;
      say("Connection is taking over 15 seconds. Check camera/microphone permissions on both sides. Select “Next” if there is still no audio or video.");
    }, 15000);
    mediaWatchdog = setTimeout(() => {
      if (generation !== gen || !pc || pc.connectionState !== "connected" || remote.srcObject) return;
      say("Connected, but no remote media received yet. Check camera/microphone permissions and make sure both users selected the same mode.");
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
      say("Connection negotiation failed. Select “Next” to try again.");
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
        say("Connection offer received. Negotiating media…");
        await connection.setRemoteDescription(message.data);
        await flushPendingIce(connection, gen);
        if (pc !== connection || generation !== gen) return;
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (pc !== connection || generation !== gen) return;
        socket.emit("signal", { type: "answer", data: connection.localDescription, sessionId });
        say("Connection answer sent. Establishing media…");
        console.info("[RandomMeet] answer sent", { sessionId });
      } else if (message.type === "answer") {
        console.info("[RandomMeet] answer received", { sessionId });
        say("Answer received. Establishing media…");
        await connection.setRemoteDescription(message.data);
        await flushPendingIce(connection, gen);
      }
    } catch (error) {
      if (generation === gen) say("Network negotiation failed. Select “Next” to find another match.");
    }
  }

  socket.on("signal", message => {
    if (!message || !["offer", "answer", "ice", "audio-fallback"].includes(message.type)) return;
    if (sessionId) {
      if (message.sessionId !== sessionId) {
        console.info("[RandomMeet] ignored stale signal");
        return;
      }
      console.info("[RandomMeet] signal received:", message.type);
      if (message.type === "audio-fallback") {
        void fallbackToAudio(false);
        return;
      }
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
    say("The other person left. You can find another match.");
  });

  window.addEventListener("beforeunload", () => {
    cleanup(true);
    socket.emit("leave");
  });
})();