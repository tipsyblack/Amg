import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Scene, VideoData } from "../types";
import { getAudioDurationInSeconds } from "./audioDuration";
import { config } from "./config";
import { generateScript } from "./generateScript";
import { synthesizeSpeech } from "./generateVoiceover";

const PUBLIC_AUDIO_DIR = path.resolve("public/audio");
const DATA_FILE = path.resolve("data/video-data.json");

// Небольшой запас после конца озвучки, чтобы подпись не исчезала мгновенно.
const SCENE_PADDING_SECONDS = 0.4;

export async function buildVideoData(brief: string): Promise<VideoData> {
  await mkdir(PUBLIC_AUDIO_DIR, { recursive: true });
  await mkdir(path.dirname(DATA_FILE), { recursive: true });

  const script = await generateScript(brief);

  const scenes: Scene[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scriptScene = script.scenes[i];
    const audioFileName = `scene-${i}.mp3`;
    const audioPath = path.join(PUBLIC_AUDIO_DIR, audioFileName);

    await synthesizeSpeech(scriptScene.voiceoverText, audioPath);
    const durationSeconds =
      (await getAudioDurationInSeconds(audioPath)) + SCENE_PADDING_SECONDS;

    scenes.push({
      caption: scriptScene.caption,
      voiceoverText: scriptScene.voiceoverText,
      audioFileName,
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
