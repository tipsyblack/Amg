import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Scene, VideoData } from "../types";
import {
  buildImagePrompt,
  buildOutro,
  sceneWithCharacter,
  ensureDirs,
  sceneClip,
  generateSceneAudio,
  generateSceneIllustration,
  PUBLIC_AUDIO_DIR,
  fitToBudget,
  pickMusic,
  writeVideoData,
} from "./assets";
import { config } from "./config";
import { generateScriptAudio } from "./scriptAudio";
import { generateDescription } from "./generateDescription";
import {
  librarySceneIndexes,
  mascotSceneIndexes,
  readyClipIds,
} from "./clipLibrary";
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
  // Платные генерации — по счётчику /clips. Библиотечные клипы бесплатны и
  // идут независимо от него, туда же, где и так появляется маскот.
  const paid = new Set(
    clipSceneIndexes(script.scenes.length, config.clipScenes),
  );
  const fromLibrary = new Set(librarySceneIndexes(script.scenes.length));
  // Сцены без карточки: маскот во весь рост на белом. Иллюстрация им не
  // нужна — рисовать её было бы и тратой денег, и путаницей на согласовании.
  const mascotScenes = new Set(
    mascotSceneIndexes(script.scenes.length, config.mascotScenes),
  );
  // Что уже готово в библиотеке маскота и что из него уже занято в этом
  // ролике: два раза подряд один и тот же жест выглядит как заевшая плёнка.
  const libraryReady = await readyClipIds();
  const usedLibraryClips = new Set<string>();

  // Одно чтение на весь сценарий: синтезатор ведёт интонацию насквозь, а не
  // читает каждую сцену как отдельное предложение. Не вышло (нет таймингов —
  // через прокси Kie.ai их не бывает) — озвучиваем посценно, как раньше.
  let wholeAudio;
  try {
    wholeAudio = await generateScriptAudio(
      script.scenes.map((scene) => scene.voiceoverText),
      PUBLIC_AUDIO_DIR,
    );
    if (wholeAudio) {
      console.log(`Озвучка одним чтением, разрезана на ${wholeAudio.length} сцен`);
    } else {
      console.log("Таймингов слов нет — озвучиваю посценно");
    }
  } catch (error) {
    console.warn(
      `Единая озвучка не получилась (${
        error instanceof Error ? error.message : String(error)
      }) — озвучиваю посценно`,
    );
  }

  for (let i = 0; i < script.scenes.length; i++) {
    const scriptScene = script.scenes[i];
    console.log(`Сцена ${i + 1} из ${script.scenes.length}: ${scriptScene.caption}`);

    const { audioFileName, durationInFrames, words } =
      wholeAudio?.[i] ??
      (await generateSceneAudio(i, scriptScene.voiceoverText));

    const mascotOnly = mascotScenes.has(i);
    const withCharacter = sceneWithCharacter(i, script.scenes.length);
    const illustration = mascotOnly
      ? undefined
      : await generateSceneIllustration(
          i,
          buildImagePrompt(scriptScene, undefined, withCharacter),
          previousSceneUrl,
          undefined,
          withCharacter,
        );
    if (illustration) previousSceneUrl = illustration.resultUrl;
    if (mascotOnly) console.log(`Сцена ${i + 1}: маскот во весь кадр, без карточки`);

    // Вторая иллюстрация сцены: рисуется от первой, чтобы стиль не разошёлся —
    // они видны почти одновременно, и расхождение здесь заметнее, чем между
    // сценами. Не получилась — сцена остаётся с одной картинкой.
    let swap: { fileName: string; width?: number; height?: number } | undefined;
    if (illustration && scriptScene.swap?.scene) {
      try {
        const second = await generateSceneIllustration(
          i,
          buildImagePrompt(
            { ...scriptScene, voiceoverText: scriptScene.swap.scene },
            undefined,
            false,
          ),
          illustration.resultUrl,
          undefined,
          false,
          "swap",
        );
        swap = {
          fileName: second.imageFileName,
          width: second.imageWidth,
          height: second.imageHeight,
        };
        previousSceneUrl = second.resultUrl;
        console.log(`Сцена ${i + 1}: вторая картинка — ${scriptScene.swap.scene}`);
      } catch (error) {
        console.warn(
          `Сцена ${i + 1}: вторая картинка не вышла — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Оживление кадра: клип делается из только что нарисованной картинки, она
    // идёт его первым кадром. Ссылку берём ту, что вернул Kie.ai — вход он
    // принимает только по URL, а локальный файл ему не отдать.
    // Клип живёт внутри карточки — сцене без неё он не нужен.
    const wantsClip = !mascotOnly && (paid.has(i) || fromLibrary.has(i));
    const clip = wantsClip
      ? await sceneClip({
          index: i,
          total: script.scenes.length,
          voiceoverText: scriptScene.voiceoverText,
          imageUrl: illustration!.resultUrl,
          ready: libraryReady,
          used: usedLibraryClips,
          // Сцена попала сюда только из-за библиотеки — платить за неё не
          // договаривались.
          source: paid.has(i) ? undefined : "library",
        })
      : undefined;
    if (clip?.libraryId) usedLibraryClips.add(clip.libraryId);
    if (paid.has(i) && !clip) {
      console.warn(`Сцена ${i + 1} осталась картинкой: клип не сгенерировался`);
    } else if (clip) {
      console.log(
        `Сцена ${i + 1}: клип ${
          clip.source === "library" ? "из библиотеки" : "сгенерирован"
        }`,
      );
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
      imageFileName: illustration?.imageFileName,
      imageWidth: illustration?.imageWidth,
      imageHeight: illustration?.imageHeight,
      swapImageFileName: swap?.fileName,
      swapImageWidth: swap?.width,
      swapImageHeight: swap?.height,
      // Момент смены картинки — по тому же правилу, что и появление объекта:
      // ищем слово реплики в таймингах озвучки. Нет второй картинки — нет и
      // момента, иначе в данные попало бы число, за которым ничего не стоит.
      swapStartMs: swap
        ? overlayStartMs(
            words ?? [],
            scriptScene.swap?.word,
            (durationInFrames / config.fps) * 1000,
          )
        : undefined,
      mascotOnly: mascotOnly || undefined,
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
