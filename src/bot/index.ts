import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import {
  buildTtsInput,
  synthesizeSpeech,
  TTS_MODEL_CANDIDATES,
} from "../pipeline/generateVoiceover";
import { probeKieTask } from "../pipeline/kie";
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

interface GenerationOptions {
  // callback_data кнопки "Повторить" в сообщении об ошибке. Наработанное
  // (сценарий, картинки, озвучки) при сбое сохраняется — повтор продолжает
  // с места падения.
  retryData?: string;
  // Куда вернуть диалог при сбое (по умолчанию idle).
  errorStep?: import("./state").Step;
  // Подсказка в сообщении об ошибке вместо стандартной.
  errorHint?: string;
}

async function withGeneration(
  ctx: Context,
  chatId: number,
  task: () => Promise<void>,
  options: GenerationOptions = {},
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
    updateSession(chatId, { step: options.errorStep ?? "idle" });
    const hint =
      options.errorHint ??
      (options.retryData
        ? "Наработанное сохранено — можно просто повторить кнопкой ниже."
        : "Начать заново — /new");
    await ctx.reply(
      `Ошибка: ${error instanceof Error ? error.message : String(error)}\n\n${hint}`,
      options.retryData
        ? {
            reply_markup: new InlineKeyboard().text(
              "🔁 Повторить",
              options.retryData,
            ),
          }
        : undefined,
    );
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
  await withGeneration(
    ctx,
    chatId,
    async () => {
      const session = getSession(chatId);
      await ctx.reply(feedback ? "Переписываю сценарий…" : "Пишу сценарий…");
      const script = await generateScript(
        session.brief ?? "",
        feedback && session.script
          ? { previousScript: session.script, feedback }
          : undefined,
      );
      // Новый сценарий делает старые картинки и озвучки неактуальными.
      updateSession(chatId, {
        step: "idle",
        script,
        images: undefined,
        audio: undefined,
      });
      await ctx.reply(formatScript(script), { reply_markup: scriptKeyboard });
    },
    { retryData: "retry_script" },
  );
}

async function runImagesStep(ctx: Context, chatId: number): Promise<void> {
  await withGeneration(
    ctx,
    chatId,
    async () => {
      await ensureDirs();
      const session = getSession(chatId);
      const script = session.script;
      if (!script) throw new Error("Сценарий потерялся — начните заново: /new");

      const images = [...(session.images ?? [])];
      let previousSceneUrl: string | undefined;

      for (let i = 0; i < script.scenes.length; i++) {
        // Уже сгенерированные при прошлой попытке сцены пропускаем.
        if (images[i]) {
          previousSceneUrl = images[i].resultUrl;
          continue;
        }
        await ctx.reply(`🎨 Сцена ${i + 1} из ${script.scenes.length}…`);
        const { imageFileName, resultUrl } = await generateSceneIllustration(
          i,
          buildImagePrompt(script.scenes[i], session.styleNotes),
          previousSceneUrl,
        );
        images[i] = { imageFileName, resultUrl };
        previousSceneUrl = resultUrl;
        updateSession(chatId, { images });
        await ctx.replyWithPhoto(
          new InputFile(path.resolve("public/images", imageFileName)),
          { caption: `Сцена ${i + 1}: ${script.scenes[i].caption}` },
        );
      }

      updateSession(chatId, { step: "idle", images });
      await ctx.reply("Как картинки?", { reply_markup: imagesKeyboard });
    },
    { retryData: "retry_images" },
  );
}

async function regenerateScene(
  ctx: Context,
  chatId: number,
  index: number,
): Promise<void> {
  await withGeneration(
    ctx,
    chatId,
    async () => {
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
    },
    { retryData: `regen_${index}` },
  );
}

async function runAssembleStep(ctx: Context, chatId: number): Promise<void> {
  await withGeneration(
    ctx,
    chatId,
    async () => {
    const session = getSession(chatId);
    const script = session.script;
    const images = session.images;
    if (!script || !images) {
      throw new Error("Нет данных для сборки — начните заново: /new");
    }

    const audio = [...(session.audio ?? [])];
    const scenes: Scene[] = [];
    for (let i = 0; i < script.scenes.length; i++) {
      // Озвученные при прошлой попытке сцены не переозвучиваем.
      if (!audio[i]) {
        await ctx.reply(`🎙 Озвучка ${i + 1} из ${script.scenes.length}…`);
        audio[i] = await generateSceneAudio(
          i,
          script.scenes[i].voiceoverText,
          session.voice,
          session.ttsModel,
        );
        updateSession(chatId, { audio });
      }
      scenes.push({
        caption: script.scenes[i].caption,
        voiceoverText: script.scenes[i].voiceoverText,
        audioFileName: audio[i].audioFileName,
        imageFileName: images[i].imageFileName,
        durationInFrames: audio[i].durationInFrames,
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
    },
    { retryData: "retry_assemble" },
  );
}

bot.command(["start", "help"], async (ctx) => {
  await ctx.reply(
    "Бот собирает короткие вертикальные ролики с Шамилем.\n\n" +
      "/new — начать новый ролик\n" +
      "/cancel — сбросить текущий диалог\n" +
      "/voice — посмотреть или сменить голос озвучки\n" +
      "/model — модель озвучки\n" +
      "/diag — проверить озвучку и найти рабочую модель\n" +
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

// Подбор голоса прямо из чата: /voice покажет текущий, /voice <id> поставит
// новый и сразу пришлёт пробную фразу, чтобы послушать.
const VOICE_SAMPLE_TEXT =
  "Ассаламу алейкум, дорогой! Слушай сюда: наша нейросеть всё сделает за тебя.";

bot.command("voice", async (ctx) => {
  const chatId = ctx.chat.id;
  const requested = ctx.match.trim();
  const current = getSession(chatId).voice ?? config.kieTtsVoice;

  if (!requested) {
    await ctx.reply(
      `Текущий голос: ${current}\n\n` +
        "Сменить: /voice <voice_id>\n" +
        "Нужен именно ID голоса из ElevenLabs (например, " +
        "21m00Tcm4TlvDq8ikWAM — это Rachel), а не имя: с именем Kie.ai " +
        "падает с internal error.\n\n" +
        "ID берутся в библиотеке голосов ElevenLabs или в кабинете Kie.ai. " +
        "После смены пришлю пробную фразу — послушайте, прежде чем собирать ролик.",
    );
    return;
  }

  await withGeneration(ctx, chatId, async () => {
    await ctx.reply(`Пробую голос ${requested}…`);
    const samplePath = path.resolve("out/voice-sample.mp3");
    await mkdir(path.dirname(samplePath), { recursive: true });
    await synthesizeSpeech(
      VOICE_SAMPLE_TEXT,
      samplePath,
      requested,
      getSession(chatId).ttsModel,
    );
    updateSession(chatId, { voice: requested, step: "idle" });
    await ctx.replyWithVoice(new InputFile(samplePath), {
      caption: `Голос ${requested} сохранён — будет использован для роликов.`,
    });
  });
});

bot.command("model", async (ctx) => {
  const chatId = ctx.chat.id;
  const requested = ctx.match.trim();
  if (!requested) {
    await ctx.reply(
      `Текущая модель озвучки: ${getSession(chatId).ttsModel ?? config.kieTtsModel}\n\n` +
        "Сменить: /model <слаг модели>\n" +
        "Найти рабочую автоматически: /diag",
    );
    return;
  }
  updateSession(chatId, { ttsModel: requested });
  await ctx.reply(
    `Модель озвучки: ${requested}. Проверить — /voice ${getSession(chatId).voice ?? config.kieTtsVoice}`,
  );
});

// Диагностика озвучки: перебирает модели-кандидаты с текущим голосом и
// показывает, что именно отвечает Kie.ai по каждой. Первую рабочую сохраняет.
bot.command("diag", async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  const voice = session.voice ?? config.kieTtsVoice;

  await withGeneration(ctx, chatId, async () => {
    await ctx.reply(
      `Проверяю озвучку.\nГолос: ${voice}\nМоделей к проверке: ${TTS_MODEL_CANDIDATES.length}\n` +
        "Каждая до 2 минут, подождите…",
    );

    const lines: string[] = [];
    let working: string | undefined;

    for (const model of TTS_MODEL_CANDIDATES) {
      const result = await probeKieTask({
        model,
        input: buildTtsInput("Проверка связи, раз, два, три.", voice),
      });
      lines.push(`${result.ok ? "✅" : "❌"} ${model}\n   ${result.detail}`);
      if (result.ok && !working) working = model;
    }

    let summary = lines.join("\n\n");
    if (working) {
      updateSession(chatId, { ttsModel: working, step: "idle" });
      summary +=
        `\n\nРабочая модель найдена и сохранена: ${working}\n` +
        "Можно возвращаться к сборке — кнопка «Повторить» выше.";
    } else {
      summary +=
        "\n\nНи одна модель не отработала. Скорее всего дело в голосе или " +
        "в балансе Kie.ai:\n" +
        "• проверьте кредиты в кабинете Kie.ai;\n" +
        `• попробуйте другой ID голоса: /voice <id> (текущий — ${voice});\n` +
        "• сверьте список моделей в кабинете и задайте вручную: /model <слаг>.";
    }
    await ctx.reply(summary);
  });
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
    audio: undefined,
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

// Кнопки "🔁 Повторить" из сообщений об ошибках.
bot.callbackQuery("retry_script", async (ctx) => {
  await ctx.answerCallbackQuery();
  await runScriptStep(ctx, ctx.chat!.id);
});

bot.callbackQuery("retry_images", async (ctx) => {
  await ctx.answerCallbackQuery();
  await runImagesStep(ctx, ctx.chat!.id);
});

bot.callbackQuery("retry_assemble", async (ctx) => {
  await ctx.answerCallbackQuery();
  await runAssembleStep(ctx, ctx.chat!.id);
});

bot.callbackQuery(/^regen_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await regenerateScene(ctx, ctx.chat!.id, Number(ctx.match[1]));
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
      await withGeneration(
        ctx,
        chatId,
        async () => {
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
        },
        {
          errorStep: "awaiting_reference",
          errorHint: "Пришлите ссылку ещё раз, либо /skip.",
        },
      );
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
