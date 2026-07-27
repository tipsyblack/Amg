import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Бот может отправить файл не больше 50 МБ — на большем Telegram отвечает
// «413: Request Entity Too Large», и ролик, за который уже заплачены генерации,
// остаётся на сервере. Целимся ниже лимита: у multipart-запроса есть накладные
// расходы, да и округления в расчёте битрейта работают не в нашу пользу.
export const TELEGRAM_VIDEO_LIMIT_BYTES = 50 * 1024 * 1024;
export const SAFE_VIDEO_BYTES = 45 * 1024 * 1024;

// Звук в ролике — речь и короткие эффекты, 128 кбит/с хватает с запасом.
const AUDIO_BITRATE_KBPS = 128;
// Ниже этого сжимать бессмысленно: 1080×1920 превратится в кашу, и лучше
// честно сказать, что ролик слишком длинный.
const MIN_VIDEO_BITRATE_KBPS = 900;
// Запас на контейнер и неточность управления битрейтом: x264 держит средний
// битрейт с погрешностью, и расчёт «ровно в лимит» давал файл чуть больше
// лимита. Проверено перекодированием — см. npm run test:size.
const BITRATE_SAFETY = 0.9;

export async function fileSizeBytes(file: string): Promise<number> {
  return (await stat(file)).size;
}

export function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * Битрейт видео, при котором ролик известной длины уложится в лимит.
 * Возвращает undefined, если для такой длины даже приемлемого качества не
 * хватит — тогда сжимать не надо, надо сокращать ролик.
 */
export function targetVideoBitrateKbps(
  durationSeconds: number,
  limitBytes = SAFE_VIDEO_BYTES,
): number | undefined {
  if (durationSeconds <= 0) return undefined;
  const totalKbps = ((limitBytes * 8) / 1000 / durationSeconds) * BITRATE_SAFETY;
  const videoKbps = Math.floor(totalKbps - AUDIO_BITRATE_KBPS);
  return videoKbps >= MIN_VIDEO_BITRATE_KBPS ? videoKbps : undefined;
}

/**
 * Перекодирует ролик под лимит Telegram. Разрешение и длину не трогаем —
 * только битрейт: для соцсетей это незаметнее, чем уменьшенный кадр.
 */
export async function compressToLimit(
  inFile: string,
  outFile: string,
  durationSeconds: number,
  limitBytes = SAFE_VIDEO_BYTES,
): Promise<{ bitrateKbps: number }> {
  const bitrateKbps = targetVideoBitrateKbps(durationSeconds, limitBytes);
  if (bitrateKbps === undefined) {
    throw new Error(
      `Ролик длиной ${Math.round(durationSeconds)} с не влезает в лимит ` +
        "Telegram (50 МБ) без заметной потери качества. Сократите сценарий " +
        "(«✏️ Правки») или забирайте файл с сервера: out/video.mp4",
    );
  }

  await execFileAsync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inFile,
      "-c:v", "libx264",
      "-b:v", `${bitrateKbps}k`,
      // maxrate/bufsize держат пики: без них средний битрейт соблюдается, но
      // отдельные секунды раздувают файл.
      "-maxrate", `${Math.round(bitrateKbps * 1.3)}k`,
      "-bufsize", `${Math.round(bitrateKbps * 2)}k`,
      "-preset", "medium",
      "-pix_fmt", "yuv420p",
      // faststart — чтобы Telegram показывал превью и стримил с начала.
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", `${AUDIO_BITRATE_KBPS}k`,
      outFile,
    ],
    { timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
  );

  return { bitrateKbps };
}
