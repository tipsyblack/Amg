import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Scene, VideoData } from "../types";
import {
  buildImagePrompt,
  buildOutro,
  sceneWithCharacter,
  ensureDirs,
  generateSceneAnimation,
  generateSceneAudio,
  generateSceneIllustration,
  fitToBudget,
  pickMusic,
  writeVideoData,
} from "./assets";
import { config } from "./config";
import { generateDescription } from "./generateDescription";
import { clipSceneIndexes } from "./generateClip";
import { generateCheckedScript } from "./generateScript";
import {
  generateSceneOverlay,
  overlayAnchor,
  OVERLAY_WIDTH_PERCENT,
} from "./generateOverlay";
import { overlayStartMs } from "./wordTimings";

// Текст описания под пост — рядом с готовым роликом.
const DESCRIPTION_FILE = path.resolve("out/description.txt");

export async function buildVideoData(brief: string): Promise<VideoData> {
  await ensureDirs();

  const { script, fixes, webSearchUnavailable } =
    await generateCheckedScript(brief);
  for (const fix of fixes) console.log(`Сценарий переписан: ${fix}`);
  if (webSearchUnavailable) {
    console.log("Веб-поиск недоступен — сценарий написан без свежих данных");
  }

  const scenes: Scene[] = [];
  // Ссылка на картинку предыдущей сцены передаётся следующей генерации как
  // референс — так окружение и палитра держатся из сцены в сцену.
  let previousSceneUrl: string | undefined;
  // Какие сцены оживляем клипом. Считаем заранее: список зависит от общего
  // числа сцен, а решение нужно уже внутри цикла.
  const animated = new Set(
    clipSceneIndexes(script.scenes.length, config.clipScenes),
  );

  for (let i = 0; i < script.scenes.length; i++) {
    const scriptScene = script.scenes[i];
    console.log(`Сцена ${i + 1} из ${script.scenes.length}: ${scriptScene.caption}`);

    const { audioFileName, durationInFrames, words } = await generateSceneAudio(
      i,
      scriptScene.voiceoverText,
    );

    const withCharacter = sceneWithCharacter(i, script.scenes.length);
    const illustration = await generateSceneIllustration(
      i,
      buildImagePrompt(scriptScene, undefined, withCharacter),
      previousSceneUrl,
      undefined,
      withCharacter,
    );
    previousSceneUrl = illustration.resultUrl;

    // Оживление кадра: клип делается из только что нарисованной картинки, она
    // идёт его первым кадром. Ссылку берём ту, что вернул Kie.ai — вход он
    // принимает только по URL, а локальный файл ему не отдать.
    const clip = animated.has(i)
      ? await generateSceneAnimation(
          i,
          scriptScene.voiceoverText,
          illustration.resultUrl,
        )
      : undefined;
    if (animated.has(i) && !clip) {
      console.warn(`Сцена ${i + 1} осталась картинкой: клип не сгенерировался`);
    }

    // Появляющийся объект: рисуется отдельно и ложится поверх этой же
    // картинки. Не получился — сцена собирается без него, ролик не страдает.
    let overlay;
    if (scriptScene.overlay?.object) {
      try {
        const { fileName } = await generateSceneOverlay(
          i,
          scriptScene.overlay.object,
        );
        overlay = {
          fileName,
          anchor: overlayAnchor(i),
          widthPercent: OVERLAY_WIDTH_PERCENT,
          startMs: overlayStartMs(
            words ?? [],
            scriptScene.overlay.word,
            (durationInFrames / config.fps) * 1000,
          ),
        };
      } catch (error) {
        console.warn(
          `Объект для сцены ${i + 1} не получился: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    scenes.push({
      caption: scriptScene.caption,
      voiceoverText: scriptScene.voiceoverText,
      audioFileName,
      imageFileName: illustration.imageFileName,
      imageWidth: illustration.imageWidth,
      imageHeight: illustration.imageHeight,
      clipFileName: clip?.clipFileName,
      clipDurationInFrames: clip?.clipDurationInFrames,
      durationInFrames,
      words,
      overlay,
    });
  }

  const videoData: VideoData = {
    title: script.title,
    fps: config.fps,
    outro: buildOutro(),
    width: config.width,
    height: config.height,
    musicFileName: await pickMusic(),
    sfxEnabled: true,
    scenes: fitToBudget(scenes).scenes,
  };

  await writeVideoData(videoData);

  // Текст под пост кладём рядом с данными ролика: после npm run render его
  // можно взять из файла и вставить в описание публикации.
  try {
    const { description, fixed } = await generateDescription(script);
    await writeFile(DESCRIPTION_FILE, description, "utf-8");
    if (fixed) console.log(`Описание переписано: ${fixed}`);
    console.log(`Описание (${description.length} символов): ${DESCRIPTION_FILE}`);
  } catch (error) {
    console.warn(
      `Описание не получилось: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return videoData;
}
