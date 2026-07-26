import type { Scene, VideoData } from "../types";
import {
  buildImagePrompt,
  ensureDirs,
  generateSceneAudio,
  generateSceneIllustration,
  pickMusic,
  writeVideoData,
} from "./assets";
import { config } from "./config";
import { generateScript } from "./generateScript";

export async function buildVideoData(brief: string): Promise<VideoData> {
  await ensureDirs();

  const script = await generateScript(brief);

  const scenes: Scene[] = [];
  // Ссылка на картинку предыдущей сцены передаётся следующей генерации как
  // референс — так окружение и палитра держатся из сцены в сцену.
  let previousSceneUrl: string | undefined;

  for (let i = 0; i < script.scenes.length; i++) {
    const scriptScene = script.scenes[i];
    console.log(`Сцена ${i + 1} из ${script.scenes.length}: ${scriptScene.caption}`);

    const { audioFileName, durationInFrames } = await generateSceneAudio(
      i,
      scriptScene.voiceoverText,
    );

    const { imageFileName, resultUrl } = await generateSceneIllustration(
      i,
      buildImagePrompt(scriptScene),
      previousSceneUrl,
    );
    previousSceneUrl = resultUrl;

    scenes.push({
      caption: scriptScene.caption,
      voiceoverText: scriptScene.voiceoverText,
      audioFileName,
      imageFileName,
      durationInFrames,
    });
  }

  const videoData: VideoData = {
    title: script.title,
    fps: config.fps,
    width: config.width,
    height: config.height,
    musicFileName: await pickMusic(),
    scenes,
  };

  await writeVideoData(videoData);
  return videoData;
}
