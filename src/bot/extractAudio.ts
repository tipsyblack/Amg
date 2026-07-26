import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Достаёт из видео моно-дорожку — в таком виде её ждёт ElevenLabs. */
export async function extractAudio(
  videoFile: string,
  outFile: string,
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    videoFile,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "44100",
    "-b:a",
    "192k",
    outFile,
  ]);
}

export async function audioDurationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number(stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

/**
 * Склеивает несколько дорожек в одну. Для клонирования лучше один файл на
 * 1-2 минуты, чем горсть коротких: модели нужен объём материала.
 */
export async function concatAudio(
  files: string[],
  outFile: string,
): Promise<void> {
  if (files.length === 1) {
    await execFileAsync("ffmpeg", ["-y", "-i", files[0], "-c", "copy", outFile]);
    return;
  }

  // Пути пишем в список для concat-демуксера, экранируя кавычки.
  const listFile = path.join(path.dirname(outFile), "concat-list.txt");
  await writeFile(
    listFile,
    files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8",
  );

  // Перекодируем, а не -c copy: у файлов из разных источников могут не
  // совпадать параметры, и склейка копированием дала бы битый результат.
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-ac",
    "1",
    "-ar",
    "44100",
    "-b:a",
    "192k",
    outFile,
  ]);
}
