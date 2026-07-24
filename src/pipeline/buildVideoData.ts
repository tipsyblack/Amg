import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Scene, VideoData } from "../types";
import { getAudioDurationInSeconds } from "./audioDuration";
import { config } from "./config";
import { generateScript } from "./generateScript";
import { generateSceneImage, STYLE_PROMPT } from "./generateImage";
import { synthesizeSpeech } from "./generateVoiceover";

const PUBLIC_AUDIO_DIR = path.resolve("public/audio");
const PUBLIC_IMAGES_DIR = path.resolve("public/images");
const DATA_FILE = path.resolve("data/video-data.json");

// Небольшой запас после конца озвучки, чтобы подпись не исчезала мгновенно.
const SCENE_PADDING_SECONDS = 0.4;

export async function buildVideoData(brief: string): Promise<VideoData> {
  await mkdir(PUBLIC_AUDIO_DIR, { recursive: true });
  await mkdir(PUBLIC_IMAGES_DIR, { recursive: true });
  await mkdir(path.dirname(DATA_FILE), { recursive: true });

  const script = await generateScript(brief);

  const scenes: Scene[] = [];
  // Data URI предыдущей картинки передаётся следующей генерации как
  // референс — так персонаж и стиль держатся из сцены в сцену.
  let previousImageDataUri: string | undefined;

  for (let i = 0; i < script.scenes.length; i++) {
    const scriptScene = script.scenes[i];
    const audioFileName = `scene-${i}.mp3`;
    const audioPath = path.join(PUBLIC_AUDIO_DIR, audioFileName);

    await synthesizeSpeech(scriptScene.voiceoverText, audioPath);
    const durationSeconds =
      (await getAudioDurationInSeconds(audioPath)) + SCENE_PADDING_SECONDS;

    const imageFileName = `scene-${i}.png`;
    const imagePrompt = `${STYLE_PROMPT}\n\nСцена: ${scriptScene.caption}. Контекст: ${scriptScene.voiceoverText}`;
    const imageBuffer = await generateSceneImage({
      prompt: imagePrompt,
      previousSceneDataUri: previousImageDataUri,
    });
    await writeFile(path.join(PUBLIC_IMAGES_DIR, imageFileName), imageBuffer);
    previousImageDataUri = `data:image/png;base64,${imageBuffer.toString("base64")}`;

    scenes.push({
      caption: scriptScene.caption,
      voiceoverText: scriptScene.voiceoverText,
      audioFileName,
      imageFileName,
      durationInFrames: Math.round(durationSeconds * config.fps),
    });
  }

  const videoData: VideoData = {
    title: script.title,
    fps: config.fps,
    width: config.width,
    height: config.height,
    scenes,
  };

  await writeFile(DATA_FILE, JSON.stringify(videoData, null, 2), "utf-8");
  return videoData;
}
