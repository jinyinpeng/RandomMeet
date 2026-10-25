(() => {
const socket=io(), $=id=>document.getElementById(id);
const local=$("local"), remote=$("remote"), status=$("status");
let stream=null, pc=null, peerId=null, searching=false, generation=0;
const mode=()=>document.querySelector('input[name="mode"]:checked').value;
function say(t){status.textContent=t}
function cleanup(stop=true){generation++;if(pc){pc.onicecandidate=null;pc.ontrack=null;pc.close();pc=null}peerId=null;remote.srcObject=null;if(stop&&stream){stream.getTracks().forEach(t=>t.stop());stream=null;local.srcObject=null}}
async function startMedia(){if(stream)return;stream=await navigator.mediaDevices.getUserMedia({audio:true,video:mode()==="video"});local.srcObject=stream;$("localText").hidden=true}
async function connect(initiator,gen){pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});stream.getTracks().forEach(t=>pc.addTrack(t,stream));pc.ontrack=e=>{remote.srcObject=e.streams[0];$("remoteText").hidden=true};pc.onicecandidate=e=>{if(e.candidate)socket.emit("signal",{type:"ice",data:e.candidate})};if(initiator){const offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit("signal",{type:"offer",data:pc.localDescription})}}
$("start").onclick=async()=>{try{await startMedia();cleanup(false);searching=true;$("start").disabled=true;$("skip").disabled=false;$("hangup").disabled=false;$("report").disabled=false;say("正在寻找在线用户…");socket.emit("find",{mode:mode()})}catch(e){say("无法启用摄像头或麦克风，请检查浏览器权限及 HTTPS。")}};
$("skip").onclick=()=>{cleanup(false);socket.emit("skip",{mode:mode()});say("正在寻找下一位…")};
$("hangup").onclick=()=>{cleanup(true);socket.emit("leave");searching=false;$("start").disabled=false;$("skip").disabled=true;$("hangup").disabled=true;$("report").disabled=true;say("已挂断。")};
$("report").onclick=()=>{socket.emit("report");say("已提交举报（测试版仅显示确认，不保存案件）。")};
socket.on("status",say);
socket.on("matched",async data=>{try{cleanup(false);peerId=data.peerId;const gen=generation; say("已匹配，正在建立连接…");await connect(data.initiator,gen)}catch(e){say("连接建立失败，请跳过重试。")}});
socket.on("signal",async m=>{if(!pc)return;try{if(m.type==="offer"){await pc.setRemoteDescription(m.data);const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit("signal",{type:"answer",data:pc.localDescription})}else if(m.type==="answer")await pc.setRemoteDescription(m.data);else if(m.type==="ice"&&m.data)await pc.addIceCandidate(m.data)}catch(e){say("网络连接协商失败，请重新匹配。")}});
socket.on("peer-ended",()=>{cleanup(false);say("对方已离开，可重新匹配。");$("start").disabled=false});
window.addEventListener("beforeunload",()=>cleanup(true));
})();
