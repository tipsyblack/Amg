// Подготовка треков для библиотеки и обмер чужого трека.
//
// Проверяется на синтезированных треках, у которых темп и тональность известны
// заранее: только так видно, что определитель работает, а не выдаёт правдоподобно
// выглядящие числа.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const workDir = mkdtempSync(path.join(tmpdir(), "amg-music-"));
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

const analyze = await import("/home/user/Amg/src/pipeline/analyzeMusic.ts");
const prep = await import("/home/user/Amg/src/pipeline/prepareMusic.ts");
const loud = await import("/home/user/Amg/src/pipeline/loudness.ts");

/**
 * Трек с известными свойствами: бочка в заданном темпе, басовая нота заданной
 * частоты, аккорд сверху и хэты. Всё честным синтезом через ffmpeg, чтобы
 * определителю было что находить.
 */
async function makeTrack(file, { bpm, rootHz, seconds = 16, hats = true, gainDb = 0 }) {
  const beat = 60 / bpm;
  const inputs = [
    // Бочка: затухающий тон октавой ниже тоники каждые beat секунд. Именно
    // октавой ниже, а не на фиксированных 55 Гц: с постоянной частотой бочка
    // добавляла в трек ноту, которой в тональности нет, и определять по такому
    // материалу тональность — проверять себя на подтасованном примере.
    `aevalsrc='0.9*sin(2*PI*${(rootHz / 2).toFixed(3)}*t)*exp(-25*mod(t,${beat.toFixed(4)}))':d=${seconds}:s=44100`,
    // Бас: нота с гармониками. Чистым синусом её делать нельзя — у настоящего
    // баса есть октава и квинта сверху, и именно по ним тональность и читается
    // в регистре, где разрешения на основной тон уже не хватает. На чистом
    // синусе тест проверял бы определитель на материале, которого не бывает.
    `aevalsrc='0.35*sin(2*PI*${rootHz.toFixed(3)}*t)+0.18*sin(2*PI*${(rootHz * 2).toFixed(3)}*t)+0.09*sin(2*PI*${(rootHz * 3).toFixed(3)}*t)':d=${seconds}:s=44100`,
    // Квинта и малая терция сверху — минорное трезвучие от той же ноты.
    `aevalsrc='0.18*sin(2*PI*${(rootHz * 2.9966).toFixed(3)}*t)+0.18*sin(2*PI*${(rootHz * 2.3784).toFixed(3)}*t)':d=${seconds}:s=44100`,
  ];
  if (hats) {
    // Хэты: шумовой всплеск на каждой восьмой, через хайпасс.
    inputs.push(
      `aevalsrc='0.25*random(0)*exp(-60*mod(t,${(beat / 2).toFixed(4)}))':d=${seconds}:s=44100`,
    );
  }
  const args = ["-y", "-loglevel", "error"];
  for (const i of inputs) args.push("-f", "lavfi", "-i", i);
  const mix = inputs.map((_, i) => `[${i}:a]`).join("");
  const chain = hats
    ? `[3:a]highpass=f=6000[h];${mix.replace("[3:a]", "[h]")}amix=inputs=${inputs.length}:normalize=0[m]`
    : `${mix}amix=inputs=${inputs.length}:normalize=0[m]`;
  args.push(
    "-filter_complex", `${chain};[m]volume=${gainDb}dB[out]`,
    "-map", "[out]", "-ar", "44100", "-b:a", "192k", file,
  );
  await execFileAsync("ffmpeg", args);
}

console.log("=== обмер трека с известными свойствами ===");
// A2 = 110 Гц, минор, 100 BPM.
const known = path.join(workDir, "known.mp3");
await makeTrack(known, { bpm: 100, rootHz: 110 });
const a = await analyze.analyzeMusic(known);
check("длина прочитана", Math.abs(a.seconds - 16) < 0.5, `${a.seconds.toFixed(1)} с`);
check("пульс найден", a.onsetContrast >= analyze.BEAT_FOUND_ABOVE, `контраст ударов ${a.onsetContrast.toFixed(1)}`);
// Половинный и двойной темп — та же сетка, для описания это приемлемо.
const bpmOk = [50, 100, 200].some((v) => Math.abs(a.bpm - v) <= 3);
check("темп совпал с заданным (или его кратным)", bpmOk, `${a.bpm} BPM при заданных 100`);
check("тоника определена как A", a.root === "A", `${a.root} ${a.minor ? "minor" : "major"}`);
check("лад определён как минор", a.minor === true, a.minor ? "minor" : "major");
const sum = a.bands.reduce((s, b) => s + b.percent, 0);
check("доли полос в сумме дают ~100%", Math.abs(sum - 100) < 12, `${sum.toFixed(0)}%`);

console.log("\n=== другая тональность и темп ===");
// D#2 ≈ 77.78 Гц, 140 BPM.
const other = path.join(workDir, "other.mp3");
await makeTrack(other, { bpm: 140, rootHz: 77.78 });
const b = await analyze.analyzeMusic(other);
check("тоника поменялась на D#", b.root === "D#", `${b.root} ${b.minor ? "minor" : "major"}`);
check(
  "темп поменялся",
  [70, 140].some((v) => Math.abs(b.bpm - v) <= 4),
  `${b.bpm} BPM при заданных 140`,
);

console.log("\n=== трек без пульса ===");
const drone = path.join(workDir, "drone.mp3");
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
  "sine=frequency=110:duration=16", "-ar", "44100", "-b:a", "192k", drone]);
const d = await analyze.analyzeMusic(drone);
check(
  "пульс честно не найден",
  d.onsetContrast < analyze.BEAT_FOUND_ABOVE,
  `контраст ударов ${d.onsetContrast.toFixed(1)} против ${analyze.BEAT_FOUND_ABOVE} порога`,
);
check(
  "в описании так и написано",
  analyze.musicPromptFromAnalysis(d).includes("no clear beat"),
  analyze.musicPromptFromAnalysis(d).slice(0, 70),
);

console.log("\n=== описание для генератора ===");
const prompt = analyze.musicPromptFromAnalysis(a);
check("темп попал в описание", prompt.includes(`${a.bpm} BPM`), prompt.slice(0, 90));
check("тональность попала", prompt.includes("A minor"));
check("вокал запрещён", prompt.includes("no vocals"));
check("петля упомянута", prompt.includes("loopable"));

console.log("\n=== подготовка для библиотеки ===");
// Два трека с громкостью, различающейся на 14 дБ: именно это и ломало микс —
// подложка звучала то фоном, то помехой.
const quiet = path.join(workDir, "quiet.mp3");
const hot = path.join(workDir, "hot.mp3");
await makeTrack(quiet, { bpm: 100, rootHz: 110, gainDb: -14 });
await makeTrack(hot, { bpm: 100, rootHz: 110, gainDb: 0 });
const before = [await loud.measureLoudness(quiet), await loud.measureLoudness(hot)];
check(
  "исходники действительно разной громкости",
  Math.abs(before[0].lufs - before[1].lufs) > 8,
  `${before[0].lufs} и ${before[1].lufs} LUFS`,
);

const outQuiet = path.join(workDir, "quiet-prep.wav");
const outHot = path.join(workDir, "hot-prep.wav");
const rq = await prep.prepareMusicTrack(quiet, outQuiet);
const rh = await prep.prepareMusicTrack(hot, outHot);
check(
  "тихий трек приведён к цели",
  Math.abs(rq.after.lufs - prep.MUSIC_LUFS) <= 1,
  `${rq.before.lufs} → ${rq.after.lufs} LUFS (цель ${prep.MUSIC_LUFS})`,
);
check(
  "громкий трек приведён к той же цели",
  Math.abs(rh.after.lufs - prep.MUSIC_LUFS) <= 1,
  `${rh.before.lufs} → ${rh.after.lufs} LUFS`,
);
check(
  "разброс между треками сошёлся",
  Math.abs(rq.after.lufs - rh.after.lufs) <= 1,
  `${Math.abs(rq.after.lufs - rh.after.lufs).toFixed(1)} дБ вместо ${Math.abs(before[0].lufs - before[1].lufs).toFixed(1)}`,
);
check("пик не в нуле", rh.after.truePeakDb <= -2, `${rh.after.truePeakDb} dBTP`);

console.log("\n=== место под голос освобождено ===");
async function bandDb(file, lo, hi) {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-i", file,
    "-af", `highpass=f=${lo},lowpass=f=${hi},volumedetect`,
    "-f", "null", "-",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return Number(/mean_volume:\s*(-?[\d.]+)/.exec(stderr)[1]);
}
// Фильтр меряем розовым шумом: у синтезированного трека в 2-4 кГц энергии
// почти нет (там только просачивание хэтов), и на нём любой эквалайзер покажет
// «ничего не изменилось» — на это я и наступил в первой версии теста.
const pink = path.join(workDir, "pink.mp3");
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
  "anoisesrc=d=16:c=pink:a=0.3", "-ar", "44100", "-b:a", "192k", pink]);
const pinkPrep = path.join(workDir, "pink-prep.wav");
await prep.prepareMusicTrack(pink, pinkPrep);
const midBefore = await bandDb(pink, 300, 800);
const midAfter = await bandDb(pinkPrep, 300, 800);
const speechBefore = await bandDb(pink, 2200, 4200);
const speechAfter = await bandDb(pinkPrep, 2200, 4200);
// Интересен наклон, а не уровень: громкость после подготовки другая.
const dipBefore = speechBefore - midBefore;
const dipAfter = speechAfter - midAfter;
check(
  "полоса разборчивости речи просела относительно середины",
  dipAfter < dipBefore - 1,
  `${dipBefore.toFixed(1)} → ${dipAfter.toFixed(1)} дБ`,
);
const subBefore = (await bandDb(pink, 20, 55)) - midBefore;
const subAfter = (await bandDb(pinkPrep, 20, 55)) - midAfter;
check(
  "подвал ниже 60 Гц убран",
  subAfter < subBefore - 5,
  `${subBefore.toFixed(1)} → ${subAfter.toFixed(1)} дБ`,
);

console.log("\n=== петля без щелчка ===");
check("трек помечен как зацикленный", rh.looped === true);
check(
  "длина укоротилась на склейку",
  rh.secondsAfter < rh.secondsBefore - 1 && rh.secondsAfter > rh.secondsBefore - 3,
  `${rh.secondsBefore.toFixed(1)} → ${rh.secondsAfter.toFixed(1)} с`,
);

/** Максимальный скачок между соседними сэмплами и типичный по файлу. */
async function seamJump(file) {
  const raw = path.join(workDir, "seam.pcm");
  // Склеиваем файл сам с собой — ровно так его повторяет Remotion.
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error",
    "-i", file, "-i", file,
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[o]",
    "-map", "[o]", "-ac", "1", "-ar", "44100", "-f", "s16le", raw]);
  const buffer = readFileSync(raw);
  const n = buffer.length / 2;
  const at = Math.floor(n / 2);
  let maxSeam = 0;
  for (let i = at - 3; i <= at + 3; i++) {
    maxSeam = Math.max(maxSeam, Math.abs(buffer.readInt16LE(i * 2) - buffer.readInt16LE((i - 1) * 2)));
  }
  const jumps = [];
  for (let i = 1; i < n; i += 977) {
    jumps.push(Math.abs(buffer.readInt16LE(i * 2) - buffer.readInt16LE((i - 1) * 2)));
  }
  jumps.sort((x, y) => x - y);
  rmSync(raw, { force: true });
  return { seam: maxSeam, typical: jumps[Math.floor(jumps.length * 0.99)] };
}

const seamSoft = await seamJump(outHot);
check(
  "у подготовленного wav стык не выделяется",
  seamSoft.seam <= Math.max(seamSoft.typical, 1) * 2,
  `скачок ${seamSoft.seam} против типичного ${seamSoft.typical}`,
);

// Тот же трек в mp3 — для сведений, без утверждения. Я предполагал, что тишина
// выравнивания кадра mp3 испортит стык, замерил — не портит: ffmpeg снимает её
// по тегам LAME. Поэтому библиотека держится в wav не «потому что mp3 ломает
// петлю», а потому что это зависит от декодера, а декодирует её Chromium внутри
// Remotion, и его поведение проверить отсюда не получилось.
const asMp3 = path.join(workDir, "hot-prep-as.mp3");
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", outHot, "-b:a", "192k", asMp3]);
const seamMp3 = await seamJump(asMp3);
console.log(`  ––   для сведения: тот же трек в mp3 — стык ${seamMp3.seam}, типичный ${seamMp3.typical}`);

// Прямая проверка построения: начало подготовленного файла — это то место
// исходника, откуда его склеили (orig(D-X)), поэтому перед стыком волна
// продолжается, а не прыгает. Скачок сэмплов на стыке мерить у mp3 нельзя:
// формат добавляет тишину выравнивания кадра, и она сглаживает любой разрыв —
// первая версия теста именно на это и наступила.
async function pcm(file) {
  const raw = path.join(workDir, "cmp.pcm");
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", file,
    "-ac", "1", "-ar", "22050", "-f", "s16le", raw]);
  const buffer = readFileSync(raw);
  const out = new Float64Array(buffer.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buffer.readInt16LE(i * 2) / 32768;
  rmSync(raw, { force: true });
  return out;
}
const origPcm = await pcm(hot);
const prepPcm = await pcm(outHot);
const head = prepPcm.subarray(0, 22050 / 5); // 200 мс
const expectedAt = Math.round((rh.secondsBefore - 2) * 22050);
function correlationAt(offset) {
  let num = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < head.length; i++) {
    const x = head[i];
    const y = origPcm[offset + i] ?? 0;
    num += x * y; a2 += x * x; b2 += y * y;
  }
  return num / Math.sqrt((a2 * b2) || 1);
}
let bestOffset = expectedAt, bestCorr = -2;
for (let o = expectedAt - 4410; o <= expectedAt + 4410; o += 5) {
  const c = correlationAt(o);
  if (c > bestCorr) { bestCorr = c; bestOffset = o; }
}
check(
  "начало петли — это хвост исходника, склейка построена верно",
  bestCorr > 0.8,
  `корреляция ${bestCorr.toFixed(2)}`,
);
check(
  "и найдено оно там, где ожидалось",
  Math.abs(bestOffset - expectedAt) / 22050 < 0.15,
  `сдвиг ${((bestOffset - expectedAt) / 22050 * 1000).toFixed(0)} мс`,
);

console.log("\n=== короткий трек не режем ===");
const short = path.join(workDir, "short.mp3");
await makeTrack(short, { bpm: 100, rootHz: 110, seconds: 5 });
const rs = await prep.prepareMusicTrack(short, path.join(workDir, "short-prep.wav"));
check("склейки не было", rs.looped === false);
check(
  "длина сохранилась",
  Math.abs(rs.secondsAfter - rs.secondsBefore) < 0.4,
  `${rs.secondsBefore.toFixed(1)} → ${rs.secondsAfter.toFixed(1)} с`,
);

console.log("\n=== подготовка на месте ===");
const inPlace = path.join(workDir, "lib-track.wav");
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", hot, inPlace]);
const moved = await prep.prepareMusicTrackInPlace(inPlace);
check("файл стал wav", moved.file.endsWith(".wav"), path.basename(moved.file));
// Расширение у подготовленного трека всегда .wav, поэтому если исходник тоже
// был .wav — он заменён на месте, и проверять надо не отсутствие файла, а то,
// что по этому пути теперь лежит обработанный трек.
check(
  "старый файл заменён обработанным",
  moved.file === inPlace && statSync(inPlace).size > 0,
  path.basename(moved.file),
);
check(
  "громкость приведена",
  Math.abs(moved.result.after.lufs - prep.MUSIC_LUFS) <= 1,
  `${moved.result.after.lufs} LUFS`,
);

rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
