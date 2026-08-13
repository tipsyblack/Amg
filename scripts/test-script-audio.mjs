// Озвучка сценария одним чтением и нарезка на сцены.
//
// Разбиение проверяется на выдуманных таймингах — так видно арифметику; сама
// нарезка на настоящем файле через ffmpeg. Синтезатор не зовём: он платный, а
// проверять надо не его, а нас.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";
const { planScriptAudioSlices, cutScenes } = await import(
  "/home/user/Amg/src/pipeline/scriptAudio.ts"
);

/** Слова с таймингами: каждое по 300 мс, между сценами вдох в 200 мс. */
function makeWords(texts, gapMs = 200, wordMs = 300) {
  const words = [];
  let t = 0;
  texts.forEach((text, sceneIndex) => {
    if (sceneIndex > 0) t += gapMs;
    for (const token of text.trim().split(/\s+/)) {
      words.push({
        text: token,
        startMs: t,
        endMs: t + wordMs,
        timestampMs: t + wordMs / 2,
        confidence: null,
      });
      t += wordMs;
    }
  });
  return { words, totalMs: t };
}

console.log("=== куда резать ===");
const texts = ["первая сцена тут", "вторая сцена подлиннее вышла", "третья"];
const { words, totalMs } = makeWords(texts);
const plans = planScriptAudioSlices(texts, words, totalMs);
check("план построен", Array.isArray(plans) && plans.length === 3, String(plans?.length));
check("первая сцена начинается с нуля", plans[0].startMs === 0, String(plans[0].startMs));
check(
  "последняя кончается концом дорожки",
  plans[2].endMs === totalMs,
  `${plans[2].endMs} против ${totalMs}`,
);
check(
  "куски идут встык, без дыр и нахлёстов",
  plans.every((p, i) => i === 0 || p.startMs === plans[i - 1].endMs),
  plans.map((p) => `${p.startMs}-${p.endMs}`).join(", "),
);
// Вдох между сценами делится поровну: 900 мс конец первой, 1100 начало второй.
check(
  "разрез посередине вдоха",
  plans[1].startMs === 1000,
  `${plans[1].startMs} (ожидали 1000: между 900 и 1100)`,
);
check(
  "куски покрывают всю дорожку",
  plans.reduce((sum, p) => sum + (p.endMs - p.startMs), 0) === totalMs,
);

console.log("\n=== слова пересчитаны от начала своей сцены ===");
check(
  "у каждой сцены свои слова",
  plans.map((p) => p.words.length).join(",") === "3,4,1",
  plans.map((p) => p.words.length).join(","),
);
check(
  "первое слово второй сцены около нуля, а не 1100",
  plans[1].words[0].startMs === 100,
  `${plans[1].words[0].startMs}`,
);
check(
  "тексты слов не перепутались",
  plans[1].words.map((w) => w.text).join(" ") === "вторая сцена подлиннее вышла",
  plans[1].words.map((w) => w.text).join(" "),
);
check(
  "ни одно слово не ушло в минус",
  plans.every((p) => p.words.every((w) => w.startMs >= 0)),
);
check(
  "слова не вылезают за свой кусок",
  plans.every((p, i) => p.words.at(-1).endMs <= p.endMs - p.startMs + 1),
);

console.log("\n=== когда резать нельзя ===");
// Числа синтезатор читает словами, но выравнивание идёт по ВХОДНОМУ тексту,
// поэтому «1287» остаётся одним словом. Если бы это было не так, счёт бы не
// сошёлся — и мы обязаны отказаться, а не разложить сцены со сдвигом.
const withNumber = ["в дата-центре 1287 мегаватт", "это много"];
const num = makeWords(withNumber);
check(
  "число считается одним словом",
  num.words.length === 6,
  num.words.map((w) => w.text).join("|"),
);
check("на числах план строится", planScriptAudioSlices(withNumber, num.words, num.totalMs) !== undefined);
check(
  "слов больше, чем в тексте — отказ",
  planScriptAudioSlices(texts, [...words, words[0]], totalMs) === undefined,
);
check(
  "слов меньше — отказ",
  planScriptAudioSlices(texts, words.slice(0, -1), totalMs) === undefined,
);
check("пустой сценарий — отказ", planScriptAudioSlices([], [], 0) === undefined);
check(
  "пустая сцена среди непустых — отказ",
  planScriptAudioSlices(["раз", "", "два"], makeWords(["раз", "два"]).words, 1000) === undefined,
);

console.log("\n=== нарезка настоящего файла ===");
const dir = mkdtempSync(path.join(tmpdir(), "amg-sa-"));
try {
  // Дорожка из трёх тонов разной высоты — по ним видно, что кусок вырезан
  // именно свой, а не соседний.
  const whole = path.join(dir, "whole.mp3");
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=600:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=1200:duration=1",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
    "-ar", "44100", "-b:a", "192k", whole]);

  const cutPlans = [
    { startMs: 0, endMs: 1000, words: [] },
    { startMs: 1000, endMs: 3000, words: [] },
    { startMs: 3000, endMs: 4000, words: [] },
  ];
  const scenes = await cutScenes(whole, cutPlans, dir);
  check("файлов столько же, сколько кусков", scenes.length === 3);
  check(
    "имена по сценам",
    scenes.map((s) => s.audioFileName).join(",") === "scene-0.mp3,scene-1.mp3,scene-2.mp3",
    scenes.map((s) => s.audioFileName).join(","),
  );

  const dur = async (f) => {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error",
      "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, f)]);
    return Number(stdout.trim());
  };
  const lengths = [];
  for (const s of scenes) lengths.push(await dur(s.audioFileName));
  check(
    "длины кусков совпали с планом",
    Math.abs(lengths[0] - 1) < 0.08 && Math.abs(lengths[1] - 2) < 0.08 && Math.abs(lengths[2] - 1) < 0.08,
    lengths.map((l) => l.toFixed(2)).join(", "),
  );
  check(
    "в сумме — исходная дорожка",
    Math.abs(lengths.reduce((a, b) => a + b, 0) - 4) < 0.15,
    lengths.reduce((a, b) => a + b, 0).toFixed(2),
  );

  // Главное: в каждом куске должен быть СВОЙ тон. Если бы нарезка уехала,
  // частота оказалась бы соседской.
  const tone = async (f) => {
    const raw = path.join(dir, "t.pcm");
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(dir, f),
      "-ac", "1", "-ar", "8000", "-f", "s16le", raw]);
    const { readFileSync } = await import("node:fs");
    const b = readFileSync(raw);
    const n = Math.min(b.length / 2, 4096);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = b.readInt16LE(2 * i) / 32768;
    let best = 0, bestMag = 0;
    for (let k = 1; k < n / 2; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * k * i) / n;
        re += x[i] * Math.cos(a);
        im -= x[i] * Math.sin(a);
      }
      const mag = Math.hypot(re, im);
      if (mag > bestMag) { bestMag = mag; best = (k * 8000) / n; }
    }
    return best;
  };
  const tones = [];
  for (const s of scenes) tones.push(await tone(s.audioFileName));
  check(
    "в каждом куске свой тон — нарезка не уехала",
    Math.abs(tones[0] - 300) < 40 && Math.abs(tones[1] - 600) < 40 && Math.abs(tones[2] - 1200) < 60,
    tones.map((t) => Math.round(t)).join(", ") + " Гц (ожидали 300, 600, 1200)",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
