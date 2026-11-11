// Сравнение вариантов расчёта: node tools/bench.mjs [варианты через запятую] [фото через запятую]
//   node tools/bench.mjs chain,free           — все фото, два варианта
//   node tools/bench.mjs free koch            — один вариант на одном фото
// Вариант — набор параметров адреса (#algo=free&...), см. VARIANTS. Фото — _test/*.jpg (не в репозитории,
// см. .gitignore) и встроенный Вермеер. Картинки и сводка — в _bench/. Только встроенное в Node, без пакетов.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "_bench");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VARIANTS = {
  chain: "algo=chain&ai=0",                // старый расчёт: одна нить от гвоздя к гвоздю, лицо по цвету кожи
  free: "algo=free&ai=0",                  // лучшая линия среди всех пар гвоздей
  freesum: "algo=free&ai=0&norm=sum",      // то же, но выигрыш линии не делится на её длину
  ai: "algo=free&ai=1",                    // + лицо и черты по нейросети (так сейчас на сайте)
  aibg: "algo=free&ai=1&bgcut=cut",        // + фон убран
  // опыты с глазами: вес черт лица (fe, было 12), цена «ластика» на лице (pe, было 8), резкость фото (sharp, было 1)
  fe6: "algo=free&ai=1&fe=6",
  fe24: "algo=free&ai=1&fe=24",
  pe20: "algo=free&ai=1&pe=20",
  sharp0: "algo=free&ai=1&sharp=0.0001",
  sharp05: "algo=free&ai=1&sharp=0.5",
  // «ластик» — нить цвета фона поверх уже натянутых: делает нити мутными. eg — множитель его выигрыша (было 1)
  eg05: "algo=free&ai=1&eg=0.5",
  eg02: "algo=free&ai=1&eg=0.2",
  eg0: "algo=free&ai=1&eg=0",
  // остановка: расчёт заканчивается, когда лучшая нить даёт меньше этой доли выигрыша самых сильных нитей
  eg0s3: "algo=free&ai=1&eg=0&stop=0.03",
  eg0s6: "algo=free&ai=1&eg=0&stop=0.06",
};
// кадр (zoom/ox/oy) подобран вручную под лицо
const PHOTOS = {
  vermeer: "",
  koch: "img=_test/koch.jpg&zoom=230&ox=16&oy=-60&threads=color-dark",
  jemison: "img=_test/jemison.jpg&zoom=200&ox=16&oy=-50&threads=color-dark",
  lincoln: "img=_test/lincoln.jpg&zoom=105&ox=0&oy=-5&threads=mono-dark",
};
const pick = (arg, all) => (arg ? arg.split(",") : Object.keys(all)).filter((k) => k in all || console.error("нет такого: " + k));
const variants = pick(process.argv[2], VARIANTS), photos = pick(process.argv[3], PHOTOS);
const common = process.env.BENCH_COMMON || "frame=1x1";   // общие параметры для всех запусков

const CHROME = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => p && fs.existsSync(p));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
  if (!target.startsWith(ROOT) || !fs.existsSync(target)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// BENCH_PAGE — замороженная копия страницы (например _snap.html), чтобы правки во время прогона не мешали
const base = `http://127.0.0.1:${server.address().port}/${process.env.BENCH_PAGE || "index.html"}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "threads-bench-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--window-size=1200,1200", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error("Chrome не ответил")), 20000);
});
const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map(), errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (pending.has(d.id)) { pending.get(d.id)(d.result ?? {}); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push("EXC " + d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const savePng = (name, dataUrl) => fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(dataUrl.split(",")[1], "base64"));

fs.mkdirSync(OUT, { recursive: true });
await send("Runtime.enable");
const rows = [];
for (const ph of photos) for (const v of variants) {
  const hash = [`test=1&hide=1&${common}`, PHOTOS[ph], VARIANTS[v]].filter(Boolean).join("&");
  errors.length = 0;
  await send("Page.navigate", { url: `${base}?r=${Date.now()}#${hash}` });
  const t0 = Date.now();
  let res = null;
  while (!res && Date.now() - t0 < 15 * 60000 && !errors.some((e) => e.startsWith("EXC "))) { await sleep(1000); res = await run("window.BENCH || null"); }
  if (!res) { console.log(`${ph}/${v}: ошибка ${errors[0] || "не дождался"}`); continue; }
  savePng(`${ph}-${v}`, await run("document.getElementById('c').toDataURL('image/png')"));
  if (!fs.existsSync(path.join(OUT, `${ph}-photo.png`))) savePng(`${ph}-photo`, await run(`(() => {
    const c = document.createElement('canvas'); c.width = c.height = R; const g = c.getContext('2d'), im = g.createImageData(R, R);
    for (let i = 0; i < R * R; i++) { for (let ch = 0; ch < 3; ch++) im.data[i * 4 + ch] = T0[i * 3 + ch] * 255; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0); return c.toDataURL('image/png'); })()`));
  const row = { photo: ph, variant: v, ai: res.ai, erase: res.erase, lines: res.lines, sec: res.sec, ...Object.fromEntries(Object.entries(res.view).map(([k, x]) => ["v_" + k, x])), m_faceSsim: res.model.faceSsim, m_eye: res.model.eye };
  rows.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(OUT, `results-${Date.now()}.json`), JSON.stringify(rows, null, 1));
console.table(rows);
ws.close(); chrome.kill(); server.close();
