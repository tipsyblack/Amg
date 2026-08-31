import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";

const execFileAsync = promisify(execFile);

export async function getAudioDurationInSeconds(
  filePath: string,
): Promise<number> {
  const metadata = await parseFile(filePath);
  const duration = metadata.format.duration;
  if (!duration) {
    throw new Error(`Не удалось определить длительность файла ${filePath}`);
  }
  return duration;
}

/**
 * Длительность видеоклипа — через ffprobe, а не через music-metadata.
 *
 * Разбором контейнера тут не обойтись: на mp4 с видеодорожкой parseFile
 * длительности не отдаёт (проверено на настоящем файле в test-clips), и
 * функция молча возвращала бы запасное значение. ffprobe в проекте и так
 * нужен — им же меряются размеры картинок и длина референсов.
 *
 * Запасное значение вместо исключения: длина клипа нужна только чтобы знать,
 * с какого кадра его подмораживать, и ошибиться здесь гораздо дешевле, чем
 * уронить ролик, в котором всё остальное уже посчитано.
 */
export async function getClipDurationInSeconds(
  filePath: string,
  fallbackSeconds: number,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ]);
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
  } catch {
    return fallbackSeconds;
  }
}
