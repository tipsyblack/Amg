import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import {
  buildImagePrompt,
  ensureDirs,
  generateSceneAudio,
  generateSceneIllustration,
  pickMusic,
  writeVideoData,
} from "../pipeline/assets";
import { config } from "../pipeline/config";
import { generateScript } from "../pipeline/generateScript";
import type { Scene, VideoData } from "../types";
import { downloadDriveFile } from "./drive";
import { extractStyleNotes } from "./referenceStyle";
import { getSession, resetSession, updateSession } from "./state";

const execFileAsync = promisify(execFile);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error(
    "Отсутствует TELEGRAM_BOT_TOKEN в .env — создайте бота у @BotFather " +
      "и впишите токен.",
  );
}

const bot = new Bot(token);

// Версия кода, на которой работает бот — показывается в /start, чтобы было
// видно, доехал ли свежий деплой.
let botVersion = "неизвестна";
try {
  const { stdout } = await promisify(execFile)("git", [
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  botVersion = stdout.trim();
} catch {
  // не в git-репозитории — не критично
}

// Необязательное ограничение "только мой чат": если переменная пуста, бот
// открыт всем, кто его найдёт (осознанное решение для личного использования).
const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
bot.use(async (ctx, next) => {
  if (allowedChatId && String(ctx.chat?.id) !== allowedChatId) return;
  await next();
});

// Генерация тяжёлая и одна на весь процесс: пока идёт — новые не начинаем.
let generationRunning = false;

async function withGeneration(
  ctx: Context,
  chatId: number,
  task: () => Promise<void>,
): Promise<void> {
  if (generationRunning) {
    await ctx.reply("Уже идёт другая генерация — дождитесь её окончания.");
    return;
  }
  generationRunning = true;
  updateSession(chatId, { step: "busy" });
  try {
    await task();
  } catch (error) {
    console.error(error);
    await ctx.reply(
      `Ошибка: ${error instanceof Error ? error.message : String(error)}\n\n` +
        "Начать заново — /new",
    );
    resetSession(chatId);
  } finally {
    generationRunning = false;
  }
}

function formatScript(script: {
  title: string;
  scenes: { caption: string; voiceoverText: string }[];
}): string {
  const scenes = script.scenes
    .map(
      (scene, i) =>
        `${i + 1}. ${scene.caption}\n   🎙 ${scene.voiceoverText}`,
    )
    .join("\n\n");
  return `📋 «${script.title}»\n\n${scenes}`;
}

const scriptKeyboard = new InlineKeyboard()
  .text("✅ Ок, рисуем", "script_ok")
  .text("✏️ Правки", "script_edit");

const imagesKeyboard = new InlineKeyboard()
  .text("✅ Собирать видео", "images_ok")
  .text("🔄 Перегенерировать сцену", "images_regen");

async function runScriptStep(
  ctx: Context,
  chatId: number,
  feedback?: string,
): Promise<void> {
  await withGeneration(ctx, chatId, async () => {
    const session = getSession(chatId);
    await ctx.reply(feedback ? "Переписываю сценарий…" : "Пишу сценарий…");
    const script = await generateScript(
      session.brief ?? "",
      feedback && session.script
        ? { previousScript: session.script, feedback }
        : undefined,
    );
    updateSession(chatId, { step: "idle", script });
    await ctx.reply(formatScript(script), { reply_markup: scriptKeyboard });
  });
}

async function runImagesStep(ctx: Context, chatId: number): Promise<void> {
  await withGeneration(ctx, chatId, async () => {
    await ensureDirs();
    const session = getSession(chatId);
    const script = session.script;
    if (!script) throw new Error("Сценарий потерялся — начните заново: /new");

    const images = [...(session.images ?? [])];
    let previousSceneUrl: string | undefined;

    for (let i = 0; i < script.scenes.length; i++) {
      await ctx.reply(`🎨 Сцена ${i + 1} из ${script.scenes.length}…`);
      const { imageFileName, resultUrl } = await generateSceneIllustration(
        i,
        buildImagePrompt(script.scenes[i], session.styleNotes),
        previousSceneUrl,
      );
      images[i] = { imageFileName, resultUrl };
      previousSceneUrl = resultUrl;
      await ctx.replyWithPhoto(
        new InputFile(path.resolve("public/images", imageFileName)),
        { caption: `Сцена ${i + 1}: ${script.scenes[i].caption}` },
      );
    }

    updateSession(chatId, { step: "idle", images });
    await ctx.reply("Как картинки?", { reply_markup: imagesKeyboard });
  });
}

async function regenerateScene(
  ctx: Context,
  chatId: number,
  index: number,
): Promise<void> {
  await withGeneration(ctx, chatId, async () => {
    const session = getSession(chatId);
    const script = session.script;
    const images = [...(session.images ?? [])];
    if (!script || !images.length) {
      throw new Error("Нет данных сцены — начните заново: /new");
    }

    await ctx.reply(`🎨 Перегенерирую сцену ${index + 1}…`);
    const { imageFileName, resultUrl } = await generateSceneIllustration(
      index,
      buildImagePrompt(script.scenes[index], session.styleNotes),
      images[index - 1]?.resultUrl,
    );
    images[index] = { imageFileName, resultUrl };
    updateSession(chatId, { step: "idle", images });

    await ctx.replyWithPhoto(
      new InputFile(path.resolve("public/images", imageFileName)),
      { caption: `Сцена ${index + 1}: ${script.scenes[index].caption}` },
    );
    await ctx.reply("Как теперь?", { reply_markup: imagesKeyboard });
  });
}

async function runAssembleStep(ctx: Context, chatId: number): Promise<void> {
  await withGeneration(ctx, chatId, async () => {
    const session = getSession(chatId);
    const script = session.script;
    const images = session.images;
    if (!script || !images) {
      throw new Error("Нет данных для сборки — начните заново: /new");
    }

    const scenes: Scene[] = [];
    for (let i = 0; i < script.scenes.length; i++) {
      await ctx.reply(`🎙 Озвучка ${i + 1} из ${script.scenes.length}…`);
      const { audioFileName, durationInFrames } = await generateSceneAudio(
        i,
        script.scenes[i].voiceoverText,
      );
      scenes.push({
        caption: script.scenes[i].caption,
        voiceoverText: script.scenes[i].voiceoverText,
        audioFileName,
        imageFileName: images[i].imageFileName,
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

    await ctx.reply("🎬 Собираю видео — это займёт несколько минут…");
    await ctx.replyWithChatAction("upload_video");
    await execFileAsync(
      "npx",
      [
        "remotion",
        "render",
        "src/remotion/index.ts",
        "VideoComposition",
        "out/video.mp4",
        "--props=data/video-data.json",
      ],
      { timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
    );

    await ctx.replyWithVideo(new InputFile(path.resolve("out/video.mp4")), {
      caption: `«${script.title}» готово. Новый ролик — /new`,
    });
    resetSession(chatId);
  });
}

bot.command(["start", "help"], async (ctx) => {
  await ctx.reply(
    "Бот собирает короткие вертикальные ролики с Шамилем.\n\n" +
      "/new — начать новый ролик\n" +
      "/cancel — сбросить текущий диалог\n" +
      "/deploy — обновить бота с GitHub прямо сейчас\n\n" +
      "Порядок: бриф → референс (по желанию) → сценарий с правками → " +
      "картинки с перегенерацией → озвучка и сборка.\n\n" +
      `Версия кода: ${botVersion}`,
  );
});

bot.command("deploy", async (ctx) => {
  if (generationRunning) {
    await ctx.reply(
      "Идёт генерация — обновлюсь, когда закончится. Попробуйте /deploy позже.",
    );
    return;
  }
  await ctx.reply(
    "Обновляюсь с GitHub… Если были изменения, перезапущусь — снова буду " +
      "на связи через минуту-другую. Проверить версию — /start",
  );
  const script = path.resolve("scripts/auto-deploy.sh");
  try {
    // Отдельный transient-юнит systemd: переживает перезапуск самого бота,
    // который auto-deploy делает в конце.
    await execFileAsync("systemd-run", [
      "--collect",
      `--unit=amg-manual-deploy-${Date.now()}`,
      "/bin/bash",
      script,
    ]);
  } catch {
    // Нет systemd (например, запуск через npm run bot вручную) — обычный
    // отвязанный процесс.
    const child = spawn("/bin/bash", [script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
});

bot.command("cancel", async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply("Сброшено. Новый ролик — /new");
});

bot.command("new", async (ctx) => {
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  updateSession(ctx.chat.id, {
    step: "awaiting_brief",
    brief: undefined,
    styleNotes: undefined,
    script: undefined,
    images: undefined,
  });
  await ctx.reply(
    "Опишите ролик: что за продукт, для кого, какой посыл?\n\n" +
      "Например: «Продукт: доступ к нейросетям в Телеграм. Для кого: " +
      "новички. Посыл: нейросети — это просто.»",
  );
});

bot.callbackQuery("script_ok", async (ctx) => {
  await ctx.answerCallbackQuery();
  await runImagesStep(ctx, ctx.chat!.id);
});

bot.callbackQuery("script_edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  updateSession(ctx.chat!.id, { step: "awaiting_script_feedback" });
  await ctx.reply("Что поправить в сценарии? Напишите замечания одним сообщением.");
});

bot.callbackQuery("images_ok", async (ctx) => {
  await ctx.answerCallbackQuery();
  await runAssembleStep(ctx, ctx.chat!.id);
});

bot.callbackQuery("images_regen", async (ctx) => {
  await ctx.answerCallbackQuery();
  updateSession(ctx.chat!.id, { step: "awaiting_scene_number" });
  await ctx.reply("Какую сцену перегенерировать? Пришлите номер.");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const session = getSession(chatId);

  switch (session.step) {
    case "awaiting_brief": {
      updateSession(chatId, { step: "awaiting_reference", brief: text });
      await ctx.reply(
        "Есть референс-видео для стиля? Пришлите ссылку на Google Drive " +
          "(доступ «всем, у кого есть ссылка»), либо /skip чтобы пропустить.",
      );
      return;
    }

    case "awaiting_reference": {
      if (text === "/skip") {
        await runScriptStep(ctx, chatId);
        return;
      }
      let referenceParsed = false;
      await withGeneration(ctx, chatId, async () => {
        await ctx.reply("Скачиваю референс и разбираю стиль…");
        const workDir = await mkdtemp(path.join(tmpdir(), "amg-drive-"));
        try {
          const videoFile = path.join(workDir, "reference.mp4");
          await downloadDriveFile(text, videoFile);
          const styleNotes = await extractStyleNotes(videoFile);
          updateSession(chatId, { styleNotes });
          await ctx.reply(`Стиль из референса:\n\n${styleNotes}`);
          referenceParsed = true;
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      });
      // Если разбор упал, withGeneration уже сообщил об ошибке и сбросил
      // сессию — сценарий не пишем.
      if (referenceParsed) {
        await runScriptStep(ctx, chatId);
      }
      return;
    }

    case "awaiting_script_feedback": {
      await runScriptStep(ctx, chatId, text);
      return;
    }

    case "awaiting_scene_number": {
      const sceneCount = session.script?.scenes.length ?? 0;
      const index = Number(text) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= sceneCount) {
        await ctx.reply(`Пришлите число от 1 до ${sceneCount}.`);
        return;
      }
      await regenerateScene(ctx, chatId, index);
      return;
    }

    case "busy": {
      await ctx.reply("Идёт генерация, подождите…");
      return;
    }

    default: {
      await ctx.reply("Начать новый ролик — /new");
    }
  }
});

bot.catch((err) => {
  console.error("Ошибка бота:", err.error);
});

console.log("Бот запущен (long polling)");
bot.start();
