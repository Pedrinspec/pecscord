type PeerInfo = { id: number; name: string };

type ServerMsg =
  | { type: "joined"; id: number; peers: PeerInfo[] }
  | { type: "peer_joined"; peer: PeerInfo }
  | { type: "peer_left"; id: number }
  | { type: "chat"; from: number; name: string; text: string }
  | { type: "signal"; from: number; data: SignalData }
  | { type: "error"; message: string };

type SignalData =
  | { type: "offer" | "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "streams"; camera: string; screen: string }
  | { type: "media"; kind: Kind; on: boolean };

// Tipos de vídeo que aparecem como tile. O áudio do sistema viaja junto com a tela.
type Kind = "camera" | "screen";
type SenderKey = Kind | "screenAudio";

// Negociação "perfect negotiation": quando as duas pontas oferecem ao mesmo tempo,
// uma delas (a "polite") cede e a outra segue com a sua oferta.
//
// A primeira negociação é exceção: só quem entra na sala (initiator) oferece. Se os dois
// oferecessem ao mesmo tempo, o rollback da primeira oferta no Chromium deixa a conexão
// sem coletar candidatos ICE, e ela nunca conecta.
interface Peer {
  pc: RTCPeerConnection;
  initiator: boolean;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  senders: Partial<Record<SenderKey, RTCRtpSender>>;
}

interface ScreenPreset {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

const KINDS: Kind[] = ["camera", "screen"];

const KIND_LABEL: Record<Kind, string> = { camera: "Câmera", screen: "Tela" };

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

const CAMERA_ENCODING = { maxBitrate: 2_500_000, maxFramerate: 30 };

// Presets de tela: resolução e taxa de captura, mais o teto de bits por conexão.
// 60 fps precisa de bem mais banda do que 30 fps na mesma resolução.
const SCREEN_PRESETS: Record<string, ScreenPreset> = {
  "720p30": { width: 1280, height: 720, frameRate: 30, maxBitrate: 3_000_000 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const joinView = $<HTMLElement>("join");
const roomView = $<HTMLElement>("room-view");
const joinForm = $<HTMLFormElement>("join-form");
const roomInput = $<HTMLInputElement>("room");
const nameInput = $<HTMLInputElement>("name");
const roomName = $<HTMLElement>("room-name");
const participants = $<HTMLUListElement>("participants");
const messages = $<HTMLUListElement>("messages");
const chatForm = $<HTMLFormElement>("chat-form");
const textInput = $<HTMLInputElement>("text");
const muteButton = $<HTMLButtonElement>("mute");
const cameraButton = $<HTMLButtonElement>("camera");
const screenButton = $<HTMLButtonElement>("screen");
const screenQuality = $<HTMLSelectElement>("screen-quality");
const leaveButton = $<HTMLButtonElement>("leave");
const stage = $<HTMLDivElement>("stage");
const strip = $<HTMLDivElement>("strip");
const audioContainer = $<HTMLDivElement>("audio");

let ws: WebSocket | null = null;
let myId = -1;
let myName = "";
let localStream: MediaStream | null = null;
const localTracks: Partial<Record<SenderKey, MediaStreamTrack>> = {};
const names = new Map<number, string>();
const peers = new Map<number, Peer>();
const pendingCandidates = new Map<number, RTCIceCandidateInit[]>();

// Cada tipo de vídeo sai num MediaStream com id próprio. O id vai no SDP (msid),
// então o outro lado sabe qual vídeo é câmera e qual é tela.
const outStreams: Record<Kind, MediaStream> = { camera: new MediaStream(), screen: new MediaStream() };
const kindByStreamId = new Map<string, Kind>();

function currentPreset(): ScreenPreset {
  return SCREEN_PRESETS[screenQuality.value] ?? SCREEN_PRESETS["720p30"];
}

function addLine(text: string, cls = ""): void {
  const li = document.createElement("li");
  li.textContent = text; // textContent evita injeção de HTML vinda de outros usuários
  if (cls) li.className = cls;
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

function send(msg: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function renderParticipants(): void {
  participants.replaceChildren();
  const all: [number, string][] = [[myId, `${myName} (você)`], ...names.entries()];
  for (const [, name] of all) {
    const li = document.createElement("li");
    li.textContent = name;
    participants.append(li);
  }
}

// O palco só aparece quando há alguma tela visível; o resto do tempo as câmeras ocupam tudo.
function refreshLayout(): void {
  const visibleScreens = [...stage.querySelectorAll<HTMLElement>(".tile")].some((t) => !t.hidden);
  stage.hidden = !visibleScreens;
}

function createTile(owner: string, kind: Kind, title: string): { tile: HTMLElement; video: HTMLVideoElement } {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.peer = owner;
  tile.dataset.kind = kind;
  tile.title = "Clique duas vezes para tela cheia";

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const caption = document.createElement("span");
  caption.textContent = title;

  tile.append(video, caption);
  tile.addEventListener("dblclick", () => void video.requestFullscreen?.());
  (kind === "screen" ? stage : strip).append(tile);
  refreshLayout();
  return { tile, video };
}

function setTileHidden(tile: HTMLElement, hidden: boolean): void {
  tile.hidden = hidden;
  refreshLayout();
}

// Estado ligado/desligado anunciado por cada participante, por tipo de vídeo.
// Pode chegar antes do tile existir; por isso fica guardado aqui.
const remoteMediaOn = new Map<string, boolean>();
const mediaKey = (peerId: number, kind: Kind): string => `${peerId}:${kind}`;

// Cria (ou reaproveita) a conexão WebRTC com um participante.
function createPeer(peerId: number, initiator: boolean): Peer {
  const existing = peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer: Peer = {
    pc,
    initiator,
    polite: myId > peerId,
    makingOffer: false,
    ignoreOffer: false,
    senders: {},
  };
  peers.set(peerId, peer);

  // Avisa o outro lado quais ids de stream são câmera e tela, antes de qualquer oferta.
  send({
    type: "signal",
    to: peerId,
    data: { type: "streams", camera: outStreams.camera.id, screen: outStreams.screen.id },
  });

  pc.addEventListener("negotiationneeded", async () => {
    // Quem já estava na sala espera a oferta de quem entrou; as faixas dele vão na resposta.
    // Depois da primeira troca, qualquer lado pode reoferecer.
    if (!peer.initiator && !pc.remoteDescription) return;
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendDescription(peerId, pc);
    } catch (err) {
      addLine(`Erro ao negociar com ${names.get(peerId) ?? "alguém"}: ${err}`, "error");
    } finally {
      peer.makingOffer = false;
    }
  });

  if (localStream) {
    for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream);
  } else {
    // Sem microfone, a pessoa ainda ouve os outros.
    pc.addTransceiver("audio", { direction: "recvonly" });
  }

  // Se câmera ou tela já estiverem ligadas aqui, a nova conexão também as recebe.
  for (const key of Object.keys(localTracks) as SenderKey[]) {
    const track = localTracks[key];
    if (track) setOutgoing(peer, key, track).catch((err) => addLine(`Erro ao enviar mídia: ${err}`, "error"));
  }

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      send({ type: "signal", to: peerId, data: { type: "candidate", candidate: event.candidate.toJSON() } });
    }
  });

  pc.addEventListener("track", (event) => {
    const kind = kindByStreamId.get(event.streams[0]?.id ?? "");

    if (event.track.kind === "audio") {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.dataset.peer = String(peerId);
      audio.dataset.kind = kind === "screen" ? "screen-audio" : "mic";
      audio.srcObject = new MediaStream([event.track]);
      audioContainer.append(audio);
      return;
    }

    if (kind) addRemoteVideo(peerId, kind, event.track);
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      addLine(`A conexão com ${names.get(peerId) ?? "alguém"} falhou.`, "error");
    }
  });

  return peer;
}

function removePeer(peerId: number): void {
  peers.get(peerId)?.pc.close();
  peers.delete(peerId);
  pendingCandidates.delete(peerId);
  for (const kind of KINDS) remoteMediaOn.delete(mediaKey(peerId, kind));
  document.querySelectorAll<HTMLElement>(`[data-peer="${peerId}"]`).forEach((el) => el.remove());
  refreshLayout();
}

function sendDescription(peerId: number, pc: RTCPeerConnection): void {
  const desc = pc.localDescription;
  if (desc) send({ type: "signal", to: peerId, data: { type: desc.type, sdp: desc.sdp ?? "" } });
}

function addRemoteVideo(peerId: number, kind: Kind, track: MediaStreamTrack): void {
  const title = `${names.get(peerId) ?? "Alguém"} — ${KIND_LABEL[kind]}`;
  const { tile, video } = createTile(String(peerId), kind, title);
  video.srcObject = new MediaStream([track]);

  // A faixa chega "muda" até os primeiros quadros. Mostramos o tile quando o vídeo
  // de fato começa a tocar; o "unmute" da faixa nem sempre dispara no Chromium quando
  // há várias negociações simultâneas. Esconder só acontece pelo aviso "media" do emissor.
  const show = (): void => {
    if (remoteMediaOn.get(mediaKey(peerId, kind)) !== false) setTileHidden(tile, false);
  };
  setTileHidden(tile, track.muted);
  track.addEventListener("unmute", show);
  video.addEventListener("playing", show);
  video.addEventListener("resize", show);
  track.addEventListener("ended", () => {
    tile.remove();
    refreshLayout();
  });
}

async function configureSender(sender: RTCRtpSender, key: SenderKey): Promise<void> {
  if (key === "screenAudio") return;

  const params = sender.getParameters();
  const encoding = params.encodings[0];
  if (!encoding) return;

  if (key === "camera") {
    encoding.maxBitrate = CAMERA_ENCODING.maxBitrate;
    encoding.maxFramerate = CAMERA_ENCODING.maxFramerate;
    params.degradationPreference = "balanced";
  } else {
    const preset = currentPreset();
    encoding.maxBitrate = preset.maxBitrate;
    encoding.maxFramerate = preset.frameRate;
    params.degradationPreference = "maintain-framerate"; // tela prioriza fluidez
  }
  await sender.setParameters(params);
}

// Liga (track) ou desliga (null) uma mídia para um participante.
// O primeiro envio cria o sender com addTrack (negocia uma vez); depois só troca a faixa.
async function setOutgoing(peer: Peer, key: SenderKey, track: MediaStreamTrack | null): Promise<void> {
  const existing = peer.senders[key];
  if (existing) {
    await existing.replaceTrack(track);
  } else if (track) {
    const stream = key === "camera" ? outStreams.camera : outStreams.screen;
    peer.senders[key] = peer.pc.addTrack(track, stream);
  }

  const sender = peer.senders[key];
  if (sender && track) await configureSender(sender, key);
}

// Desligar a faixa (replaceTrack(null)) não gera sinal de "mute" no outro lado,
// então avisamos explicitamente para esconder o tile.
function announceMedia(kind: Kind, on: boolean): void {
  for (const peerId of peers.keys()) {
    send({ type: "signal", to: peerId, data: { type: "media", kind, on } });
  }
}

async function acquireCamera(): Promise<MediaStreamTrack[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS, audio: false });
  return stream.getVideoTracks();
}

async function acquireScreen(): Promise<MediaStreamTrack[]> {
  const preset = currentPreset();
  const options: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    },
    // Áudio do sistema sem processamento de voz, para música e jogos soarem como são.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: "include", // Chromium: oferece a opção de incluir o áudio do sistema
    selfBrowserSurface: "exclude", // não lista a própria aba do Pecscord
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const video = stream.getVideoTracks()[0];
  video.contentHint = "motion"; // prioriza fluidez sobre nitidez em conteúdo que se move
  return [video, ...stream.getAudioTracks()];
}

async function startLocal(kind: Kind): Promise<void> {
  if (localTracks[kind]) return;

  const tracks = kind === "camera" ? await acquireCamera() : await acquireScreen();
  const [video, audio] = tracks;
  localTracks[kind] = video;
  if (kind === "screen" && audio) localTracks.screenAudio = audio;

  video.addEventListener("ended", () => void stopLocal(kind)); // ex.: usuário clicou em "parar de compartilhar" no navegador

  const { video: el } = createTile("local", kind, `Você — ${KIND_LABEL[kind]}`);
  el.muted = true;
  el.srcObject = new MediaStream([video]);

  for (const peer of peers.values()) {
    await setOutgoing(peer, kind, video);
    if (kind === "screen" && audio) await setOutgoing(peer, "screenAudio", audio);
  }
  announceMedia(kind, true);
  updateButtons();
}

async function stopLocal(kind: Kind): Promise<void> {
  const track = localTracks[kind];
  if (!track) return;

  const keys: SenderKey[] = kind === "screen" ? ["screen", "screenAudio"] : ["camera"];
  for (const key of keys) {
    localTracks[key]?.stop();
    delete localTracks[key];
  }
  document.querySelector<HTMLElement>(`[data-peer="local"][data-kind="${kind}"]`)?.remove();
  refreshLayout();

  announceMedia(kind, false);
  for (const peer of peers.values()) {
    for (const key of keys) await peer.senders[key]?.replaceTrack(null);
  }
  updateButtons();
}

async function toggleLocal(kind: Kind): Promise<void> {
  try {
    if (localTracks[kind]) await stopLocal(kind);
    else await startLocal(kind);
  } catch (err) {
    addLine(`Não foi possível usar ${KIND_LABEL[kind].toLowerCase()}: ${err}`, "error");
  }
  updateButtons();
}

// Troca de preset com a tela já ligada: ajusta a captura e o teto de envio sem renegociar.
async function applyScreenPreset(): Promise<void> {
  const track = localTracks.screen;
  if (!track) return;

  const preset = currentPreset();
  try {
    await track.applyConstraints({
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    });
  } catch (err) {
    addLine(`A captura não aceitou o novo preset: ${err}`, "error");
  }
  for (const peer of peers.values()) {
    const sender = peer.senders.screen;
    if (sender) await configureSender(sender, "screen");
  }
}

function updateButtons(): void {
  cameraButton.textContent = localTracks.camera ? "Desligar câmera" : "Ligar câmera";
  cameraButton.classList.toggle("active", !!localTracks.camera);
  screenButton.textContent = localTracks.screen ? "Parar tela" : "Compartilhar tela";
  screenButton.classList.toggle("active", !!localTracks.screen);
}

async function handleSignal(from: number, data: SignalData): Promise<void> {
  if (data.type === "streams") {
    kindByStreamId.set(data.camera, "camera");
    kindByStreamId.set(data.screen, "screen");
    return;
  }

  if (data.type === "media") {
    remoteMediaOn.set(mediaKey(from, data.kind), data.on);
    document
      .querySelectorAll<HTMLElement>(`.tile[data-peer="${from}"][data-kind="${data.kind}"]`)
      .forEach((el) => setTileHidden(el, !data.on));
    return;
  }

  const peer = createPeer(from, false);
  const pc = peer.pc;

  if (data.type === "candidate") {
    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!peer.ignoreOffer) throw err; // candidatos de uma oferta descartada são esperados
      }
    } else {
      // Candidatos que chegam antes da descrição remota são guardados.
      const queue = pendingCandidates.get(from) ?? [];
      queue.push(data.candidate);
      pendingCandidates.set(from, queue);
    }
    return;
  }

  const offerCollision = data.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
  peer.ignoreOffer = !peer.polite && offerCollision;
  if (peer.ignoreOffer) return;

  await pc.setRemoteDescription({ type: data.type, sdp: data.sdp });

  for (const candidate of pendingCandidates.get(from) ?? []) {
    await pc.addIceCandidate(candidate);
  }
  pendingCandidates.delete(from);

  if (data.type === "offer") {
    await pc.setLocalDescription();
    sendDescription(from, pc);
  }
}

function handleMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case "joined":
      myId = msg.id;
      for (const p of msg.peers) {
        names.set(p.id, p.name);
        createPeer(p.id, true);
      }
      renderParticipants();
      addLine(`Você entrou na sala com ${msg.peers.length} outra(s) pessoa(s).`, "system");
      break;
    case "peer_joined":
      names.set(msg.peer.id, msg.peer.name);
      createPeer(msg.peer.id, false);
      renderParticipants();
      addLine(`${msg.peer.name} entrou na sala.`, "system");
      break;
    case "peer_left":
      addLine(`${names.get(msg.id) ?? "Alguém"} saiu da sala.`, "system");
      names.delete(msg.id);
      removePeer(msg.id);
      renderParticipants();
      break;
    case "chat":
      addLine(`${msg.name}: ${msg.text}`);
      break;
    case "signal":
      handleSignal(msg.from, msg.data).catch((err) => addLine(`Erro de sinalização: ${err}`, "error"));
      break;
    case "error":
      addLine(msg.message, "error");
      break;
  }
}

function cleanup(): void {
  for (const id of [...peers.keys()]) removePeer(id);
  for (const key of Object.keys(localTracks) as SenderKey[]) {
    localTracks[key]?.stop();
    delete localTracks[key];
  }
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  names.clear();
  ws = null;
  myId = -1;
  stage.replaceChildren();
  strip.replaceChildren();
  audioContainer.replaceChildren();
  messages.replaceChildren();
  participants.replaceChildren();
  refreshLayout();
  muteButton.textContent = "Mutar";
  muteButton.classList.remove("active");
  updateButtons();
  roomView.hidden = true;
  joinView.hidden = false;
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (ws) return;

  const room = roomInput.value.trim();
  const name = nameInput.value.trim();
  if (!room || !name) return;
  myName = name;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    localStream = null;
  }

  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  ws = socket;

  socket.addEventListener("open", () => {
    send({ type: "join", room, name });
    roomName.textContent = room;
    joinView.hidden = true;
    roomView.hidden = false;
    muteButton.disabled = localStream === null;
    if (!localStream) addLine("Microfone indisponível: você vai ouvir, mas não falar.", "error");
    textInput.focus();
  });

  socket.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data as string) as ServerMsg);
  });

  socket.addEventListener("close", () => {
    cleanup();
  });
});

muteButton.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  muteButton.textContent = track.enabled ? "Mutar" : "Desmutar";
  muteButton.classList.toggle("active", !track.enabled);
});

cameraButton.addEventListener("click", () => void toggleLocal("camera"));
screenButton.addEventListener("click", () => void toggleLocal("screen"));
screenQuality.addEventListener("change", () => void applyScreenPreset());
leaveButton.addEventListener("click", () => ws?.close());

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  textInput.value = "";
});

// Torna este arquivo um módulo, o que o `declare global` abaixo exige.
export {};

// Exposto para os testes automatizados lerem o estado real da captura de tela.
declare global {
  interface Window {
    __pecscordDebug?: { screenSettings: () => MediaTrackSettings | null };
  }
}
window.__pecscordDebug = {
  screenSettings: () => localTracks.screen?.getSettings() ?? null,
};
