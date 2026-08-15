/**
 * Замер разнообразия картинок: одинаковые ли кадры в ролике.
 *
 * «Кажется, что все сцены похожи» — ощущение, и спорить о нём бесполезно.
 * Здесь оно переводится в числа. Именно этот замер показал, что дело было не в
 * композиции (центр тяжести кадра у нас и у референса совпал с точностью до
 * 0.01), а в том, что 12 картинок из 15 вышли одного цвета.
 *
 * Планка взята с присланного референса. Мы не берём оттуда ни кадров, ни
 * текста — только числа, по которым видно, достаточно ли у нас разнообразия.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Картинку сжимаем до 16x16: нас интересуют цвет и плотность, а не детали.
const W = 16;
const H = 16;
const PX = W * H;
const FRAME = PX * 3;

// Где в кадре ролика лежит карточка с иллюстрацией. Должно совпадать с
// src/remotion/layout.ts: поедет вёрстка — поедет и замер.
const CARD_WIDTH_PERCENT = 75.4;
const CARD_TOP_PERCENT = 10.9;
const CARD_ASPECT = 0.757;

export interface VarietyTarget {
  key: "sector" | "hue" | "light" | "fill";
  title: string;
  limit: number;
  /** max — «не больше», min — «не меньше». */
  cmp: "max" | "min";
  /** Что намерено у референса и что было у нас до художественного задания. */
  ref: string;
  was: string;
  format: (value: number) => string;
}

export const VARIETY_TARGETS: VarietyTarget[] = [
  {
    key: "sector",
    title: "картинок в одном тоне",
    limit: 0.6,
    cmp: "max",
    ref: "47%",
    was: "80%",
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "hue",
    title: "разброс тона",
    limit: 60,
    cmp: "min",
    ref: "73°",
    was: "58°",
    format: (v) => `${v.toFixed(0)}°`,
  },
  {
    key: "light",
    title: "разброс светлоты",
    limit: 0.1,
    cmp: "min",
    ref: "0.13",
    was: "0.09",
    format: (v) => v.toFixed(2),
  },
  {
    key: "fill",
    title: "разброс заполненности",
    limit: 0.15,
    cmp: "min",
    ref: "0.19",
    was: "0.12",
    format: (v) => v.toFixed(2),
  },
];

export interface ImageStats {
  name: string;
  /** Тон в градусах: 30-45° — песочный беж, 200-220° — сине-стальной. */
  hue: number;
  lum: number;
  fill: number;
}

export interface VarietyReport {
  images: ImageStats[];
  measured: Record<VarietyTarget["key"], number>;
  /** Какие показатели не дотянули. Пусто — разнообразия хватает. */
  failed: VarietyTarget[];
  /** Самый частый сектор тона: с какого градуса и сколько картинок в нём. */
  topSector: { from: number; count: number };
}

/** Тон, светлота и заполненность одной картинки. */
export function imageStats(name: string, f: Buffer | Uint8Array): ImageStats {
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
    // Тёмное — это контур и предметы. По их доле видно, забит кадр или пуст.
    if (lum < 0.78) dark++;
    const sat = max === 0 ? 0 : (max - min) / max;
    // Серые пиксели тон не задают, иначе фон размывал бы любой оттенок.
    if (sat < 0.12 || max === min) continue;
    let h: number;
    if (max === r) h = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h *= 60;
    x += Math.cos((h * Math.PI) / 180) * sat;
    y += Math.sin((h * Math.PI) / 180) * sat;
  }
  return {
    name,
    hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
    lum: lumSum / PX,
    fill: dark / PX,
  };
}

/** Разброс тона по кругу: 350° и 10° рядом, а не на 340° врозь. */
export function hueSpread(hues: number[]): number {
  if (hues.length === 0) return 0;
  const x = hues.reduce((a, h) => a + Math.cos((h * Math.PI) / 180), 0) / hues.length;
  const y = hues.reduce((a, h) => a + Math.sin((h * Math.PI) / 180), 0) / hues.length;
  return (Math.sqrt(-2 * Math.log(Math.max(Math.hypot(x, y), 1e-6))) * 180) / Math.PI;
}

function deviation(values: number[]): number {
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}

export function varietyReport(images: ImageStats[]): VarietyReport {
  const hues = images.map((s) => s.hue);
  // Сектор — 60°: примерно столько занимает один узнаваемый цвет.
  const bins = new Map<number, number>();
  for (const h of hues) {
    const k = Math.floor(h / 60);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  const [sector, count] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];

  const measured = {
    sector: count / images.length,
    hue: hueSpread(hues),
    light: deviation(images.map((s) => s.lum)),
    fill: deviation(images.map((s) => s.fill)),
  };
  const failed = VARIETY_TARGETS.filter((t) =>
    t.cmp === "max" ? measured[t.key] > t.limit : measured[t.key] < t.limit,
  );
  return { images, measured, failed, topSector: { from: sector * 60, count } };
}

/**
 * Замер по папке с картинками — до того, как ролик собран.
 *
 * @param only имена файлов этого ролика. Папка не чистится между роликами, а
 *   имена в ней постоянные (scene-0.png и так далее), поэтому от предыдущего
 *   ролика остаются лишние картинки, если в нём было больше сцен. В замер они
 *   попадать не должны.
 */
export async function measureImages(
  dir: string,
  only?: string[],
): Promise<ImageStats[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  if (only) {
    const wanted = new Set(only);
    files = files.filter((f) => wanted.has(f));
  }
  const out: ImageStats[] = [];
  for (const file of files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()) {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", path.join(dir, file),
        "-vf", `scale=${W}:${H}`, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ],
      { encoding: "buffer" },
    );
    if (stdout.length >= FRAME) out.push(imageStats(file, stdout.subarray(0, FRAME)));
  }
  return out;
}

/**
 * Замер по собранному ролику: вырезаем область карточки и делим на картинки
 * там, где кадр меняется скачком.
 */
export async function measureVideo(file: string): Promise<ImageStats[]> {
  const { stdout: probe } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]);
  const [width, height] = probe.trim().split(",").map(Number);
  const cardW = Math.round((width * CARD_WIDTH_PERCENT) / 100);
  const cardH = Math.round(cardW / CARD_ASPECT);
  const top = Math.round((height * CARD_TOP_PERCENT) / 100);

  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", file,
      "-vf",
      `fps=4,crop=${cardW}:${Math.min(cardH, height - top)}:` +
        `${Math.round((width - cardW) / 2)}:${top},scale=${W}:${H}`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );

  const frames: Buffer[] = [];
  for (let i = 0; i < Math.floor(stdout.length / FRAME); i++) {
    frames.push(stdout.subarray(i * FRAME, (i + 1) * FRAME));
  }
  const diff = (a: Buffer, b: Buffer) => {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += Math.abs(a[i] - b[i]);
    return sum / FRAME / 255;
  };
  const cuts = [0];
  for (let i = 1; i < frames.length; i++) {
    if (diff(frames[i - 1], frames[i]) > 0.06) cuts.push(i);
  }
  cuts.push(frames.length);

  const out: ImageStats[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    // Короткий кусок — это переход, а не иллюстрация.
    if (cuts[k + 1] - cuts[k] < 3) continue;
    const middle = frames[Math.floor((cuts[k] + cuts[k + 1] - 1) / 2)];
    out.push(imageStats(`кадр ${out.length + 1}`, middle));
  }
  return out;
}

/** Итог замера для чата: коротко и с числами. */
export function varietyLines(report: VarietyReport): string[] {
  const lines = VARIETY_TARGETS.map((t) => {
    const value = report.measured[t.key];
    const ok = !report.failed.includes(t);
    return (
      `${ok ? "✅" : "⚠️"} ${t.title}: ${t.format(value)} ` +
      `(надо ${t.cmp === "max" ? "≤" : "≥"} ${t.format(t.limit)}, у референса ${t.ref})`
    );
  });
  lines.unshift(
    report.failed.length === 0
      ? `🎨 Картинок ${report.images.length}, разнообразия хватает.`
      : `🎨 Картинок ${report.images.length}, но они похожи друг на друга ` +
        `(${report.topSector.count} в одном тоне).`,
  );
  return lines;
}
