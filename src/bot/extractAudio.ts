import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Работа с файлами сэмплов живёт в pipeline: там же у неё второй потребитель —
// загрузка в ElevenLabs, которая режет слишком большие файлы под лимит.
export {
  audioDurationSeconds,
  concatAudio,
  fileSizeBytes,
} from "../pipeline/voiceSamples";

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

