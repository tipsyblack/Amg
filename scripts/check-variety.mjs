// Замер разнообразия картинок: одинаковые ли кадры в ролике.
//
// Использование:
//   node scripts/check-variety.mjs public/images     — по готовым картинкам
//   node scripts/check-variety.mjs out/video.mp4     — по собранному ролику
//
// Зачем этот файл лежит в репозитории. «Кажется, что все сцены похожи» —
// ощущение, и спорить о нём бесполезно. Этот замер переводит его в числа, и
// именно он показал, где на самом деле была беда: не в композиции (центр
// тяжести кадра у нас и у референса совпал с точностью до 0.01), а в том, что
// 12 картинок из 15 оказались одного цвета.
//
// Числа референса ниже — из присланного ролика другой студии. Мы не берём
// оттуда ни кадров, ни текста: это просто планка, по которой видно, достаточно
// ли у нас разнообразия.

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const W = 16;
const H = 16;
const PX = W * H;
const FRAME = PX * 3;

// Где в кадре ролика лежит карточка с иллюстрацией. Должно совпадать с
// src/remotion/layout.ts — если поменяется вёрстка, замер поедет.
const CARD_WIDTH_PERCENT = 75.4;
const CARD_TOP_PERCENT = 10.9;
const CARD_ASPECT = 0.757;

// Планка. Слева — что намерили у референса, справа — что было у нас до
// художественного задания сцен (sceneLook.ts).
const TARGETS = [
  { key: "sector", title: "доля самого частого сектора тона", limit: 0.6, cmp: "max", ref: "47%", was: "80%", fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "hue", title: "разброс тона", limit: 60, cmp: "min", ref: "73°", was: "58°", fmt: (v) => `${v.toFixed(0)}°` },
  { key: "light", title: "разброс светлоты", limit: 0.1, cmp: "min", ref: "0.13", was: "0.09", fmt: (v) => v.toFixed(2) },
  { key: "fill", title: "разброс заполненности", limit: 0.15, cmp: "min", ref: "0.19", was: "0.12", fmt: (v) => v.toFixed(2) },
];

async function rawFromVideo(file) {
  const { stdout: probe } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]);
  const [width, height] = probe.trim().split(",").map(Number);
  const cardW = Math.round((width * CARD_WIDTH_PERCENT) / 100);
  const cardH = Math.round(cardW / CARD_ASPECT);
  const x = Math.round((width - cardW) / 2);
  const y = Math.round((height * CARD_TOP_PERCENT) / 100);

  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", file,
      "-vf", `fps=4,crop=${cardW}:${Math.min(cardH, height - y)}:${x}:${y},scale=${W}:${H}`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );

  const frames = [];
  for (let i = 0; i < stdout.length / FRAME; i++) {
    frames.push(stdout.subarray(i * FRAME, (i + 1) * FRAME));
  }
  // Подряд идущие похожие кадры — одна картинка. Короткие куски выбрасываем:
  // это переход, а не иллюстрация.
  const cuts = [0];
  for (let i = 1; i < frames.length; i++) {
    if (frameDiff(frames[i - 1], frames[i]) > 0.06) cuts.push(i);
  }
  cuts.push(frames.length);
  const reps = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    if (cuts[k + 1] - cuts[k] < 3) continue;
    reps.push(frames[Math.floor((cuts[k] + cuts[k + 1] - 1) / 2)]);
  }
  return reps;
}

async function rawFromDir(dir) {
  const files = readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", path.join(dir, f),
        "-vf", `scale=${W}:${H}`, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ],
      { encoding: "buffer" },
    );
    out.push({ name: f, data: stdout.subarray(0, FRAME) });
  }
  return out;
}

function frameDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < FRAME; i++) sum += Math.abs(a[i] - b[i]);
  return sum / FRAME / 255;
}

/** Тон, насыщенность, светлота и заполненность одной картинки. */
function stats(f) {
  let x = 0;
  let y = 0;
  let lumSum = 0;
  let dark = 0;
  for (let p = 0; p < PX; p++) {
    const r = f[p * 3] / 255;
    const g = f[p * 3 + 1] / 255;
    const b = f[p * 3 + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    lumSum += lum;
    if (lum < 0.78) dark++;
    const sat = max === 0 ? 0 : (max - min) / max;
    // Серые пиксели тон не задают — иначе фон размывал бы любой оттенок.
    if (sat < 0.12 || max === min) continue;
    let h;
    if (max === r) h = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h *= 60;
    x += Math.cos((h * Math.PI) / 180) * sat;
    y += Math.sin((h * Math.PI) / 180) * sat;
  }
  return {
    hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
    lum: lumSum / PX,
    fill: dark / PX,
  };
}

const sd = (v) => {
  const m = v.reduce((a, x) => a + x, 0) / v.length;
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
};

/** Разброс тона считаем по кругу: 350° и 10° рядом, а не на 340° врозь. */
function hueSpread(hues) {
  const x = hues.reduce((a, h) => a + Math.cos((h * Math.PI) / 180), 0) / hues.length;
  const y = hues.reduce((a, h) => a + Math.sin((h * Math.PI) / 180), 0) / hues.length;
  return (Math.sqrt(-2 * Math.log(Math.max(Math.hypot(x, y), 1e-6))) * 180) / Math.PI;
}

const target = process.argv[2] ?? "public/images";
if (!statSync(target, { throwIfNoEntry: false })) {
  console.error(`Нечего замерять: ${target} не найден`);
  process.exit(2);
}

const isDir = statSync(target).isDirectory();
const items = isDir
  ? await rawFromDir(target)
  : (await rawFromVideo(target)).map((data, i) => ({ name: `кадр ${i + 1}`, data }));

if (items.length < 2) {
  console.error(`Картинок слишком мало (${items.length}) — замерять нечего`);
  process.exit(2);
}

const st = items.map((it) => stats(it.data));
console.log(`Картинок: ${items.length}\n`);
console.log("что                     тон    светлота  занято");
items.forEach((it, i) => {
  console.log(
    `${it.name.padEnd(22).slice(0, 22)} ${String(Math.round(st[i].hue)).padStart(4)}°  ` +
      `${st[i].lum.toFixed(2).padStart(7)}  ${(st[i].fill * 100).toFixed(0).padStart(5)}%`,
  );
});

const hues = st.map((s) => s.hue);
const bins = new Map();
for (const h of hues) {
  const k = Math.floor(h / 60);
  bins.set(k, (bins.get(k) ?? 0) + 1);
}
const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
const measured = {
  sector: top[1] / hues.length,
  hue: hueSpread(hues),
  light: sd(st.map((s) => s.lum)),
  fill: sd(st.map((s) => s.fill)),
};

console.log(
  `\n       ${"показатель".padEnd(32)}${"замер".padStart(6)}${"планка".padStart(9)}` +
    `${"референс".padStart(10)}${"было".padStart(8)}`,
);
let bad = 0;
for (const t of TARGETS) {
  const value = measured[t.key];
  const ok = t.cmp === "max" ? value <= t.limit : value >= t.limit;
  if (!ok) bad++;
  const limit = `${t.cmp === "max" ? "≤" : "≥"} ${t.fmt(t.limit)}`;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${t.title.padEnd(32)}${t.fmt(value).padStart(6)}` +
      `${limit.padStart(9)}${t.ref.padStart(10)}${t.was.padStart(8)}`,
  );
}
console.log(
  `\nсамый частый сектор тона: ${top[0] * 60}°–${top[0] * 60 + 60}°, ` +
    `в нём ${top[1]} из ${hues.length}`,
);
console.log(
  bad === 0
    ? "\nРазнообразия хватает\n"
    : `\nОднообразно по ${bad} показателям — картинки ролика похожи друг на друга\n`,
);
process.exit(bad === 0 ? 0 : 1);
