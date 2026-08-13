import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Outro, Scene, VideoData } from "../types";
import { getAudioDurationInSeconds, getClipDurationInSeconds } from "./audioDuration";
import {
  clipRoleForScene,
  installLibraryClip,
  pickLibraryClip,
  PUBLIC_CLIPS_DIR,
} from "./clipLibrary";
import { config } from "./config";
import { generateSceneClip } from "./generateClip";
import {
  generateSceneImage,
  NO_TEXT_RULE,
  CHARACTER_PROMPT,
  NO_CHARACTER_PROMPT,
  STYLE_PROMPT,
} from "./generateImage";
import { synthesizeSpeech, type TtsProvider } from "./generateVoiceover";
import { getImageSize } from "./imageDimensions";
import { wordsForScene } from "./wordTimings";

export const PUBLIC_AUDIO_DIR = path.resolve("public/audio");
export const PUBLIC_IMAGES_DIR = path.resolve("public/images");
export const PUBLIC_OVERLAYS_DIR = path.resolve("public/overlays");
// Папка клипов живёт в clipLibrary — там же, где библиотека, которая в неё
// копирует. Реэкспорт, чтобы вызывающим не нужно было знать про два модуля.
export { PUBLIC_CLIPS_DIR };
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
  await mkdir(PUBLIC_OVERLAYS_DIR, { recursive: true });
  await mkdir(PUBLIC_CLIPS_DIR, { recursive: true });
  await mkdir(PUBLIC_MUSIC_DIR, { recursive: true });
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
}

/**
 * Нужен ли маскот в этой сцене.
 *
 * Раньше он был в каждой: эталон внешности прикладывался ко всем запросам, и
 * ролик выходил галереей поз одного персонажа — даже там, где сцена про
 * серверы или про космос. Держим его там, где он к месту: хук (лицо ролика) и
 * финал (призыв к действию — говорит именно маскот). Середина — про содержание
 * истории, и там он только отвлекает.
 *
 * CHARACTER_EVERY_SCENE=1 в .env возвращает прежнее поведение.
 */
export function sceneWithCharacter(index: number, total: number): boolean {
  if (config.characterEveryScene) return true;
  return index === 0 || index === total - 1;
}

/**
 * Описание брендовой концовки для рендера. Логотип подключается, только если
 * файл действительно лежит в public/brand: ссылка на отсутствующий файл роняет
 * рендер на последнем кадре, когда всё дорогое уже посчитано.
 */
export function buildOutro(): Outro | undefined {
  if (!config.brandName) return undefined;
  const logo = config.brandLogoFile;
  const logoExists =
    Boolean(logo) && existsSync(path.resolve("public/brand", logo));
  return {
    title: config.brandName,
    tagline: config.brandTagline || undefined,
    logoFileName: logoExists ? logo : undefined,
    durationInFrames: Math.max(
      Math.round(config.outroSeconds * config.fps),
      1,
    ),
  };
}

export function buildImagePrompt(
  scene: { caption: string; voiceoverText: string },
  styleNotes?: string,
  withCharacter = false,
): string {
  const styleAddition = styleNotes
    ? `\n\nДополнительные заметки о стиле из референса пользователя (учитывай их, не ломая описанный выше стиль и персонажа): ${styleNotes}`
    : "";
  // Запрет надписей идёт последним, после заметок из референса: те могут
  // упоминать текст в кадре (в референсе он есть), а запрет должен остаться
  // последним словом.
  //
  // Сцена описывается только текстом озвучки: подпись — это готовая фраза для
  // экрана, и, попав в промпт, она провоцирует модель эту фразу нарисовать.
  return (
    `${STYLE_PROMPT}${styleAddition}` +
    `\n\n${withCharacter ? CHARACTER_PROMPT : NO_CHARACTER_PROMPT}` +
    `\n\nЧто происходит в сцене: ${scene.voiceoverText}` +
    `\n\n${NO_TEXT_RULE}`
  );
}

export async function generateSceneAudio(
  index: number,
  voiceoverText: string,
  voiceOverride?: string,
  modelOverride?: string,
  providerOverride?: TtsProvider,
): Promise<{
  audioFileName: string;
  durationInFrames: number;
  words?: { text: string; startMs: number; endMs: number }[];
}> {
  const audioFileName = `scene-${index}.mp3`;
  const audioPath = path.join(PUBLIC_AUDIO_DIR, audioFileName);
  const { words } = await synthesizeSpeech(
    voiceoverText,
    audioPath,
    voiceOverride,
    modelOverride,
    providerOverride,
  );
  const speechSeconds = await getAudioDurationInSeconds(audioPath);
  const durationSeconds = speechSeconds + SCENE_PADDING_SECONDS;
  // Тайминги от провайдера точные; без них раскладываем слова по длительности
  // реплики — субтитры должны быть в любом случае.
  const timed = config.wordSubtitles
    ? wordsForScene(voiceoverText, speechSeconds, words)
    : [];
  return {
    audioFileName,
    durationInFrames: Math.round(durationSeconds * config.fps),
    words: timed.length > 0
      ? timed.map(({ text, startMs, endMs }) => ({ text, startMs, endMs }))
      : undefined,
  };
}

export async function generateSceneIllustration(
  index: number,
  prompt: string,
  previousSceneUrl?: string,
  modelKey?: string,
  withCharacter = false,
  // Вариант картинки внутри одной сцены. Нужен для второй иллюстрации, которая
  // сменяет первую посреди реплики: у неё тот же индекс сцены, но свой файл.
  variant?: string,
): Promise<{
  imageFileName: string;
  resultUrl: string;
  imageWidth?: number;
  imageHeight?: number;
}> {
  const imageFileName = variant
    ? `scene-${index}-${variant}.png`
    : `scene-${index}.png`;
  const outFile = path.join(PUBLIC_IMAGES_DIR, imageFileName);
  const resultUrl = await generateSceneImage({
    prompt,
    outFile,
    previousSceneUrl,
    modelKey,
    withCharacter,
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
 * Оживляет картинку сцены и возвращает поля для Scene. Ничего не бросает:
 * генерация клипа умеет не удаваться (см. generateSceneClip), и тогда сцена
 * просто остаётся картинкой.
 */
export async function generateSceneAnimation(
  index: number,
  voiceoverText: string,
  imageUrl: string,
  seconds: number = config.clipSeconds,
  modelKey?: string,
): Promise<
  { clipFileName: string; clipDurationInFrames: number } | undefined
> {
  const clip = await generateSceneClip(
    index,
    voiceoverText,
    imageUrl,
    seconds,
    modelKey,
  );
  if (!clip) return undefined;

  // Длину меряем у файла, а не берём из запроса: модели округляют
  // длительность по-своему, а по этому числу решается, с какого кадра
  // подмораживать последний кадр клипа.
  const actualSeconds = await getClipDurationInSeconds(
    path.join(PUBLIC_CLIPS_DIR, clip.clipFileName),
    seconds,
  );
  return {
    clipFileName: clip.clipFileName,
    clipDurationInFrames: Math.max(
      Math.round(actualSeconds * config.fps),
      1,
    ),
  };
}

export interface SceneClipResult {
  clipFileName: string;
  clipDurationInFrames: number;
  /** Откуда взялся клип — это видно в чате и попадает в лог. */
  source: "library" | "generated";
  /** Какой именно клип библиотеки, чтобы не повторить его в том же ролике. */
  libraryId?: string;
}

/**
 * Клип для сцены: сначала библиотека, потом — платная генерация.
 *
 * Порядок именно такой, потому что библиотечный клип уже оплачен и стоит ноль,
 * а оживление картинки сцены стоит примерно четверть доллара за каждую сцену
 * каждого ролика. CLIP_SOURCE меняет правило: library — только готовые,
 * generate — только свежие.
 *
 * Ничего не бросает: клип — украшение поверх уже готовой сцены, и ронять
 * из-за него ролик, где оплачены картинки и озвучка, нельзя.
 */
export async function sceneClip({
  index,
  total,
  voiceoverText,
  imageUrl,
  ready,
  used = new Set(),
  modelKey,
  source = config.clipSource,
}: {
  index: number;
  total: number;
  voiceoverText: string;
  imageUrl: string;
  ready: Set<string>;
  used?: Set<string>;
  modelKey?: string;
  source?: "auto" | "library" | "generate";
}): Promise<SceneClipResult | undefined> {
  if (source !== "generate") {
    const pick = pickLibraryClip(clipRoleForScene(index, total), ready, used);
    if (pick) {
      try {
        const installed = await installLibraryClip(pick);
        return { ...installed, source: "library", libraryId: pick.id };
      } catch (error) {
        console.warn(
          `Не удалось взять клип «${pick.title}» из библиотеки: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    if (source === "library") return undefined;
  }

  const generated = await generateSceneAnimation(
    index,
    voiceoverText,
    imageUrl,
    config.clipSeconds,
    modelKey,
  );
  return generated ? { ...generated, source: "generated" } : undefined;
}

export async function listMusicTracks(): Promise<string[]> {
  try {
    const files = await readdir(MUSIC_LIBRARY_DIR);
    return files.filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  } catch {
    return [];
  }
}

export async function ensureMusicLibraryDir(): Promise<void> {
  await mkdir(MUSIC_LIBRARY_DIR, { recursive: true });
}

export async function deleteMusicTrack(fileName: string): Promise<boolean> {
  // Имя приходит из чата — берём только базовое, чтобы нельзя было выйти
  // из папки библиотеки.
  const safe = path.basename(fileName);
  try {
    await rm(path.join(MUSIC_LIBRARY_DIR, safe));
    return true;
  } catch {
    return false;
  }
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
export function fitToBudget(
  scenes: Scene[],
  // Лимит длины можно задать на чат командой /length — тогда он приходит сюда,
  // а не берётся из .env.
  maxVideoSeconds: number = config.maxVideoSeconds,
): {
  scenes: Scene[];
  totalSeconds: number;
  overBudgetSeconds: number;
} {
  const budgetFrames = Math.round(maxVideoSeconds * config.fps);
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
