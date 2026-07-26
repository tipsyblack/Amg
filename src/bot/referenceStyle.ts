import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../pipeline/config";

const execFileAsync = promisify(execFile);

const FRAME_COUNT = 5;

const VISION_PROMPT = `Перед тобой кадры из видеоролика-референса. Опиши его
визуальный стиль как инструкцию для модели генерации изображений: цветовая
палитра, характер контура, манера отрисовки, фон, композиция, настроение.
4-6 предложений, без вступлений и выводов — только сама инструкция.

Про надписи: если в кадрах есть текст, описывай только его оформление
(насколько крупный, где расположен, какой по характеру шрифт) — но не
переписывай сами слова и не приводи английских примеров. В наших роликах
надписи всегда на русском языке.`;

async function assertFfmpegInstalled(): Promise<void> {
  try {
    await execFileAsync("ffprobe", ["-version"]);
  } catch {
    throw new Error(
      "На сервере не установлен ffmpeg (нужен для разбора референса). " +
        "Выполните на сервере: sudo apt install -y ffmpeg — и повторите.",
    );
  }
}

async function videoDurationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Не удалось определить длительность видео (ffprobe)");
  }
  return duration;
}

/**
 * Нарезает несколько кадров из видео и просит vision-модель через OpenRouter
 * описать стиль. Возвращает текст-инструкцию для промпта генерации картинок.
 */
export async function extractStyleNotes(videoFile: string): Promise<string> {
  await assertFfmpegInstalled();
  const duration = await videoDurationSeconds(videoFile);
  const workDir = await mkdtemp(path.join(tmpdir(), "amg-ref-"));

  try {
    const frames: string[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const timestamp = (duration * (i + 0.5)) / FRAME_COUNT;
      const framePath = path.join(workDir, `frame-${i}.jpg`);
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        timestamp.toFixed(2),
        "-i",
        videoFile,
        "-frames:v",
        "1",
        "-vf",
        "scale=512:-1",
        "-q:v",
        "5",
        framePath,
      ]);
      const image = await readFile(framePath);
      frames.push(`data:image/jpeg;base64,${image.toString("base64")}`);
    }

    const content: Array<Record<string, unknown>> = [
      { type: "text", text: VISION_PROMPT },
      ...frames.map((url) => ({ type: "image_url", image_url: { url } })),
    ];

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.openRouterModel,
          messages: [{ role: "user", content }],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenRouter (разбор референса) вернул ошибку ${response.status}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const notes = data.choices?.[0]?.message?.content?.trim();
    if (!notes) {
      throw new Error("Vision-модель не вернула описание стиля");
    }
    return notes;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
