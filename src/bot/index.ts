import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import {
  buildImagePrompt,
  deleteMusicTrack,
  ensureDirs,
  ensureMusicLibraryDir,
  fitToBudget,
  generateSceneAudio,
  generateSceneIllustration,
  listMusicTracks,
  MUSIC_LIBRARY_DIR,
  pickMusic,
  writeVideoData,
} from "../pipeline/assets";
import { generateMusicTrack, MUSIC_PRESETS } from "../pipeline/generateMusic";
import {
  createInstantVoiceClone,
  isolateVoice,
} from "../pipeline/voiceClone";
import {
  audioDurationSeconds,
  concatAudio,
  extractAudio,
} from "./extractAudio";
import { config } from "../pipeline/config";
import { generateScriptWithHook } from "../pipeline/generateScript";
import {
  buildTtsInput,
  synthesizeSpeech,
  TTS_MODEL_CANDIDATES,
} from "../pipeline/generateVoiceover";
import { probeKieTask } from "../pipeline/kie";
import {
  isElevenLabsAvailable,
  listVoices,
  synthesizeSpeechDirect,
} from "../pipeline/elevenlabs";
import {
  DEFAULT_IMAGE_MODEL_KEY,
  getImageModel,
  IMAGE_MODELS,
} from "../pipeline/imageModels";
import { KNOWN_VOICE_NAMES, looksLikeVoiceId, resolveVoiceId } from "../pipeline/voices";
import type { Scene, VideoData } from "../types";
import { downloadDriveFile } from "./drive";
import { extractStyleNotes } from "./referenceStyle";
import {
  deleteProfile,
  getProfile,
  getSession,
  listProfiles,
  resetSession,
  saveProfile,
  updateSession,
} from "./state";

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

// Telegram помечает команды сущностью bot_command, и bot.command() ищет
// именно её. Но если текст пришёл с форматированием — например, команду
// скопировали из сообщения, где она была в обратных кавычках, — пометки нет,
// и команда молча проваливается в обработчик обычного текста. Восстанавливаем.
bot.use(async (ctx, next) => {
  const message = ctx.message;
  if (message?.text?.startsWith("/")) {
    const alreadyMarked = message.entities?.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    );
    if (!alreadyMarked) {
      const length = message.text.split(/\s/, 1)[0].length;
      message.entities = [
        { type: "bot_command", offset: 0, length },
        ...(message.entities ?? []),
      ];
    }
  }
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
    // Страховка: если задача не выставила шаг сама, диалог не должен остаться
    // навсегда "занят" — иначе бот перестаёт отвечать на что-либо.
    if (getSession(chatId).step === "busy") {
      updateSession(chatId, { step: "idle" });
    }
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
        // Первая сцена — хук, помечаем: по нему решается, досмотрят ли ролик.
        `${i + 1}. ${i === 0 ? "🪝 " : ""}${scene.caption}\n   🎙 ${scene.voiceoverText}`,
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

// Выбор модели картинок перед отрисовкой. Запомненная помечается звёздочкой.
async function askImageModel(ctx: Context, chatId: number): Promise<void> {
  const current = getSession(chatId).imageModel ?? DEFAULT_IMAGE_MODEL_KEY;
  const keyboard = new InlineKeyboard();
  for (const spec of IMAGE_MODELS) {
    keyboard
      .text(
        `${spec.key === current ? "⭐ " : ""}${spec.title}`,
        `imgmodel_${spec.key}`,
      )
      .row();
  }
  await ctx.reply(
    "Какой моделью рисовать картинки?\n\n" +
      IMAGE_MODELS.map((spec) => `• ${spec.title} — ${spec.note}`).join("\n"),
    { reply_markup: keyboard },
  );
}

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
      const { script, hookFixed } = await generateScriptWithHook(
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
      if (hookFixed) {
        await ctx.reply(`🪝 Хук переписал: ${hookFixed}.`);
      }
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
        const illustration = await generateSceneIllustration(
          i,
          buildImagePrompt(script.scenes[i], session.styleNotes),
          previousSceneUrl,
          session.imageModel,
        );
        const { imageFileName, resultUrl } = illustration;
        images[i] = illustration;
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
      const illustration = await generateSceneIllustration(
        index,
        buildImagePrompt(script.scenes[index], session.styleNotes),
        images[index - 1]?.resultUrl,
        session.imageModel,
      );
      const { imageFileName } = illustration;
      images[index] = illustration;
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
          session.ttsProvider,
        );
        updateSession(chatId, { audio });
      }
      scenes.push({
        caption: script.scenes[i].caption,
        voiceoverText: script.scenes[i].voiceoverText,
        audioFileName: audio[i].audioFileName,
        imageFileName: images[i].imageFileName,
        imageWidth: images[i].imageWidth,
        imageHeight: images[i].imageHeight,
        durationInFrames: audio[i].durationInFrames,
      });
    }

    const fitted = fitToBudget(scenes);
    const videoData: VideoData = {
      title: script.title,
      fps: config.fps,
      width: config.width,
      height: config.height,
      musicFileName: await pickMusic(),
      sfxEnabled: true,
      scenes: fitted.scenes,
    };
    await writeVideoData(videoData);

    if (fitted.overBudgetSeconds > 0.5) {
      await ctx.reply(
        `Внимание: ролик выходит на ${Math.round(fitted.totalSeconds)} с — ` +
          `дольше лимита ${config.maxVideoSeconds} с. Паузы уже сжаты до ` +
          "предела, дальше сокращать можно только текст: нажмите «✏️ Правки» " +
          "у сценария и попросите короче.",
      );
    }

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

    // Размеры и длительность обязательны: без них Telegram не знает пропорций
    // и показывает вертикальный ролик квадратным превью.
    const totalFrames = fitted.scenes.reduce(
      (sum, s) => sum + s.durationInFrames,
      0,
    );
    await ctx.replyWithVideo(new InputFile(path.resolve("out/video.mp4")), {
      caption:
        `«${script.title}» готово (${videoData.width}×${videoData.height}). ` +
        "Новый ролик — /new",
      width: videoData.width,
      height: videoData.height,
      duration: Math.round(totalFrames / videoData.fps),
      supports_streaming: true,
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
      "/profiles — профили продуктов (роль + стиль референса)\n" +
      "/newprofile — создать профиль\n" +
      "/cancel — сбросить текущий диалог\n" +
      "/voice — посмотреть или сменить голос озвучки\n" +
      "/voices — список голосов, доступных вашему ключу ElevenLabs\n" +
      "/model — модель озвучки\n" +
      "/tts — провайдер озвучки (kie или elevenlabs)\n" +
      "/music — фоновая музыка: библиотека и генерация\n" +
      "/clone — клонировать голос из своих роликов\n" +
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
  const chatId = ctx.chat.id;
  // Собранные для клонирования сэмплы — временный мусор, убираем.
  await rm(cloneDir(chatId), { recursive: true, force: true }).catch(() => {});
  resetSession(chatId);
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
    const resolved = resolveVoiceId(current);

    // По ID непонятно, какой из клонов выбран, поэтому спрашиваем имя у
    // ElevenLabs — это главный способ проверить, что активен нужный голос.
    let named = "";
    if (isElevenLabsAvailable()) {
      try {
        const voices = await listVoices();
        const match = voices.find((v) => v.voiceId === resolved);
        named = match
          ? `\nИмя в ElevenLabs: «${match.name}» (${match.category})`
          : "\nВ вашем аккаунте ElevenLabs такого голоса нет — возможно, " +
            "он удалён или это голос из Kie.ai.";
      } catch {
        named = "";
      }
    }

    await ctx.reply(
      `Текущий голос: ${resolved}` +
        (resolved === current ? "" : ` (имя «${current}» → ID)`) +
        named +
        "\n\nСменить: /voice <voice_id>, список — /voices\n" +
        "Kie.ai понимает только ID голоса, не имя. Имена классических " +
        `голосов подставляются автоматически (${KNOWN_VOICE_NAMES.join(", ")}), ` +
        "остальные указывайте как ID из библиотеки ElevenLabs или кабинета " +
        "Kie.ai.\n\nПосле смены пришлю пробную фразу — послушайте, прежде чем " +
        "собирать ролик.",
    );
    return;
  }

  const resolved = resolveVoiceId(requested);
  if (!looksLikeVoiceId(resolved)) {
    await ctx.reply(
      `«${requested}» не похоже на ID голоса (ожидается 20 символов латиницы ` +
        "и цифр). Имя понимаю только для классических голосов: " +
        `${KNOWN_VOICE_NAMES.join(", ")}. Для остальных нужен ID.\n\n` +
        "Всё равно попробовать как есть — /voiceforce " + requested,
    );
    return;
  }

  await withGeneration(ctx, chatId, async () => {
    await ctx.reply(`Пробую голос ${resolved}…`);
    const samplePath = path.resolve("out/voice-sample.mp3");
    await mkdir(path.dirname(samplePath), { recursive: true });
    await synthesizeSpeech(
      VOICE_SAMPLE_TEXT,
      samplePath,
      resolved,
      getSession(chatId).ttsModel,
      getSession(chatId).ttsProvider,
    );
    updateSession(chatId, { voice: resolved, step: "idle" });
    await ctx.replyWithVoice(new InputFile(samplePath), {
      caption: `Голос ${resolved} сохранён — будет использован для роликов.`,
    });
  });
});

// Обход проверки формата: если Kie.ai когда-нибудь начнёт принимать имена
// или у вас голос с нестандартным ID.
bot.command("voiceforce", async (ctx) => {
  const chatId = ctx.chat.id;
  const requested = ctx.match.trim();
  if (!requested) {
    await ctx.reply("Использование: /voiceforce <значение голоса>");
    return;
  }
  await withGeneration(ctx, chatId, async () => {
    await ctx.reply(`Пробую голос ${requested} без проверки формата…`);
    const samplePath = path.resolve("out/voice-sample.mp3");
    await mkdir(path.dirname(samplePath), { recursive: true });
    await synthesizeSpeech(
      VOICE_SAMPLE_TEXT,
      samplePath,
      requested,
      getSession(chatId).ttsModel,
      getSession(chatId).ttsProvider,
    );
    updateSession(chatId, { voice: requested, step: "idle" });
    await ctx.replyWithVoice(new InputFile(samplePath), {
      caption: `Голос ${requested} сохранён.`,
    });
  });
});

// Список голосов, доступных вашему ключу ElevenLabs. Состав зависит от
// тарифа, поэтому спрашиваем у API, а не гадаем по документации.
bot.command("voices", async (ctx) => {
  if (!isElevenLabsAvailable()) {
    await ctx.reply(
      "Список голосов доступен только для прямого ElevenLabs — нужен " +
        "ELEVENLABS_API_KEY в .env на сервере.",
    );
    return;
  }

  await withGeneration(ctx, ctx.chat.id, async () => {
    const voices = await listVoices();
    if (voices.length === 0) {
      await ctx.reply("ElevenLabs не вернул ни одного голоса.");
      return;
    }

    // На бесплатном тарифе через API работают только premade-голоса.
    const premade = voices.filter((v) => v.category === "premade");
    const others = voices.filter((v) => v.category !== "premade");

    const active = resolveVoiceId(
      getSession(ctx.chat.id).voice ?? config.kieTtsVoice,
    );
    const format = (list: typeof voices) =>
      list
        .map(
          (v) =>
            `${v.voiceId === active ? "▶️" : "•"} ${v.name} — ${v.voiceId}`,
        )
        .join("\n");

    let text = `Голосов доступно: ${voices.length}\n\n`;
    if (premade.length) {
      text +=
        "Базовые (premade) — работают и на бесплатном тарифе:\n" +
        format(premade.slice(0, 25)) +
        "\n\n";
    }
    if (others.length) {
      text +=
        "Остальные (библиотечные/клонированные) — требуют платной подписки:\n" +
        format(others.slice(0, 10)) +
        "\n\n";
    }
    text +=
      "▶️ — голос, выбранный сейчас.\n" +
      "Выбрать другой: /voice <id> — бот сразу пришлёт пробную фразу.";

    await ctx.reply(text);
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

bot.command("tts", async (ctx) => {
  const chatId = ctx.chat.id;
  const requested = ctx.match.trim();
  const current = getSession(chatId).ttsProvider ?? config.ttsProvider;

  if (requested !== "kie" && requested !== "elevenlabs") {
    await ctx.reply(
      `Провайдер озвучки: ${current}\n\n` +
        "Переключить: /tts kie или /tts elevenlabs\n\n" +
        "• kie — модели ElevenLabs через Kie.ai, один ключ на всё;\n" +
        "• elevenlabs — напрямую, нужен ELEVENLABS_API_KEY в .env. Резервный " +
        "путь, когда прокси Kie.ai для озвучки не работает.\n\n" +
        `Прямой ElevenLabs сейчас ${isElevenLabsAvailable() ? "доступен (ключ есть)" : "недоступен: нет ключа в .env"}.`,
    );
    return;
  }

  if (requested === "elevenlabs" && !isElevenLabsAvailable()) {
    await ctx.reply(
      "Нужен ELEVENLABS_API_KEY в .env на сервере. Добавьте строку\n" +
        "ELEVENLABS_API_KEY=ваш_ключ\n" +
        "и перезапустите бота (/deploy или systemctl restart amg-bot).",
    );
    return;
  }

  updateSession(chatId, { ttsProvider: requested });
  await ctx.reply(
    `Провайдер озвучки: ${requested}. Проверить — /voice ${getSession(chatId).voice ?? config.kieTtsVoice}`,
  );
});

// ——— Клонирование голоса из референс-видео ———

// ElevenLabs советует минимум минуту речи; ниже этого клон выходит грубым.
const CLONE_MIN_SECONDS = 60;

// Сэмплы копятся на диске: их присылают по одному, и сбор должен переживать
// перезапуск бота.
function cloneDir(chatId: number): string {
  return path.resolve("data/clone-samples", String(chatId));
}

/** Извлекает дорожку, добавляет её к сэмплам и отчитывается о длительности. */
async function addCloneSample(
  ctx: Context,
  chatId: number,
  sourceFile: string,
): Promise<void> {
  const dir = cloneDir(chatId);
  await mkdir(dir, { recursive: true });
  const samples = getSession(chatId).cloneSamples ?? [];
  const target = path.join(dir, `sample-${samples.length}.mp3`);

  await extractAudio(sourceFile, target);
  const seconds = await audioDurationSeconds(target);
  const next = [...samples, target];
  // Шаг возвращаем явно: withGeneration после успешной задачи сбрасывает
  // "busy" в "idle", а сбор сэмплов должен продолжаться до /done.
  updateSession(chatId, {
    cloneSamples: next,
    step: "awaiting_clone_links",
  });

  let total = 0;
  for (const file of next) total += await audioDurationSeconds(file);

  await ctx.reply(
    `🎧 Принято: ${Math.round(seconds)} с. Всего материала: ${Math.round(total)} с.\n\n` +
      (total < CLONE_MIN_SECONDS
        ? `Нужно хотя бы ${CLONE_MIN_SECONDS} с — пришлите ещё файлы или ссылки.\n`
        : "Материала достаточно.\n") +
      "Когда всё пришлёте — /done. Отменить — /cancel.",
  );
}

bot.command("done", async (ctx) => {
  const chatId = ctx.chat.id;
  const samples = getSession(chatId).cloneSamples ?? [];
  if (samples.length === 0) {
    await ctx.reply(
      "Нечего завершать: сэмплы для клонирования не собраны. Начать — /clone",
    );
    return;
  }
  await runCloneStep(ctx, chatId);
});

bot.command("clone", async (ctx) => {
  if (!isElevenLabsAvailable()) {
    await ctx.reply(
      "Для клонирования нужен ELEVENLABS_API_KEY в .env на сервере — через " +
        "Kie.ai эта операция недоступна.",
    );
    return;
  }
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  updateSession(ctx.chat.id, { step: "awaiting_clone_name" });
  await ctx.reply(
    "Клонируем голос из ваших роликов.\n\nКак назвать голос? Например " +
      "«Шамиль» — под этим именем он появится в ElevenLabs.",
  );
});

async function runCloneStep(ctx: Context, chatId: number): Promise<void> {
  await withGeneration(
    ctx,
    chatId,
    async () => {
      const session = getSession(chatId);
      const name = session.cloneName ?? "Клон";
      const parts = session.cloneSamples ?? [];
      if (parts.length === 0) {
        throw new Error(
          "Нет ни одного сэмпла. Пришлите файлы или ссылки, потом /done.",
        );
      }

      const workDir = await mkdtemp(path.join(tmpdir(), "amg-clone-"));
      try {
        let totalSeconds = 0;
        for (const file of parts) totalSeconds += await audioDurationSeconds(file);

        const merged = path.join(workDir, "merged.mp3");
        await concatAudio(parts, merged);

        await ctx.reply(
          `Материала: ${Math.round(totalSeconds)} с из ${parts.length} файл(ов).` +
            (totalSeconds < CLONE_MIN_SECONDS
              ? "\n\n⚠️ Меньше рекомендованной минуты — клон получится " +
                "узнаваемым, но грубоватым."
              : ""),
        );

        // Очищенную дорожку присылаем послушать: если голос звучит
        // «подводно», клонировать такой материал бессмысленно.
        await ctx.reply("🧹 Убираю музыку с фона…");
        const cleaned = path.join(workDir, "cleaned.mp3");
        await isolateVoice(merged, cleaned);
        await ctx.replyWithAudio(new InputFile(cleaned), {
          title: `${name} — исходник без музыки`,
          caption: "Так звучит материал после удаления музыки. Из него делаю клон.",
        });

        await ctx.reply("🧬 Создаю клон голоса…");
        const { voiceId } = await createInstantVoiceClone({
          name,
          files: [cleaned],
        });

        updateSession(chatId, {
          voice: voiceId,
          step: "idle",
          cloneName: undefined,
          cloneSamples: undefined,
        });
        await rm(cloneDir(chatId), { recursive: true, force: true });

        await ctx.reply(
          `Готово. Голос «${name}» создан и выбран для роликов.\nVoice ID: ${voiceId}`,
        );

        // Пробная фраза тем же путём, которым пойдёт озвучка роликов.
        const samplePath = path.resolve("out/voice-sample.mp3");
        await mkdir(path.dirname(samplePath), { recursive: true });
        await synthesizeSpeech(
          VOICE_SAMPLE_TEXT,
          samplePath,
          voiceId,
          undefined,
          "elevenlabs",
        );
        await ctx.replyWithVoice(new InputFile(samplePath), {
          caption:
            "Так он звучит на озвучке. Не понравилось — /clone с другими " +
            "исходниками, вернуться к прежнему — /voice <id>.",
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    {
      errorStep: "awaiting_clone_links",
      // Сэмплы не трогаем: повтор через /done не потребует присылать заново.
      errorHint: "Собранные сэмплы сохранены — повторите /done или /cancel.",
    },
  );
}

// ——— Фоновая музыка: библиотека в assets/music, генерация через Kie.ai ———

bot.command("music", async (ctx) => {
  const tracks = await listMusicTracks();
  const keyboard = new InlineKeyboard();
  for (const preset of MUSIC_PRESETS) {
    keyboard.text(`🎵 ${preset.title}`, `music_gen_${preset.key}`).row();
  }
  if (tracks.length > 0) {
    keyboard.text("🗑 Очистить библиотеку", "music_clear");
  }

  await ctx.reply(
    (tracks.length === 0
      ? "Библиотека музыки пуста — ролики собираются без фона.\n\n"
      : `В библиотеке ${tracks.length} трек(ов):\n` +
        tracks.map((t) => `• ${t}`).join("\n") +
        "\n\nДля каждого ролика берётся случайный.\n\n") +
      "Сгенерировать трек (Suno через Kie.ai, ~1-2 минуты, тратит кредиты). " +
      "Можно нажать несколько раз — соберётся набор на разные настроения:",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery(/^music_gen_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  const preset = MUSIC_PRESETS.find((p) => p.key === ctx.match[1]);
  if (!preset) {
    await ctx.reply("Не знаю такого пресета. Список — /music");
    return;
  }

  await withGeneration(ctx, chatId, async () => {
    await ensureMusicLibraryDir();
    await ctx.reply(
      `🎵 Генерирую трек «${preset.title}» — это займёт минуту-две…`,
    );
    const fileName = `${preset.key}-${Date.now()}.mp3`;
    const outFile = path.join(MUSIC_LIBRARY_DIR, fileName);
    const info = await generateMusicTrack(preset.prompt, outFile);

    await ctx.replyWithAudio(new InputFile(outFile), {
      title: info.title ?? preset.title,
      caption:
        `Добавлен в библиотеку: ${fileName}\n` +
        "Будет случайно подмешиваться в ролики. Ещё треки — /music",
    });
  });
});

bot.callbackQuery("music_clear", async (ctx) => {
  await ctx.answerCallbackQuery();
  const tracks = await listMusicTracks();
  for (const track of tracks) await deleteMusicTrack(track);
  await ctx.reply(
    `Удалено треков: ${tracks.length}. Ролики снова будут без фоновой музыки.`,
  );
});

// Диагностика озвучки: перебирает модели Kie.ai и, если есть ключ, проверяет
// прямой ElevenLabs. Первый рабочий вариант сохраняет.
bot.command("diag", async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  const configured = session.voice ?? config.kieTtsVoice;
  const voice = resolveVoiceId(configured);

  await withGeneration(ctx, chatId, async () => {
    await ctx.reply(
      "Проверяю озвучку.\n" +
        `Голос: ${voice}` +
        (voice === configured ? "" : ` (имя «${configured}» → ID)`) +
        `\nВариантов к проверке: ${TTS_MODEL_CANDIDATES.length + (isElevenLabsAvailable() ? 1 : 0)}\n` +
        "Каждый до 2 минут, подождите…",
    );

    const lines: string[] = [];
    let workingModel: string | undefined;

    for (const model of TTS_MODEL_CANDIDATES) {
      const result = await probeKieTask({
        model,
        input: buildTtsInput("Проверка связи, раз, два, три.", voice),
      });
      lines.push(`${result.ok ? "✅" : "❌"} ${model}\n   ${result.detail}`);
      if (result.ok && !workingModel) workingModel = model;
    }

    // Резервный путь проверяем, только если Kie.ai не справился.
    let directWorks = false;
    if (!workingModel && isElevenLabsAvailable()) {
      try {
        await synthesizeSpeechDirect(
          "Проверка связи, раз, два, три.",
          path.resolve("out/diag-sample.mp3"),
          voice,
        );
        directWorks = true;
        lines.push("✅ ElevenLabs напрямую\n   успех");
      } catch (error) {
        lines.push(
          `❌ ElevenLabs напрямую\n   ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    let summary = lines.join("\n\n");
    if (workingModel) {
      updateSession(chatId, {
        ttsModel: workingModel,
        ttsProvider: "kie",
        step: "idle",
      });
      summary +=
        `\n\nРабочая модель найдена и сохранена: ${workingModel}\n` +
        "Можно возвращаться к сборке — кнопка «Повторить» выше.";
    } else if (directWorks) {
      updateSession(chatId, { ttsProvider: "elevenlabs", step: "idle" });
      summary +=
        "\n\nКie.ai не отдаёт озвучку, но прямой ElevenLabs работает — " +
        "переключил на него. Можно возвращаться к сборке кнопкой «Повторить».";
    } else {
      summary +=
        "\n\nНи один вариант не отработал.\n" +
        "Судя по ответам, это сбой на стороне Kie.ai (их собственная ошибка " +
        "предлагает обратиться в поддержку), а не проблема запроса: картинки " +
        "тем же ключом генерируются нормально.\n\n" +
        "Что делать:\n" +
        "• написать в поддержку Kie.ai, приложив текст ошибок выше;\n" +
        "• тем временем добавить ELEVENLABS_API_KEY в .env и включить " +
        "резервный путь: /tts elevenlabs;\n" +
        `• либо попробовать другой голос: /voice <id> (текущий — ${voice}).`;
    }
    await ctx.reply(summary);
  });
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }

  const cleared = {
    brief: undefined,
    styleNotes: undefined,
    script: undefined,
    images: undefined,
    audio: undefined,
    profileId: undefined,
    draftProfile: undefined,
  };

  const profiles = listProfiles(chatId);
  if (profiles.length > 0) {
    updateSession(chatId, { step: "idle", ...cleared });
    const keyboard = new InlineKeyboard();
    for (const profile of profiles) {
      keyboard.text(profile.name, `prof_use_${profile.id}`).row();
    }
    keyboard.text("Без профиля (ввести всё вручную)", "prof_none");
    await ctx.reply("Из какого профиля делаем ролик?", {
      reply_markup: keyboard,
    });
    return;
  }

  updateSession(chatId, { step: "awaiting_brief", ...cleared });
  await ctx.reply(
    "Опишите ролик: что за продукт, для кого, какой посыл?\n\n" +
      "Например: «Продукт: доступ к нейросетям в Телеграм. Для кого: " +
      "новички. Посыл: нейросети — это просто.»\n\n" +
      "Чтобы не вводить это каждый раз, создайте профиль: /newprofile",
  );
});

// ——— Профили: роль и разобранный стиль референса, сохранённые под именем ———

bot.command("profiles", async (ctx) => {
  const chatId = ctx.chat.id;
  const profiles = listProfiles(chatId);
  if (profiles.length === 0) {
    await ctx.reply(
      "Профилей пока нет.\n\n" +
        "Профиль хранит роль/описание продукта и разобранный стиль " +
        "референс-видео, чтобы не присылать их для каждого ролика. " +
        "Создать: /newprofile",
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const profile of profiles) {
    keyboard
      .text(`▶️ ${profile.name}`, `prof_use_${profile.id}`)
      .text("🗑", `prof_del_${profile.id}`)
      .row();
  }
  await ctx.reply(
    profiles
      .map(
        (profile) =>
          `• ${profile.name}\n  ${profile.brief.slice(0, 120)}${profile.brief.length > 120 ? "…" : ""}\n  Стиль из референса: ${profile.styleNotes ? "есть" : "нет"}`,
      )
      .join("\n\n") + "\n\nСоздать ещё — /newprofile",
    { reply_markup: keyboard },
  );
});

bot.command("newprofile", async (ctx) => {
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  updateSession(ctx.chat.id, {
    step: "awaiting_profile_name",
    draftProfile: {},
  });
  await ctx.reply(
    "Создаём профиль.\n\nКак его назвать? Коротко, чтобы узнавать в списке — " +
      "например «Телеграм-бот» или «VK».",
  );
});

bot.callbackQuery(/^prof_use_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  const profile = getProfile(chatId, ctx.match[1]);
  if (!profile) {
    await ctx.reply("Профиль не найден — возможно, удалён. Список: /profiles");
    return;
  }

  updateSession(chatId, {
    step: "awaiting_topic",
    profileId: profile.id,
    brief: profile.brief,
    styleNotes: profile.styleNotes,
    script: undefined,
    images: undefined,
    audio: undefined,
  });
  await ctx.reply(
    `Профиль «${profile.name}».\n\nО чём этот ролик? Напишите тему или ` +
      "конкретный посыл — роль и стиль уже взяты из профиля.\n\n" +
      "Если тема не важна, отправьте /skip — сценарист придумает сам.",
  );
});

bot.callbackQuery("prof_none", async (ctx) => {
  await ctx.answerCallbackQuery();
  updateSession(ctx.chat!.id, { step: "awaiting_brief" });
  await ctx.reply("Опишите ролик: что за продукт, для кого, какой посыл?");
});

bot.callbackQuery(/^prof_del_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  const profile = getProfile(chatId, ctx.match[1]);
  if (!profile) {
    await ctx.reply("Профиль не найден. Список: /profiles");
    return;
  }
  deleteProfile(chatId, profile.id);
  await ctx.reply(`Профиль «${profile.name}» удалён.`);
});

bot.callbackQuery("script_ok", async (ctx) => {
  await ctx.answerCallbackQuery();
  await askImageModel(ctx, ctx.chat!.id);
});

bot.callbackQuery(/^imgmodel_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  const spec = getImageModel(ctx.match[1]);
  updateSession(chatId, { imageModel: spec.key });
  await ctx.reply(`Рисую моделью ${spec.title}.`);
  await runImagesStep(ctx, chatId);
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

// Материал для клонирования можно присылать файлом: видео, аудио, голосовое
// или документ. Telegram отдаёт боту файлы до 20 МБ — для звука этого хватает
// с запасом, а большие видео идут ссылкой на Drive.
bot.on([":video", ":audio", ":voice", ":document", ":video_note"], async (ctx) => {
  const chatId = ctx.chat.id;
  if (getSession(chatId).step !== "awaiting_clone_links") return;

  await withGeneration(
    ctx,
    chatId,
    async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "amg-tg-"));
      try {
        await ctx.reply("⬇️ Забираю файл…");
        const file = await ctx.getFile();
        if (!file.file_path) {
          throw new Error("Telegram не отдал путь к файлу");
        }
        // Скачиваем сами: file.download() живёт в отдельном плагине grammY.
        const response = await fetch(
          `https://api.telegram.org/file/bot${token}/${file.file_path}`,
        );
        if (!response.ok) {
          throw new Error(`Не удалось скачать файл: HTTP ${response.status}`);
        }
        const localPath = path.join(workDir, path.basename(file.file_path));
        await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
        await addCloneSample(ctx, chatId, localPath);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    {
      errorStep: "awaiting_clone_links",
      errorHint:
        "Не получилось разобрать файл. Пришлите другой, ссылку или /cancel.\n" +
        "Файлы больше 20 МБ Telegram боту не отдаёт — такие только ссылкой.",
    },
  );
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

    // Тема конкретного ролика поверх роли из профиля.
    case "awaiting_topic": {
      const profileBrief = session.brief ?? "";
      if (text !== "/skip") {
        updateSession(chatId, {
          brief: `${profileBrief}\n\nТема этого ролика: ${text}`,
        });
      }
      await runScriptStep(ctx, chatId);
      return;
    }

    case "awaiting_clone_name": {
      updateSession(chatId, {
        step: "awaiting_clone_links",
        cloneName: text,
        cloneSamples: undefined,
      });
      await ctx.reply(
        `Голос «${text}». Теперь присылайте материал — можно двумя способами, ` +
          "и вперемешку:\n\n" +
          "• **файлом** прямо в чат: видео, аудио или голосовое (до 20 МБ — " +
          "лимит Telegram);\n" +
          "• **ссылкой** на Google Drive (доступ «всем, у кого есть ссылка») — " +
          "так проходят и большие видео.\n\n" +
          `Присылайте по одному, я буду считать. Нужно минимум ${CLONE_MIN_SECONDS} с речи.\n` +
          "Когда всё — /done.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    case "awaiting_clone_links": {
      if (text === "/done") {
        await runCloneStep(ctx, chatId);
        return;
      }

      const links = text
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => /^https?:\/\//.test(part));

      if (links.length === 0) {
        await ctx.reply(
          "Жду файл или ссылку. Файл — просто прикрепите к сообщению; " +
            "ссылка — вида https://drive.google.com/...\n\n" +
            "Закончить сбор — /done, отменить — /cancel.",
        );
        return;
      }

      await withGeneration(
        ctx,
        chatId,
        async () => {
          const workDir = await mkdtemp(path.join(tmpdir(), "amg-dl-"));
          try {
            for (let i = 0; i < links.length; i++) {
              await ctx.reply(`⬇️ Скачиваю ${i + 1} из ${links.length}…`);
              const videoFile = path.join(workDir, `src-${i}.mp4`);
              await downloadDriveFile(links[i], videoFile);
              await addCloneSample(ctx, chatId, videoFile);
            }
          } finally {
            await rm(workDir, { recursive: true, force: true });
          }
        },
        {
          errorStep: "awaiting_clone_links",
          errorHint: "Пришлите ссылку ещё раз, файл или /cancel.",
        },
      );
      return;
    }

    case "awaiting_profile_name": {
      updateSession(chatId, {
        step: "awaiting_profile_brief",
        draftProfile: { ...session.draftProfile, name: text },
      });
      await ctx.reply(
        "Теперь роль и контекст — это пойдёт сценаристу в каждом ролике " +
          "этого профиля.\n\nНапример: «Ты маркетолог. Продукт: доступ к " +
          "нейросетям в Телеграм. Аудитория: новички. Тон: дружелюбный, с " +
          "юмором.»",
      );
      return;
    }

    case "awaiting_profile_brief": {
      updateSession(chatId, {
        step: "awaiting_profile_reference",
        draftProfile: { ...session.draftProfile, brief: text },
      });
      await ctx.reply(
        "Пришлите ссылку на референс-видео (Google Drive, доступ «всем, у " +
          "кого есть ссылка») — разберу стиль один раз и сохраню в профиль.\n\n" +
          "Либо /skip, если референс не нужен.",
      );
      return;
    }

    case "awaiting_profile_reference": {
      const draft = session.draftProfile ?? {};

      if (text === "/skip") {
        const saved = saveProfile(chatId, {
          name: draft.name ?? "Без названия",
          brief: draft.brief ?? "",
        });
        updateSession(chatId, { step: "idle", draftProfile: undefined });
        await ctx.reply(
          `Профиль «${saved.name}» сохранён (без референса).\n\n` +
            "Сделать ролик — /new, список профилей — /profiles",
        );
        return;
      }

      let styleNotes: string | undefined;
      await withGeneration(
        ctx,
        chatId,
        async () => {
          await ctx.reply("Скачиваю референс и разбираю стиль…");
          const workDir = await mkdtemp(path.join(tmpdir(), "amg-drive-"));
          try {
            const videoFile = path.join(workDir, "reference.mp4");
            await downloadDriveFile(text, videoFile);
            styleNotes = await extractStyleNotes(videoFile);
            await ctx.reply(`Стиль из референса:\n\n${styleNotes}`);
          } finally {
            await rm(workDir, { recursive: true, force: true });
          }
        },
        {
          errorStep: "awaiting_profile_reference",
          errorHint: "Пришлите ссылку ещё раз, либо /skip.",
        },
      );

      if (!styleNotes) return;

      const saved = saveProfile(chatId, {
        name: draft.name ?? "Без названия",
        brief: draft.brief ?? "",
        styleNotes,
        referenceLink: text,
      });
      updateSession(chatId, { step: "idle", draftProfile: undefined });
      await ctx.reply(
        `Профиль «${saved.name}» сохранён вместе со стилем референса.\n\n` +
          "Теперь референс присылать не нужно: /new → выбрать профиль → тема.",
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
      // generationRunning — правда о том, работает ли что-то прямо сейчас;
      // шаг в сессии мог просто остаться от прерванной задачи.
      if (generationRunning) {
        await ctx.reply("Идёт генерация, подождите…");
      } else {
        updateSession(chatId, { step: "idle" });
        await ctx.reply(
          "Прошлая задача уже не выполняется — состояние сброшено. " +
            "Повторите команду или начните новый ролик: /new",
        );
      }
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
