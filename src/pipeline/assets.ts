import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Scene, VideoData } from "../types";
import { getAudioDurationInSeconds } from "./audioDuration";
import { config } from "./config";
import {
  generateSceneImage,
  RUSSIAN_TEXT_RULE,
  STYLE_PROMPT,
} from "./generateImage";
import { synthesizeSpeech, type TtsProvider } from "./generateVoiceover";
import { getImageSize } from "./imageDimensions";

export const PUBLIC_AUDIO_DIR = path.resolve("public/audio");
export const PUBLIC_IMAGES_DIR = path.resolve("public/images");
export const PUBLIC_MUSIC_DIR = path.resolve("public/music");
export const MUSIC_LIBRARY_DIR = path.resolve("assets/music");
export const DATA_FILE = path.resolve("data/video-data.json");

// Небольшой запас после конца озвучки, чтобы подпись не исчезала мгновенно.
const SCENE_PADDING_SECONDS = 0.4;
// До какого значения запас можно урезать, если ролик не влезает в лимит.
const MIN_SCENE_PADDING_SECONDS = 0.12;

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
  // Правило про язык надписей идёт после заметок из референса: те могут
  // упоминать английский текст (в референсе он есть), и требование русского
  // должно быть последним словом.
  return (
    `${STYLE_PROMPT}${styleAddition}` +
    `\n\nСцена: ${scene.caption}. Контекст: ${scene.voiceoverText}` +
    `\n\n${RUSSIAN_TEXT_RULE}`
  );
}

export async function generateSceneAudio(
  index: number,
  voiceoverText: string,
  voiceOverride?: string,
  modelOverride?: string,
  providerOverride?: TtsProvider,
): Promise<{ audioFileName: string; durationInFrames: number }> {
  const audioFileName = `scene-${index}.mp3`;
  const audioPath = path.join(PUBLIC_AUDIO_DIR, audioFileName);
  await synthesizeSpeech(
    voiceoverText,
    audioPath,
    voiceOverride,
    modelOverride,
    providerOverride,
  );
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
  modelKey?: string,
): Promise<{
  imageFileName: string;
  resultUrl: string;
  imageWidth?: number;
  imageHeight?: number;
}> {
  const imageFileName = `scene-${index}.png`;
  const outFile = path.join(PUBLIC_IMAGES_DIR, imageFileName);
  const resultUrl = await generateSceneImage({
    prompt,
    outFile,
    previousSceneUrl,
    modelKey,
  });
  const size = await getImageSize(outFile);
  return {
    imageFileName,
    resultUrl,
    imageWidth: size?.width,
    imageHeight: size?.height,
  };
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

/**
 * Подгоняет ролик под лимит длины: сначала урезает паузы после реплик — это
 * незаметно, — и сообщает, сколько осталось лишнего, если пауз не хватило.
 * Сцены не выбрасываем: в последней призыв к действию, а в остальных сюжет.
 */
export function fitToBudget(scenes: Scene[]): {
  scenes: Scene[];
  totalSeconds: number;
  overBudgetSeconds: number;
} {
  const budgetFrames = Math.round(config.maxVideoSeconds * config.fps);
  const totalFrames = scenes.reduce((sum, s) => sum + s.durationInFrames, 0);

  if (totalFrames <= budgetFrames) {
    return {
      scenes,
      totalSeconds: totalFrames / config.fps,
      overBudgetSeconds: 0,
    };
  }

  const shavablePerScene = Math.round(
    (SCENE_PADDING_SECONDS - MIN_SCENE_PADDING_SECONDS) * config.fps,
  );
  const needed = totalFrames - budgetFrames;
  const shavePerScene = Math.min(
    shavablePerScene,
    Math.ceil(needed / scenes.length),
  );

  const trimmed = scenes.map((scene) => ({
    ...scene,
    durationInFrames: Math.max(scene.durationInFrames - shavePerScene, 1),
  }));
  const trimmedTotal = trimmed.reduce((sum, s) => sum + s.durationInFrames, 0);

  return {
    scenes: trimmed,
    totalSeconds: trimmedTotal / config.fps,
    overBudgetSeconds: Math.max(trimmedTotal - budgetFrames, 0) / config.fps,
  };
}

export async function writeVideoData(videoData: VideoData): Promise<void> {
  await writeFile(DATA_FILE, JSON.stringify(videoData, null, 2), "utf-8");
}
