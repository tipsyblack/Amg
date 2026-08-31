import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { measureLoudness } from "./loudness";

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 22050;

/**
 * Кадр для поиска пульса — короткий: важна точность по времени, удары надо
 * различать. Тональность наоборот требует точности по частоте, и для неё кадр
 * отдельный, длинный (см. CHROMA_FRAME).
 */
const ONSET_FRAME = 1024;
const ONSET_HOP = 256;

/**
 * Кадр для хромы — 8192 отсчёта. Не «побольше на всякий случай», а по расчёту:
 * бин при 22 050 Гц выходит 2.7 Гц, а полутон вблизи 70 Гц — это всего 4.2 Гц.
 * На кадре 1024 (бин 21.5 Гц) полутон в басовом регистре просто не
 * разрешается: нота 185 Гц размазывается по бинам, которые ближе к F и G, чем
 * к F#, и определитель уверенно выдаёт чужую тональность. Проверено на
 * синтезированных треках с известной тональностью: 1024 → «F major» вместо
 * «D# minor», 8192 → верно.
 */
const CHROMA_FRAME = 8192;
const CHROMA_HOP = 4096;

/**
 * Нижняя граница хромы выводится из разрешения, а не выбирается на глаз: нужно
 * не меньше полутора бинов на полутон, иначе класс ноты не определить.
 */
const BINS_PER_SEMITONE = 1.5;
const SEMITONE_RATIO = 2 ** (1 / 12) - 1;
const CHROMA_MIN_HZ =
  (BINS_PER_SEMITONE * (SAMPLE_RATE / CHROMA_FRAME)) / SEMITONE_RATIO;
const CHROMA_MAX_HZ = 2000;

const NOTES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export interface MusicAnalysis {
  seconds: number;
  bpm: number;
  /**
   * Отношение громких всплесков энергии к типичным (p95/медиана). Именно оно
   * отвечает на вопрос «есть ли тут пульс вообще»: у трека с барабанами это
   * десятки и сотни, у дрона и у речи — около трёх.
   */
  onsetContrast: number;
  root: string;
  minor: boolean;
  /** Доли мощности по полосам, в процентах. */
  bands: { name: string; from: number; to: number; percent: number }[];
  lufs: number;
}

/** Пульс считаем найденным выше этого контраста. */
export const BEAT_FOUND_ABOVE = 6;

/** Быстрое преобразование Фурье по основанию 2, на месте. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * wr - xi * wi;
        const vi = xr * wi + xi * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
      }
    }
  }
}

/** Сырые сэмплы моно 22 кГц: ffmpeg декодирует что угодно, дальше считаем сами. */
async function decode(file: string): Promise<Float64Array> {
  const raw = `${file}.pcm`;
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", file,
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    raw,
  ], { timeout: 5 * 60 * 1000 });
  try {
    const buffer = await readFile(raw);
    const samples = new Float64Array(buffer.length / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = buffer.readInt16LE(i * 2) / 32768;
    }
    return samples;
  } finally {
    await rm(raw, { force: true });
  }
}

function hann(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return window;
}

function magnitudes(
  x: Float64Array,
  frame: number,
  hop: number,
): Float64Array[] {
  const window = hann(frame);
  const out: Float64Array[] = [];
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  for (let start = 0; start + frame <= x.length; start += hop) {
    for (let n = 0; n < frame; n++) {
      re[n] = x[start + n] * window[n];
      im[n] = 0;
    }
    fft(re, im);
    const half = frame / 2;
    const spectrum = new Float64Array(half);
    for (let k = 0; k < half; k++) spectrum[k] = Math.hypot(re[k], im[k]);
    out.push(spectrum);
  }
  return out;
}

/** Прирост энергии между кадрами — по нему видно удары. */
function onsetEnvelope(frames: Float64Array[]): Float64Array {
  const flux = new Float64Array(frames.length);
  for (let i = 1; i < frames.length; i++) {
    let sum = 0;
    for (let k = 0; k < frames[i].length; k++) {
      const d = frames[i][k] - frames[i - 1][k];
      if (d > 0) sum += d;
    }
    flux[i] = sum;
  }
  return flux;
}

/**
 * Темп: контраст ударов решает, есть ли пульс, автокорреляция — какой он.
 *
 * Высоту автокорреляции как меру уверенности брать нельзя, и это проверено:
 * у чистого дрона она выходит 0.94, у трека с бочкой — 0.90. То есть по ней
 * «пульс» находится там, где его нет вовсе. А контраст всплесков разделяет их
 * с трёхкратным запасом: дрон 2.9, речь 2.8, бочка 2300.
 */
function detectTempo(flux: Float64Array): { bpm: number; contrast: number } {
  const sorted = Array.from(flux).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const contrast = p95 / median;

  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(flux.length, 1);
  const centred = Array.from(flux, (v) => v - mean);
  const energy = centred.reduce((a, b) => a + b * b, 0);
  if (energy === 0) return { bpm: 0, contrast };

  const framesPerSecond = SAMPLE_RATE / ONSET_HOP;
  const minLag = Math.floor((60 / 180) * framesPerSecond);
  const maxLag = Math.min(
    Math.ceil((60 / 70) * framesPerSecond),
    centred.length - 1,
  );
  if (maxLag <= minLag) return { bpm: 0, contrast };

  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < centred.length; i++) sum += centred[i] * centred[i - lag];
    scores.push(sum / energy);
  }

  // Берём не максимум автокорреляции, а её выступание над сглаженным фоном:
  // у плавно меняющегося сигнала она высокая на всех малых сдвигах сразу.
  const window = Math.max(3, Math.round(scores.length / 8));
  let bestIndex = 0;
  let best = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(scores.length - 1, i + window);
    let baseline = 0;
    for (let j = from; j <= to; j++) baseline += scores[j];
    baseline /= to - from + 1;
    const prominence = scores[i] - baseline;
    if (prominence > best) {
      best = prominence;
      bestIndex = i;
    }
  }
  return {
    bpm: (60 * framesPerSecond) / (minLag + bestIndex),
    contrast,
  };
}

/**
 * Тональность по хроме. Профили Крумхансл-Кесслера: у мажора и минора разный
 * рисунок весов по ступеням, и корреляция с ними отличает одно от другого.
 */
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

function detectKey(frames: Float64Array[]): { root: string; minor: boolean } {
  const chroma = new Array(12).fill(0);
  for (const frame of frames) {
    for (let k = 1; k < frame.length; k++) {
      const freq = (k * SAMPLE_RATE) / CHROMA_FRAME;
      if (freq < CHROMA_MIN_HZ || freq > CHROMA_MAX_HZ) continue;
      const midi = Math.round(69 + 12 * Math.log2(freq / 440));
      // Магнитуда, а не мощность: в квадрате один громкий удар перевешивает
      // весь аккорд, и тональность получается «бочкина», а не трека.
      chroma[((midi % 12) + 12) % 12] += frame[k];
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total === 0) return { root: "C", minor: false };
  const normalized = chroma.map((v) => v / total);

  const correlate = (profile: number[], shift: number): number => {
    const mean = profile.reduce((a, b) => a + b, 0) / 12;
    let num = 0;
    let denom = 0;
    for (let i = 0; i < 12; i++) {
      const p = profile[(i - shift + 12) % 12] - mean;
      num += normalized[i] * p;
      denom += p * p;
    }
    return num / Math.sqrt(denom || 1);
  };

  let bestRoot = 0;
  let bestMinor = false;
  let best = -Infinity;
  for (let shift = 0; shift < 12; shift++) {
    for (const minor of [false, true]) {
      const score = correlate(minor ? MINOR_PROFILE : MAJOR_PROFILE, shift);
      if (score > best) {
        best = score;
        bestRoot = shift;
        bestMinor = minor;
      }
    }
  }
  return { root: NOTES[bestRoot], minor: bestMinor };
}

const BANDS: { name: string; from: number; to: number }[] = [
  { name: "саб", from: 20, to: 80 },
  { name: "бас", from: 80, to: 250 },
  { name: "середина", from: 250, to: 2000 },
  { name: "верх", from: 2000, to: 6000 },
  { name: "воздух", from: 6000, to: 11000 },
];

function bandShares(
  frames: Float64Array[],
  frameSize: number,
): MusicAnalysis["bands"] {
  const power = new Array(BANDS.length).fill(0);
  let total = 0;
  for (const frame of frames) {
    for (let k = 1; k < frame.length; k++) {
      const freq = (k * SAMPLE_RATE) / frameSize;
      const p = frame[k] * frame[k];
      total += p;
      const index = BANDS.findIndex((b) => freq >= b.from && freq < b.to);
      if (index >= 0) power[index] += p;
    }
  }
  return BANDS.map((band, i) => ({
    ...band,
    percent: total > 0 ? (100 * power[i]) / total : 0,
  }));
}

export async function analyzeMusic(file: string): Promise<MusicAnalysis> {
  const samples = await decode(file);
  const onsetFrames = magnitudes(samples, ONSET_FRAME, ONSET_HOP);
  const chromaFrames = magnitudes(samples, CHROMA_FRAME, CHROMA_HOP);
  const { bpm, contrast } = detectTempo(onsetEnvelope(onsetFrames));
  const { root, minor } = detectKey(chromaFrames);
  const { lufs } = await measureLoudness(file);
  return {
    seconds: samples.length / SAMPLE_RATE,
    bpm: Math.round(bpm),
    onsetContrast: contrast,
    root,
    minor,
    bands: bandShares(onsetFrames, ONSET_FRAME),
    lufs,
  };
}

/**
 * Собирает из обмера описание для генератора музыки.
 *
 * Смысл этой функции: трек, который понравился, — чужая запись, и в ролик её
 * ставить нельзя. А вот измерить её и заказать генератору свою в том же темпе,
 * тональности и с тем же распределением по полосам — можно. Описание получается
 * из чисел, а не из впечатления, поэтому его видно в чате и можно поправить
 * руками перед генерацией.
 */
export function musicPromptFromAnalysis(analysis: MusicAnalysis): string {
  const share = (name: string): number =>
    analysis.bands.find((b) => b.name === name)?.percent ?? 0;

  const parts: string[] = [
    "Instrumental background music for a talking-head short video",
  ];

  if (analysis.onsetContrast >= BEAT_FOUND_ABOVE && analysis.bpm > 0) {
    parts.push(`${analysis.bpm} BPM`);
  } else {
    parts.push("no clear beat, ambient and floating");
  }
  parts.push(`key ${analysis.root} ${analysis.minor ? "minor" : "major"}`);

  const low = share("саб") + share("бас");
  if (low > 60) parts.push("dominant deep sub bass, almost no high end");
  else if (low > 35) parts.push("warm heavy low end");
  else parts.push("light low end");

  if (share("воздух") > 8) parts.push("crisp hats and bright air");
  else if (share("верх") > 12) parts.push("present but soft high end");
  else parts.push("dark, muted high end");

  if (share("середина") > 45) parts.push("rich midrange, melodic");
  else parts.push("sparse midrange, leaves room for a voice");

  parts.push("steady loopable groove, no vocals, no sudden drops");
  return parts.join(", ");
}
