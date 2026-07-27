// Проверка подгонки ролика под лимит Telegram (50 МБ). Считаем битрейт и
// реально перекодируем короткий тестовый файл через ffmpeg — арифметику без
// проверки на настоящем кодеке легко ошибиться.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  targetVideoBitrateKbps,
  compressToLimit,
  fileSizeBytes,
  formatMb,
  SAFE_VIDEO_BYTES,
  TELEGRAM_VIDEO_LIMIT_BYTES,
} = await import("../src/bot/videoSize.ts");

console.log("=== расчёт битрейта ===");
check("лимит бота — 50 МБ", TELEGRAM_VIDEO_LIMIT_BYTES === 50 * 1024 * 1024);
check("целимся ниже лимита", SAFE_VIDEO_BYTES < TELEGRAM_VIDEO_LIMIT_BYTES, formatMb(SAFE_VIDEO_BYTES));

const short = targetVideoBitrateKbps(30);
const minute = targetVideoBitrateKbps(60);
const long = targetVideoBitrateKbps(120);
check("короткому ролику битрейт выше", short > minute && minute > long, `${short} / ${minute} / ${long}`);
check("минутный ролик получает разумный битрейт", minute > 4000 && minute < 8000, String(minute));
// Проверка самой арифметики: битрейт × длительность должен дать размер под
// лимит, причём с запасом — x264 держит средний битрейт неточно.
const bytesForMinute = ((minute + 128) * 1000 * 60) / 8;
check("расчёт укладывается в лимит с запасом", bytesForMinute <= SAFE_VIDEO_BYTES * 0.95, `${formatMb(bytesForMinute)} при цели ${formatMb(SAFE_VIDEO_BYTES)}`);
check("нулевая длительность не ломает расчёт", targetVideoBitrateKbps(0) === undefined);
check("на неподъёмной длине сдаёмся честно", targetVideoBitrateKbps(600) === undefined, String(targetVideoBitrateKbps(600)));

console.log("\n=== перекодирование настоящего файла ===");
const dir = mkdtempSync(path.join(tmpdir(), "amg-size-"));
const source = path.join(dir, "big.mp4");
const out = path.join(dir, "small.mp4");

// 4 секунды шума на высоком битрейте: шум плохо сжимается, поэтому файл
// заведомо «тяжёлый» относительно цели.
execFileSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "nullsrc=s=540x960:d=4,geq=random(1)*255:128:128",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
  "-c:v", "libx264", "-b:v", "8000k", "-c:a", "aac", "-shortest",
  source,
]);
const sourceBytes = await fileSizeBytes(source);
check("тестовый файл создан", sourceBytes > 0, formatMb(sourceBytes));

// Лимит 1 МБ на 4 секунды — заведомо жёстче исходника.
const limit = 1024 * 1024;
const { bitrateKbps } = await compressToLimit(source, out, 4, limit);
const outBytes = await fileSizeBytes(out);
check("файл стал меньше", outBytes < sourceBytes, `${formatMb(sourceBytes)} → ${formatMb(outBytes)}`);
check("уложились в заданный лимит", outBytes <= limit, `${formatMb(outBytes)} при лимите ${formatMb(limit)}`);
check("битрейт сообщён наружу", typeof bitrateKbps === "number" && bitrateKbps > 0, String(bitrateKbps));

// Файл должен остаться валидным видео с обеими дорожками.
const probe = execFileSync("ffprobe", [
  "-v", "error", "-show_entries", "stream=codec_type,codec_name",
  "-of", "csv=p=0", out,
]).toString();
check("видеодорожка на месте", probe.includes("h264,video") || probe.includes("video"), probe.trim().replace(/\n/g, " "));
check("звук на месте", probe.includes("audio"), probe.trim().replace(/\n/g, " "));
check("длительность сохранилась", (() => {
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out]).toString());
  return d > 3.5 && d < 4.6;
})());
// faststart нужен, чтобы Telegram показал превью и стримил с начала: индекс
// moov должен лежать раньше данных mdat. Смотрим прямо в байтах контейнера.
const raw = readFileSync(out).toString("latin1");
check(
  "контейнер с faststart (moov раньше mdat)",
  raw.indexOf("moov") < raw.indexOf("mdat"),
  `moov@${raw.indexOf("moov")}, mdat@${raw.indexOf("mdat")}`,
);

console.log("\n=== слишком длинный ролик: не молчим ===");
try {
  await compressToLimit(source, out, 600, limit);
  check("должно было упасть", false);
} catch (e) {
  check("объяснено, что делать", e.message.includes("Сократите сценарий"), e.message.split("\n")[0]);
  check("подсказан путь забрать файл", e.message.includes("out/video.mp4"));
}

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
