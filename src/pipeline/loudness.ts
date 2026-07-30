import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Loudness {
  lufs: number;
  lra: number;
  truePeakDb: number;
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Громкость по EBU R128 — тем же прибором, которым мерялся присланный референс.
 * Работает и на видео, и на отдельной дорожке.
 */
export async function measureLoudness(file: string): Promise<Loudness> {
  // ebur128 пишет сводку в stderr, а на stdout идёт (пустой) выходной поток.
  const { stderr } = await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
    { maxBuffer: 16 * 1024 * 1024 },
  );

  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const pick = (label: string): number => {
    const match = new RegExp(`${label}:\\s*(-?[\\d.]+)`).exec(summary);
    if (!match) {
      throw new Error(`ffmpeg не отдал ${label} для ${file}`);
    }
    return Number(match[1]);
  };

  return { lufs: pick("I"), lra: pick("LRA"), truePeakDb: pick("Peak") };
}
