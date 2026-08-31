// Выравнивание громкости готового ролика: настоящий ffmpeg, настоящие замеры
// по EBU R128 — тем же прибором, которым мерялся присланный референс.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const workDir = mkdtempSync(path.join(tmpdir(), "amg-master-"));
const master = await import("/home/user/Amg/src/bot/masterAudio.ts");

/**
 * Ролик-заготовка: видео плюс речеподобный звук. Ровный тон для проверки
 * громкости не годится — у него нет ни пиков, ни паузы, то есть лимитеру нечего
 * делать, и проверка прошла бы при любой реализации. Здесь есть и то и другое:
 * несущая 150 Гц с формантой, разбитая на слоги, и тишина между ними.
 */
async function makeClip(file, { gainDb = 0, seconds = 12, clicks = false } = {}) {
  // Щелчки — короткие затухающие всплески почти в полную шкалу. Они поднимают
  // ПИК, почти не поднимая среднюю громкость: так и выглядит наш настоящий
  // микс, где звуки стыков бьют в потолок, а речь между ними тише.
  const clickSrc = clicks
    ? ["-f", "lavfi", "-i",
       `aevalsrc='0.98*sin(2*PI*900*t)*exp(-45*mod(t,1.5))':d=${seconds}:s=48000`]
    : [];
  const graph =
    "[1][2]amix=inputs=2:weights=1 0.35:normalize=0[v];" +
    `[v]tremolo=f=4:d=1,volume=${gainDb}dB[syl];` +
    (clicks ? "[syl][3]amix=inputs=2:normalize=0[a]" : "[syl]anull[a]");

  await execFileAsync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:s=320x180:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=150:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=1200:duration=${seconds}`,
    ...clickSrc,
    "-filter_complex", graph,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", file,
  ]);
}

console.log("=== замер громкости ===");
const quiet = path.join(workDir, "quiet.mp4");
await makeClip(quiet, { gainDb: -18 });
const quietLoud = await master.measureLoudness(quiet);
check(
  "ebur128 прочитан целиком",
  Number.isFinite(quietLoud.lufs) && Number.isFinite(quietLoud.lra) && Number.isFinite(quietLoud.truePeakDb),
  `I ${quietLoud.lufs} LUFS, LRA ${quietLoud.lra} LU, пик ${quietLoud.truePeakDb} dBTP`,
);
check("тихий исходник и правда тихий", quietLoud.lufs < -20, `${quietLoud.lufs} LUFS`);

console.log("\n=== подъём до референсной громкости ===");
const loud = path.join(workDir, "loud.mp4");
const up = await master.masterLoudness(quiet, loud);
check(
  "громкость попала в цель",
  Math.abs(up.after.lufs - master.TARGET_LUFS) <= 0.5,
  `${up.before.lufs} → ${up.after.lufs} LUFS (цель ${master.TARGET_LUFS})`,
);
check("усиление посчитано положительным", up.gainDb > 0, `${up.gainDb.toFixed(1)} дБ`);
check(
  "пик под потолком",
  up.after.truePeakDb <= master.TARGET_PEAK_DB + 0.7,
  `${up.after.truePeakDb} dBTP при потолке ${master.TARGET_PEAK_DB}`,
);

console.log("\n=== ролик, который уже упирается в ноль ===");
// Именно этот случай и есть у нас: микс пиками в нуле, а поднять надо на 2-3 дБ.
// Без лимитера тут либо клиппинг, либо цель не достигается вовсе.
const hot = path.join(workDir, "hot.mp4");
await makeClip(hot, { gainDb: 6, clicks: true });
const hotBefore = await master.measureLoudness(hot);
const hotOut = path.join(workDir, "hot-master.mp4");
const down = await master.masterLoudness(hot, hotOut);
check(
  "исходник действительно упирается в потолок",
  hotBefore.truePeakDb > -1,
  `${hotBefore.truePeakDb} dBTP`,
);
check(
  "громкость попала в цель",
  Math.abs(down.after.lufs - master.TARGET_LUFS) <= 0.5,
  `${down.before.lufs} → ${down.after.lufs} LUFS`,
);
check(
  "клиппинга нет: пик прижат",
  down.after.truePeakDb <= master.TARGET_PEAK_DB + 0.7,
  `${down.after.truePeakDb} dBTP`,
);

console.log("\n=== что операция НЕ делает ===");
const probe = async (file, stream) => {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", stream,
    "-show_entries", "stream=codec_name,width,height,nb_frames",
    "-of", "default=nw=1", file,
  ]);
  return stdout.trim();
};
check(
  "видеопоток скопирован без пересчёта",
  (await probe(hot, "v:0")) === (await probe(hotOut, "v:0")),
  await probe(hotOut, "v:0").then((s) => s.replace(/\n/g, " ")),
);
const durOf = async (f) => {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f,
  ]);
  return Number(stdout.trim());
};
check(
  "длина не изменилась",
  Math.abs((await durOf(hot)) - (await durOf(hotOut))) < 0.15,
  `${(await durOf(hot)).toFixed(2)} → ${(await durOf(hotOut)).toFixed(2)} с`,
);
check("файл не распух", statSync(hotOut).size < statSync(hot).size * 1.6);

console.log("\n=== цель, снятая с референса ===");
check("цель −12 LUFS", master.TARGET_LUFS === -12, String(master.TARGET_LUFS));
check("потолок −1.5 dBTP", master.TARGET_PEAK_DB === -1.5, String(master.TARGET_PEAK_DB));

rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
