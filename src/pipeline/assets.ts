import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoData } from "../types";
import { getAudioDurationInSeconds } from "./audioDuration";
import { config } from "./config";
import { generateSceneImage, STYLE_PROMPT } from "./generateImage";
import { synthesizeSpeech } from "./generateVoiceover";

export const PUBLIC_AUDIO_DIR = path.resolve("public/audio");
export const PUBLIC_IMAGES_DIR = path.resolve("public/images");
export const PUBLIC_MUSIC_DIR = path.resolve("public/music");
export const MUSIC_LIBRARY_DIR = path.resolve("assets/music");
export const DATA_FILE = path.resolve("data/video-data.json");

// Небольшой запас после конца озвучки, чтобы подпись не исчезала мгновенно.
const SCENE_PADDING_SECONDS = 0.4;

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);

export async function ensureDirs(): Promise<void> {
  await mkdir(PUBLIC_AUDIO_DIR, { recursive: true });
  await mkdir(PUBLIC_IMAGES_DIR, { recursive: true });
  await mkdir(PUBLIC_MUSIC_DIR, { recursive: true });
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
}

export function buildImagePrompt(
  scene: { caption: string; voiceoverText: string },
  styleNotes?: string,
): string {
  const styleAddition = styleNotes
    ? `\n\nДополнительные заметки о стиле из референса пользователя (учитывай их, не ломая описанный выше стиль и персонажа): ${styleNotes}`
    : "";
  return `${STYLE_PROMPT}${styleAddition}\n\nСцена: ${scene.caption}. Контекст: ${scene.voiceoverText}`;
}

export async function generateSceneAudio(
  index: number,
  voiceoverText: string,
  voiceOverride?: string,
): Promise<{ audioFileName: string; durationInFrames: number }> {
  const audioFileName = `scene-${index}.mp3`;
  const audioPath = path.join(PUBLIC_AUDIO_DIR, audioFileName);
  await synthesizeSpeech(voiceoverText, audioPath, voiceOverride);
  const durationSeconds =
    (await getAudioDurationInSeconds(audioPath)) + SCENE_PADDING_SECONDS;
  return {
    audioFileName,
    durationInFrames: Math.round(durationSeconds * config.fps),
  };
}

export async function generateSceneIllustration(
  index: number,
  prompt: string,
  previousSceneUrl?: string,
): Promise<{ imageFileName: string; resultUrl: string }> {
  const imageFileName = `scene-${index}.png`;
  const resultUrl = await generateSceneImage({
    prompt,
    outFile: path.join(PUBLIC_IMAGES_DIR, imageFileName),
    previousSceneUrl,
  });
  return { imageFileName, resultUrl };
}

/**
 * Выбирает случайный трек из assets/music и копирует его в public/music,
 * откуда его прочитает Remotion. Если библиотека пуста — видео без музыки.
 */
export async function pickMusic(): Promise<string | undefined> {
  let files: string[];
  try {
    files = await readdir(MUSIC_LIBRARY_DIR);
  } catch {
    return undefined;
  }
  const tracks = files.filter((f) =>
    AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );
  if (tracks.length === 0) return undefined;

  const chosen = tracks[Math.floor(Math.random() * tracks.length)];
  await copyFile(
    path.join(MUSIC_LIBRARY_DIR, chosen),
    path.join(PUBLIC_MUSIC_DIR, chosen),
  );
  return chosen;
}

export async function writeVideoData(videoData: VideoData): Promise<void> {
  await writeFile(DATA_FILE, JSON.stringify(videoData, null, 2), "utf-8");
}
