import type { Scene, VideoData } from "../types";
import {
  buildImagePrompt,
  ensureDirs,
  generateSceneAudio,
  generateSceneIllustration,
  fitToBudget,
  pickMusic,
  writeVideoData,
} from "./assets";
import { config } from "./config";
import { generateCheckedScript } from "./generateScript";
import {
  generateSceneOverlay,
  overlayAnchor,
  OVERLAY_WIDTH_PERCENT,
} from "./generateOverlay";
import { overlayStartMs } from "./wordTimings";

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

  for (let i = 0; i < script.scenes.length; i++) {
    const scriptScene = script.scenes[i];
    console.log(`Сцена ${i + 1} из ${script.scenes.length}: ${scriptScene.caption}`);

    const { audioFileName, durationInFrames, words } = await generateSceneAudio(
      i,
      scriptScene.voiceoverText,
    );

    const illustration = await generateSceneIllustration(
      i,
      buildImagePrompt(scriptScene),
      previousSceneUrl,
    );
    previousSceneUrl = illustration.resultUrl;

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
      durationInFrames,
      words,
      overlay,
    });
  }

  const videoData: VideoData = {
    title: script.title,
    fps: config.fps,
    width: config.width,
    height: config.height,
    musicFileName: await pickMusic(),
    sfxEnabled: true,
    scenes: fitToBudget(scenes).scenes,
  };

  await writeVideoData(videoData);
  return videoData;
}
