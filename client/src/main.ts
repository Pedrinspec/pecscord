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
// "mic" é a voz; fica fora de localTracks porque é negociada na criação da conexão.
type SenderKey = Kind | "screenAudio" | "mic";

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
const volumePanel = $<HTMLDivElement>("volume-panel");
const volumeName = $<HTMLSpanElement>("volume-name");
const volumeClose = $<HTMLButtonElement>("volume-close");
const messages = $<HTMLUListElement>("messages");
const chatForm = $<HTMLFormElement>("chat-form");
const textInput = $<HTMLInputElement>("text");
const muteButton = $<HTMLButtonElement>("mute");
const noiseCheckbox = $<HTMLInputElement>("noise-suppression");
const cameraButton = $<HTMLButtonElement>("camera");
const screenButton = $<HTMLButtonElement>("screen");
const screenQuality = $<HTMLSelectElement>("screen-quality");
const leaveButton = $<HTMLButtonElement>("leave");
const layoutSelect = $<HTMLSelectElement>("layout");
const videos = $<HTMLDivElement>("videos");
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

// ---- volume por pessoa ------------------------------------------------------
// O áudio de cada participante passa por um GainNode por canal (voz e tela), o que
// permite reduzir, mutar ou amplificar (até 200%) só aquela pessoa, e a tela dela
// separadamente da voz.

type AudioChannel = "mic" | "screen";
const CHANNELS: AudioChannel[] = ["mic", "screen"];
const VOLUME_MAX = 2;

let audioCtx: AudioContext | null = null;
const peerGains = new Map<string, GainNode>();
const volumes = new Map<string, number>(); // 0..2; ausente = 1
const mutedAudio = new Set<string>();
let panelPeer: number | null = null;

const audioKey = (peerId: number, channel: AudioChannel): string => `${peerId}:${channel}`;

const channelControls: Record<AudioChannel, { range: HTMLInputElement; value: HTMLSpanElement; mute: HTMLButtonElement }> = {
  mic: { range: $("volume-mic"), value: $("volume-mic-value"), mute: $("volume-mic-mute") },
  screen: { range: $("volume-screen"), value: $("volume-screen-value"), mute: $("volume-screen-mute") },
};

function ensureAudioCtx(): AudioContext {
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function effectiveGain(peerId: number, channel: AudioChannel): number {
  const key = audioKey(peerId, channel);
  return mutedAudio.has(key) ? 0 : (volumes.get(key) ?? 1);
}

function peerGain(peerId: number, channel: AudioChannel): GainNode {
  const key = audioKey(peerId, channel);
  let gain = peerGains.get(key);
  if (!gain) {
    const ctx = ensureAudioCtx();
    gain = ctx.createGain();
    gain.gain.value = effectiveGain(peerId, channel);
    gain.connect(ctx.destination);
    peerGains.set(key, gain);
  }
  return gain;
}

function attachRemoteAudio(peerId: number, track: MediaStreamTrack, channel: AudioChannel): void {
  const stream = new MediaStream([track]);

  // O Chromium só faz o áudio WebRTC fluir se a stream estiver num elemento de mídia;
  // ele fica mudo e o som real sai pelo GainNode.
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.muted = true;
  audio.dataset.peer = String(peerId);
  audio.dataset.kind = channel;
  audio.srcObject = stream;
  audioContainer.append(audio);

  ensureAudioCtx().createMediaStreamSource(stream).connect(peerGain(peerId, channel));
}

function applyGain(peerId: number, channel: AudioChannel): void {
  const gain = peerGains.get(audioKey(peerId, channel));
  if (gain) gain.gain.value = effectiveGain(peerId, channel);
}

const volumeStorageKey = (name: string, channel: AudioChannel): string => `pecscord-volume:${channel}:${name}`;

function loadVolumes(peerId: number, name: string): void {
  for (const channel of CHANNELS) {
    try {
      const raw = localStorage.getItem(volumeStorageKey(name, channel));
      const v = raw === null ? NaN : Number(raw);
      if (Number.isFinite(v)) volumes.set(audioKey(peerId, channel), Math.min(VOLUME_MAX, Math.max(0, v)));
    } catch {
      // sem armazenamento: começa em 100%
    }
  }
}

function setVolume(peerId: number, channel: AudioChannel, value: number): void {
  const v = Math.min(VOLUME_MAX, Math.max(0, value));
  volumes.set(audioKey(peerId, channel), v);
  const name = names.get(peerId);
  if (name) {
    try {
      localStorage.setItem(volumeStorageKey(name, channel), String(v));
    } catch {
      // sem armazenamento: o ajuste vale só nesta sessão
    }
  }
  applyGain(peerId, channel);
  syncVolumePanel();
  renderParticipants();
}

function toggleMuteAudio(peerId: number, channel: AudioChannel): void {
  const key = audioKey(peerId, channel);
  if (mutedAudio.has(key)) mutedAudio.delete(key);
  else mutedAudio.add(key);
  applyGain(peerId, channel);
  syncVolumePanel();
  renderParticipants();
}

function syncVolumePanel(): void {
  if (panelPeer === null) return;
  volumeName.textContent = names.get(panelPeer) ?? "";
  for (const channel of CHANNELS) {
    const c = channelControls[channel];
    const pct = Math.round((volumes.get(audioKey(panelPeer, channel)) ?? 1) * 100);
    const muted = mutedAudio.has(audioKey(panelPeer, channel));
    c.range.value = String(pct);
    c.value.textContent = `${pct}%`;
    c.mute.textContent = muted ? "Desmutar" : "Mutar";
    c.mute.classList.toggle("active", muted);
  }
}

function openVolumePanel(peerId: number): void {
  panelPeer = peerId;
  syncVolumePanel();
  volumePanel.hidden = false;
  renderParticipants();
}

function closeVolumePanel(): void {
  panelPeer = null;
  volumePanel.hidden = true;
  renderParticipants();
}

function dropPeerAudio(peerId: number): void {
  for (const channel of CHANNELS) {
    const key = audioKey(peerId, channel);
    peerGains.get(key)?.disconnect();
    peerGains.delete(key);
    volumes.delete(key);
    mutedAudio.delete(key);
  }
  if (panelPeer === peerId) closeVolumePanel();
}

function participantLabel(peerId: number, name: string): string {
  if (peerId === myId) return `${name} (você)`;
  const parts: string[] = [];
  if (mutedAudio.has(audioKey(peerId, "mic"))) parts.push("mudo");
  else {
    const pct = Math.round((volumes.get(audioKey(peerId, "mic")) ?? 1) * 100);
    if (pct !== 100) parts.push(`${pct}%`);
  }
  if (mutedAudio.has(audioKey(peerId, "screen"))) parts.push("tela muda");
  return parts.length ? `${name} · ${parts.join(" · ")}` : name;
}

function renderParticipants(): void {
  participants.replaceChildren();
  const all: [number, string][] = [[myId, myName], ...names.entries()];
  for (const [peerId, name] of all) {
    const li = document.createElement("li");
    li.textContent = participantLabel(peerId, name);
    if (peerId !== myId) {
      li.dataset.peer = String(peerId);
      li.title = "Clique para ajustar o volume";
      li.classList.toggle("selected", panelPeer === peerId);
      li.classList.toggle("quiet", effectiveGain(peerId, "mic") === 0);
      li.addEventListener("click", () => (panelPeer === peerId ? closeVolumePanel() : openVolumePanel(peerId)));
    }
    participants.append(li);
  }
}

for (const channel of CHANNELS) {
  const c = channelControls[channel];
  c.range.addEventListener("input", () => {
    if (panelPeer !== null) setVolume(panelPeer, channel, Number(c.range.value) / 100);
  });
  c.mute.addEventListener("click", () => {
    if (panelPeer !== null) toggleMuteAudio(panelPeer, channel);
  });
}
volumeClose.addEventListener("click", closeVolumePanel);

// Tile maximizado: ocupa toda a área de mídia até ser restaurado, esconder ou sair.
let focusedTile: HTMLElement | null = null;

function setFocus(tile: HTMLElement | null): void {
  if (focusedTile) {
    focusedTile.classList.remove("focused");
    const btn = focusedTile.querySelector<HTMLButtonElement>(".max");
    if (btn) btn.textContent = "⤢";
  }
  focusedTile = tile;
  if (tile) {
    tile.classList.add("focused");
    const btn = tile.querySelector<HTMLButtonElement>(".max");
    if (btn) btn.textContent = "⤡";
  }
  videos.classList.toggle("focus", tile !== null);
}

// O palco só aparece quando há alguma tela visível; o resto do tempo as câmeras ocupam tudo.
function refreshLayout(): void {
  const visibleScreens = [...stage.querySelectorAll<HTMLElement>(".tile")].some((t) => !t.hidden);
  stage.hidden = !visibleScreens;
  if (focusedTile && (!focusedTile.isConnected || focusedTile.hidden)) setFocus(null);
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

  const max = document.createElement("button");
  max.type = "button";
  max.className = "max";
  max.textContent = "⤢";
  max.title = "Maximizar / restaurar";
  max.addEventListener("click", (event) => {
    event.stopPropagation();
    setFocus(focusedTile === tile ? null : tile);
  });

  tile.append(video, caption, max);

  // Atalho no tile da tela de outra pessoa para o painel de volume dela.
  if (kind === "screen" && owner !== "local") {
    const vol = document.createElement("button");
    vol.type = "button";
    vol.className = "vol";
    vol.textContent = "🔊";
    vol.title = "Volume desta tela";
    vol.addEventListener("click", (event) => {
      event.stopPropagation();
      openVolumePanel(Number(owner));
    });
    tile.append(vol);
  }

  tile.addEventListener("dblclick", () => void video.requestFullscreen?.());
  (kind === "screen" ? stage : strip).append(tile);
  refreshLayout();
  return { tile, video };
}

function applyLayout(value: string): void {
  const layout = value === "grid" ? "grid" : "stage";
  layoutSelect.value = layout;
  videos.dataset.layout = layout;
  try {
    localStorage.setItem("pecscord-layout", layout);
  } catch {
    // armazenamento indisponível (ex.: janela privada); a preferência vale só nesta sessão
  }
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
    for (const track of localStream.getAudioTracks()) peer.senders.mic = pc.addTrack(track, localStream);
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
      attachRemoteAudio(peerId, event.track, kind === "screen" ? "screen" : "mic");
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
  dropPeerAudio(peerId);
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
  if (key === "screenAudio" || key === "mic") return;

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
    audio: {
      // Sem processamento de voz, para música e jogos soarem como são.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Tira da captura do sistema o que esta aba toca (as vozes dos outros participantes).
      // Sem isso, quem assiste ouve a própria voz de volta pela tela. Chromium 134+.
      restrictOwnAudio: true,
    } as MediaTrackConstraints,
    systemAudio: "include", // Chromium: oferece a opção de incluir o áudio do sistema
    selfBrowserSurface: "exclude", // não lista a própria aba do Pecscord
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const video = stream.getVideoTracks()[0];
  video.contentHint = "motion"; // prioriza fluidez sobre nitidez em conteúdo que se move

  const audio = stream.getAudioTracks()[0];
  if (audio && (audio.getSettings() as Record<string, unknown>).restrictOwnAudio !== true) {
    addLine(
      "Seu navegador não separa o áudio do Pecscord da captura do sistema: quem assiste pode ouvir a própria voz pela sua tela.",
      "error",
    );
  }
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

// ---- microfone: mudo e supressão de ruído ----------------------------------------

function micTrack(): MediaStreamTrack | null {
  return localStream?.getAudioTracks()[0] ?? null;
}

function setMicEnabled(enabled: boolean): void {
  const track = micTrack();
  if (!track) return;
  track.enabled = enabled;
  muteButton.textContent = enabled ? "Mutar" : "Desmutar";
  muteButton.classList.toggle("active", !enabled);
}

// Processamento de voz do próprio navegador. Eco e ganho automático ficam sempre
// ligados; a supressão de ruído é opcional porque pode "comer" música ou vozes baixas.
function micConstraints(): MediaTrackConstraints {
  return { echoCancellation: true, autoGainControl: true, noiseSuppression: noiseCheckbox.checked };
}

// Pega o microfone de novo com a nova configuração e troca a faixa em todas as
// conexões, sem renegociar. No Chromium, applyConstraints não mexe no processamento
// de voz e uma nova captura reaproveita a que já está aberta; por isso a faixa antiga
// é fechada antes do pedido. A voz some por uma fração de segundo.
async function applyNoiseSuppression(): Promise<void> {
  const track = micTrack();
  if (!track) return;
  const wanted = noiseCheckbox.checked;
  if (track.getSettings().noiseSuppression === wanted) return;

  const wasEnabled = track.enabled;
  track.stop();
  const fresh = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  const next = fresh.getAudioTracks()[0];
  next.enabled = wasEnabled;
  localStream = fresh;
  for (const peer of peers.values()) await peer.senders.mic?.replaceTrack(next);
  addLine(wanted ? "Supressão de ruído ligada." : "Supressão de ruído desligada.", "system");
}

function loadAudioOptions(): void {
  try {
    noiseCheckbox.checked = localStorage.getItem("pecscord-noise") !== "off";
  } catch {
    // sem localStorage (modo privado etc.): fica nos padrões do HTML
  }
}

function saveAudioOptions(): void {
  try {
    localStorage.setItem("pecscord-noise", noiseCheckbox.checked ? "on" : "off");
  } catch {
    // ignorado
  }
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
        loadVolumes(p.id, p.name);
        createPeer(p.id, true);
      }
      renderParticipants();
      addLine(`Você entrou na sala com ${msg.peers.length} outra(s) pessoa(s).`, "system");
      break;
    case "peer_joined":
      names.set(msg.peer.id, msg.peer.name);
      loadVolumes(msg.peer.id, msg.peer.name);
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
  closeVolumePanel();
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

  ensureAudioCtx(); // criado aqui, dentro do clique, para o navegador permitir reproduzir áudio

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
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
  const track = micTrack();
  if (!track) return;
  setMicEnabled(!track.enabled);
});

noiseCheckbox.addEventListener("change", () => {
  saveAudioOptions();
  applyNoiseSuppression().catch((err) => addLine(`Não foi possível mudar a supressão de ruído: ${err}`, "error"));
});
loadAudioOptions();

// ---- tema -------------------------------------------------------------------
// Só estética: o tema vai em data-theme no <html> e o CSS troca as variáveis.
// O <script> inline no index.html aplica o salvo antes da primeira pintura.

const THEMES = ["default", "vaporwave"] as const;
type Theme = (typeof THEMES)[number];
const themeSelects = [...document.querySelectorAll<HTMLSelectElement>("[data-theme-select]")];

function applyTheme(theme: string): void {
  const chosen: Theme = (THEMES as readonly string[]).includes(theme) ? (theme as Theme) : "default";
  if (chosen === "default") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = chosen;
  for (const sel of themeSelects) sel.value = chosen;
  try {
    localStorage.setItem("pecscord-theme", chosen);
  } catch {
    // ignorado
  }
}

for (const sel of themeSelects) sel.addEventListener("change", () => applyTheme(sel.value));
try {
  applyTheme(localStorage.getItem("pecscord-theme") ?? "default");
} catch {
  applyTheme("default");
}

cameraButton.addEventListener("click", () => void toggleLocal("camera"));
screenButton.addEventListener("click", () => void toggleLocal("screen"));
screenQuality.addEventListener("change", () => void applyScreenPreset());
leaveButton.addEventListener("click", () => ws?.close());
layoutSelect.addEventListener("change", () => applyLayout(layoutSelect.value));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && focusedTile) setFocus(null);
});

try {
  applyLayout(localStorage.getItem("pecscord-layout") ?? "stage");
} catch {
  applyLayout("stage");
}

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
    __pecscordDebug?: {
      screenSettings: () => MediaTrackSettings | null;
      screenAudioSettings: () => MediaTrackSettings | null;
      micSettings: () => MediaTrackSettings | null;
      micEnabled: () => boolean | null;
      gainOf: (peerId: number, channel: AudioChannel) => number;
    };
  }
}
window.__pecscordDebug = {
  screenSettings: () => localTracks.screen?.getSettings() ?? null,
  screenAudioSettings: () => localTracks.screenAudio?.getSettings() ?? null,
  micSettings: () => micTrack()?.getSettings() ?? null,
  micEnabled: () => micTrack()?.enabled ?? null,
  gainOf: (peerId, channel) => effectiveGain(peerId, channel),
};
