// Teste de ponta a ponta: compila o cliente, sobe o servidor, abre duas páginas
// no mesmo navegador (câmera e microfone falsos) e verifica chat, voz, câmera e tela.
//
// Uso: npm test (dentro de tests/). Requer Edge ou Chrome instalado.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Porta e pasta de build próprias, para não colidir com um `cargo run` em andamento.
const PORT = Number(process.env.PECSCORD_TEST_PORT ?? 3100);
const TARGET_DIR = path.join(ROOT, "server", "target", "e2e");
const URL = `http://localhost:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
];

const failures = [];
function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} falhou`);
}

// Chama o npm pelo próprio Node, evitando o shell (e o aviso de segurança do Node no Windows).
function npm(args, cwd) {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  run(process.execPath, [cli, ...args], cwd);
}

function cargoPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const local = path.join(home, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  return existsSync(local) ? local : "cargo";
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error(`servidor não respondeu na porta ${port}`);
}

// --- preparação -------------------------------------------------------------

console.log("> build do cliente");
npm(["run", "build"], path.join(ROOT, "client"));

console.log("> build do servidor");
run(cargoPath(), ["build", "--quiet", "--target-dir", TARGET_DIR], path.join(ROOT, "server"));

const serverExe = path.join(TARGET_DIR, "debug", process.platform === "win32" ? "pecscord-server.exe" : "pecscord-server");
const server = spawn(serverExe, [], { stdio: "ignore", env: { ...process.env, PORT: String(PORT) } });
await waitForPort(PORT, 15000);

const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) throw new Error("nenhum navegador Chromium encontrado");

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({ permissions: ["camera", "microphone"] });

async function openPage(name, room) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [${name} pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") console.log(`  [${name} console] ${m.text()}`); });
  await page.goto(URL);
  await page.fill("#room", room);
  await page.fill("#name", name);
  await page.click("#join-form button[type=submit]");
  await page.waitForSelector("#room-view:not([hidden])");
  return page;
}

// Tiles de vídeo remotos de um tipo, com estado visível e largura decodificada.
async function remoteTiles(page, kind) {
  return page.evaluate((kind) =>
    [...document.querySelectorAll(`.tile[data-kind="${kind}"]`)]
      .filter((t) => t.dataset.peer !== "local")
      .map((t) => ({ hidden: t.hidden, width: t.querySelector("video").videoWidth })),
  kind);
}

async function lastMessage(page) {
  return page.$eval("#messages li:last-child", (e) => e.textContent);
}

try {
  const room = `t-${Date.now()}`;
  const a = await openPage("Ana", room);
  const b = await openPage("Bruno", room);
  await sleep(2500);

  console.log("\n# chat");
  await b.fill("#text", "oi Ana");
  await b.press("#text", "Enter");
  await sleep(500);
  check((await lastMessage(a)) === "Bruno: oi Ana", "mensagem de Bruno chega a Ana");

  console.log("\n# participantes");
  const people = await a.$$eval("#participants li", (els) => els.map((e) => e.textContent));
  check(people.some((p) => p.includes("Bruno")), "Ana vê Bruno na lista de pessoas");

  console.log("\n# voz");
  const audioCount = await b.$$eval("#audio audio", (els) => els.length);
  check(audioCount >= 1, "Bruno recebe a faixa de áudio de Ana");

  console.log("\n# volume por pessoa: voz e tela separados");
  await b.click('#participants li[data-peer="1"]');
  check(await b.$eval("#volume-panel", (e) => !e.hidden), "painel abre ao clicar em Ana");
  check((await b.textContent("#volume-name")) === "Ana", "painel mostra o nome de Ana");
  const setRange = (page, sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  await setRange(b, "#volume-mic", "50");
  check((await b.evaluate(() => window.__pecscordDebug.gainOf(1, "mic"))) === 0.5, "voz de Ana a 50%");
  check((await b.textContent('#participants li[data-peer="1"]')).includes("50%"), "chip de Ana mostra 50%");
  await b.click("#volume-mic-mute");
  check((await b.evaluate(() => window.__pecscordDebug.gainOf(1, "mic"))) === 0, "voz de Ana mutada");
  await b.click("#volume-mic-mute");
  check((await b.evaluate(() => window.__pecscordDebug.gainOf(1, "mic"))) === 0.5, "voz de Ana volta a 50%");
  await setRange(b, "#volume-screen", "150");
  check((await b.evaluate(() => window.__pecscordDebug.gainOf(1, "screen"))) === 1.5, "tela de Ana a 150%");
  check((await b.evaluate(() => window.__pecscordDebug.gainOf(1, "mic"))) === 0.5, "voz de Ana não muda com a tela");
  check((await b.evaluate(() => window.__pecscordDebug.gainOf(2, "mic"))) === 1, "volume de outras pessoas não muda");
  await b.click("#volume-close");
  check(await b.$eval("#volume-panel", (e) => e.hidden), "painel fecha");

  console.log("\n# câmera: os dois ligam ao mesmo tempo");
  await Promise.all([a.click("#camera"), b.click("#camera")]);
  await sleep(6000);
  let seen = await remoteTiles(a, "camera");
  check(seen.length === 1 && !seen[0].hidden && seen[0].width > 0, "Ana vê a câmera de Bruno");
  seen = await remoteTiles(b, "camera");
  check(seen.length === 1 && !seen[0].hidden && seen[0].width > 0, "Bruno vê a câmera de Ana");

  console.log("\n# câmera: Ana desliga");
  await a.click("#camera");
  await sleep(2500);
  seen = await remoteTiles(b, "camera");
  check(seen.length === 1 && seen[0].hidden, "tile de Ana some para Bruno");

  console.log("\n# câmera: Ana religa");
  await a.click("#camera");
  await sleep(6000);
  seen = await remoteTiles(b, "camera");
  check(seen.length === 1 && !seen[0].hidden && seen[0].width > 0, "tile de Ana volta para Bruno");

  console.log("\n# tema");
  const accentOf = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  const defaultAccent = await accentOf(a);
  await a.selectOption("#theme-room", "vaporwave");
  check((await a.evaluate(() => document.documentElement.dataset.theme)) === "vaporwave", "tema vaporwave aplicado no <html>");
  check((await accentOf(a)) !== defaultAccent, "cor de destaque muda com o tema");
  check((await a.evaluate(() => localStorage.getItem("pecscord-theme"))) === "vaporwave", "tema é lembrado");
  check((await a.$eval("#theme-join", (e) => e.value)) === "vaporwave", "seletor da tela de entrada acompanha");
  await a.selectOption("#theme-room", "default");
  check((await a.evaluate(() => document.documentElement.dataset.theme)) === undefined, "voltar ao padrão limpa o data-theme");
  check((await accentOf(a)) === defaultAccent, "cor de destaque volta ao padrão");

  console.log("\n# microfone: supressão de ruído");
  check(await a.$eval("#noise-suppression", (e) => e.checked), "supressão de ruído vem ligada por padrão");
  check((await a.evaluate(() => window.__pecscordDebug.micSettings()?.noiseSuppression)) === true, "faixa do microfone nasce com supressão");
  await a.uncheck("#noise-suppression");
  await sleep(1500);
  check((await a.evaluate(() => window.__pecscordDebug.micSettings()?.noiseSuppression)) === false, "desligar a opção tira a supressão da faixa");
  check((await a.evaluate(() => window.__pecscordDebug.micEnabled())) === true, "microfone continua ativo após a troca");
  await a.check("#noise-suppression");
  await sleep(1500);
  check((await a.evaluate(() => window.__pecscordDebug.micSettings()?.noiseSuppression)) === true, "religar a opção devolve a supressão");
  check((await a.evaluate(() => localStorage.getItem("pecscord-noise"))) === "on", "preferência de supressão é lembrada");

  console.log("\n# tela: Ana compartilha em 1080p60");
  await a.selectOption("#screen-quality", "1080p60");
  await a.click("#screen");
  await sleep(6000);
  seen = await remoteTiles(b, "screen");
  check(seen.length === 1 && !seen[0].hidden && seen[0].width > 0, "Bruno vê a tela de Ana");
  check((await a.textContent("#screen")).includes("Parar"), "botão de Ana indica compartilhamento ativo");
  check((await a.evaluate(() => window.__pecscordDebug.micEnabled())) === true, "microfone de Ana continua ativo ao compartilhar");
  const screenAudio = await a.evaluate(() => window.__pecscordDebug.screenAudioSettings());
  check(screenAudio !== null && screenAudio.restrictOwnAudio === true, "áudio do sistema exclui o que a aba do Pecscord toca (restrictOwnAudio)");
  check(await a.$$eval("#messages li.error", (els) => els.length === 0), "nenhum aviso de eco no chat de Ana");
  const stageVisible = await b.$eval("#stage", (e) => !e.hidden);
  check(stageVisible, "palco de tela visível para Bruno");
  await b.click('.tile[data-peer="1"][data-kind="screen"] .vol');
  check(await b.$eval("#volume-panel", (e) => !e.hidden && document.getElementById("volume-name").textContent === "Ana"), "botão 🔊 do tile abre o painel de Ana");
  check((await b.$eval("#volume-screen", (e) => e.value)) === "150", "slider da tela lembra os 150%");
  await b.click("#volume-close");

  console.log("\n# maximizar e modo grade");
  await b.click('.tile[data-peer="1"][data-kind="screen"] .max');
  check(await b.$eval("#videos", (e) => e.classList.contains("focus")), "Bruno maximiza a tela de Ana");
  let visible = await b.$$eval(".tile", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
  check(visible === 1, `só o tile maximizado fica visível (${visible})`);
  await b.keyboard.press("Escape");
  check(await b.$eval("#videos", (e) => !e.classList.contains("focus")), "Esc restaura o layout");
  visible = await b.$$eval(".tile", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
  check(visible === 3, `todos os tiles voltam (${visible})`);
  await b.selectOption("#layout", "grid");
  check(await b.$eval("#videos", (e) => e.dataset.layout === "grid"), "modo grade ativado");
  check(await b.$eval("#stage", (e) => getComputedStyle(e).display === "contents"), "grade junta palco e faixa");
  await b.selectOption("#layout", "stage");
  await b.click('.tile[data-peer="1"][data-kind="screen"] .max'); // fica maximizado até Ana parar

  console.log("\n# tela: Ana troca para 720p30 durante a transmissão");
  await a.selectOption("#screen-quality", "720p30");
  await sleep(3000);
  const settings = await a.evaluate(() => window.__pecscordDebug?.screenSettings() ?? null);
  check(settings !== null && settings.frameRate <= 30, `taxa de quadros reduzida (${settings?.frameRate ?? "?"} fps)`);

  console.log("\n# tela: Ana para");
  await a.click("#screen");
  await sleep(2500);
  seen = await remoteTiles(b, "screen");
  check(seen.length === 1 && seen[0].hidden, "tile de tela de Ana some para Bruno");
  check(await b.$eval("#stage", (e) => e.hidden), "palco de tela escondido para Bruno");
  check(await b.$eval("#videos", (e) => !e.classList.contains("focus")), "maximização sai sozinha quando a tela para");

  console.log("\n# terceira pessoa entra com câmeras já ligadas");
  const c = await openPage("Carla", room);
  await sleep(6000);
  seen = await remoteTiles(c, "camera");
  check(seen.length === 2 && seen.every((t) => !t.hidden && t.width > 0), "Carla vê as câmeras de Ana e Bruno ao entrar");

  console.log("\n# terceira pessoa liga a câmera");
  await c.click("#camera");
  await sleep(6000);
  seen = await remoteTiles(a, "camera");
  check(seen.length === 2 && seen.every((t) => !t.hidden && t.width > 0), "Ana vê as câmeras de Bruno e Carla");
  seen = await remoteTiles(b, "camera");
  check(seen.length === 2 && seen.every((t) => !t.hidden && t.width > 0), "Bruno vê as câmeras de Ana e Carla");

  console.log("\n# saída");
  await a.click("#leave");
  await sleep(1500);
  check((await lastMessage(b)).includes("Ana saiu"), "Bruno vê a saída de Ana");
  check(await a.$eval("#join", (e) => !e.hidden), "Ana volta à tela de entrada");
} finally {
  await browser.close();
  server.kill();
}

console.log(failures.length === 0 ? "\nTodos os testes passaram." : `\n${failures.length} falha(s).`);
process.exit(failures.length === 0 ? 0 : 1);
