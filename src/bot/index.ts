import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import {
  buildImagePrompt,
  buildOutro,
  sceneWithCharacter,
  deleteMusicTrack,
  ensureDirs,
  ensureMusicLibraryDir,
  fitToBudget,
  sceneClip,
  generateSceneAudio,
  PUBLIC_AUDIO_DIR,
  PUBLIC_IMAGES_DIR,
  generateSceneIllustration,
  listMusicTracks,
  MUSIC_LIBRARY_DIR,
  pickMusic,
  listImportedSfx,
  writeVideoData,
} from "../pipeline/assets";
import {
  CLIP_LIBRARY,
  CLIP_LIBRARY_DIR,
  getClipDefinition,
  libraryFileName,
  librarySceneIndexes,
  mascotSceneIndexes,
  orphanClipFiles,
  readyClipIds,
  resolveClipSelection,
} from "../pipeline/clipLibrary";
import {
  buildClipPrompt,
  clipSceneIndexes,
  generateLibraryClip,
} from "../pipeline/generateClip";
import { generateMusicTrack, MUSIC_PRESETS } from "../pipeline/generateMusic";
import {
  generateSceneOverlay,
  overlayAnchor,
  OVERLAY_WIDTH_PERCENT,
} from "../pipeline/generateOverlay";
import { overlayStartMs } from "../pipeline/wordTimings";
import { lookLabel, sceneLook, seedFromTitle } from "../pipeline/sceneLook";
import { measureImages, varietyLines, varietyReport } from "../pipeline/variety";
import { generateScriptAudio } from "../pipeline/scriptAudio";
import { DEFAULT_SPEED, describeSpeed, parseSpeed, setSpeechSpeed } from "../pipeline/speech";
import { DIRECT_TTS_MODELS, directModelNote } from "../pipeline/ttsModels";
import {
  dayLabel,
  hourCells,
  hourLabel,
  humanDate,
  markedDays,
  monthGrid,
  monthTitle,
  nextMonth,
  parseDateTime,
  pickedMoment,
  prevMonth,
  todayIn,
  WEEKDAYS,
} from "./calendar";
import {
  buildPostBody,
  createPost,
  getPost,
  parseWhen,
  postStateLines,
  publishableTargets,
  retryPost,
  listScheduledDates,
  uploadVideo,
  validatePost,
  isSettled,
} from "../pipeline/zernioPost";
import {
  accountLine,
  connectUrl,
  disconnectAccount,
  isZernioConfigured,
  listAccounts,
  listProfiles as listZernioProfiles,
  platformTitle,
  PRIMARY_PLATFORMS,
  resolveProfileId,
  ZERNIO_PLATFORMS,
  type ZernioPlatform,
} from "../pipeline/zernio";
import {
  isFreshTopic,
  suggestNewsTopics,
  topicBrief,
  type NewsTopic,
} from "../pipeline/newsTopics";
import {
  createInstantVoiceClone,
  downloadVoiceSample,
  editInstantVoiceClone,
  getVoiceSamples,
  isolateVoice,
  separateStems,
} from "../pipeline/voiceClone";
import type { StemVariation } from "../pipeline/voiceClone";
import {
  audioDurationSeconds,
  concatAudio,
  extractAudio,
  fileHash,
} from "./extractAudio";
import { prepareUploadFiles } from "../pipeline/voiceSamples";
import {
  libraryTrackName,
  prepareMusicTrack,
  prepareMusicTrackInPlace,
} from "../pipeline/prepareMusic";
import {
  analyzeMusic,
  BEAT_FOUND_ABOVE,
  musicPromptFromAnalysis,
} from "../pipeline/analyzeMusic";
import { config } from "../pipeline/config";
import { generateDescription } from "../pipeline/generateDescription";
import { generateCheckedScript, isSoftProblem } from "../pipeline/generateScript";
import {
  readChecklist,
  resetChecklist,
  writeChecklist,
} from "../pipeline/reviewChecklist";
import {
  buildTtsInput,
  cloneViaProxyWarning,
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
import {
  DEFAULT_SCRIPT_MODEL_KEY,
  SCRIPT_MODELS,
  getScriptModel,
  resolveScriptModel,
} from "../pipeline/scriptModels";
import {
  clampClipSeconds,
  DEFAULT_VIDEO_MODEL_KEY,
  getVideoModel,
  VIDEO_MODELS,
} from "../pipeline/videoModels";
import { KNOWN_VOICE_NAMES, looksLikeVoiceId, resolveVoiceId } from "../pipeline/voices";
import type { Scene, VideoData } from "../types";
import { downloadDriveFile } from "./drive";
import {
  compressToLimit,
  fileSizeBytes,
  formatMb,
  makeThumbnail,
  SAFE_VIDEO_BYTES,
} from "./videoSize";
import { masterLoudness, measureLoudness } from "./masterAudio";
import { autopilotContinues, parseAutopilotArg } from "./autopilot";
import {
  EDITABLE_KEYS,
  getEnvValue,
  keyStatusLine,
  maskSecret,
  parseSetKey,
  setEnvValue,
} from "./envFile";
import { extractStyleNotes } from "./referenceStyle";
import {
  deleteProfile,
  forgetShotTopics,
  getLastPostId,
  getLastVideo,
  rememberPostId,
  rememberVideo,
  getProfile,
  getSession,
  listProfiles,
  forgetShotTopic,
  listShotTopics,
  rememberShotTopic,
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

/**
 * Обёртка вокруг тяжёлого шага. Возвращает true, если шаг прошёл — по этому
 * признаку автопилот решает, продолжать ли цепочку. Продолжать после сбоя
 * нельзя: следующий шаг работал бы на пустом месте и добавил бы к одной
 * ошибке вторую.
 */
async function withGeneration(
  ctx: Context,
  chatId: number,
  task: () => Promise<void>,
  options: GenerationOptions = {},
): Promise<boolean> {
  if (generationRunning) {
    await ctx.reply("Уже идёт другая генерация — дождитесь её окончания.");
    return false;
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
    return true;
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
    return false;
  } finally {
    generationRunning = false;
  }
}

function formatScript(script: {
  title: string;
  scenes: { caption: string; voiceoverText: string; visual?: string }[];
}): string {
  const scenes = script.scenes
    .map(
      (scene, i) =>
        // Первая сцена — хук, помечаем: по нему решается, досмотрят ли ролик.
        `${i + 1}. ${i === 0 ? "🪝 " : ""}${scene.caption}\n   🎙 ${scene.voiceoverText}` +
        // Что будет в кадре — видно ДО отрисовки. Картинки стоят денег, и
        // «во всех сценах человек за ноутбуком» дешевле заметить здесь.
        (scene.visual ? `\n   🖼 ${scene.visual}` : ""),
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

/** Включён ли автопилот в этом чате. */
function autopilotOn(chatId: number): boolean {
  return getSession(chatId).autopilot === true;
}

async function runScriptStep(
  ctx: Context,
  chatId: number,
  feedback?: string,
): Promise<void> {
  // Скорость речи этого чата — до всего остального: от неё зависит и
  // бюджет слов сценария, и сам синтез.
  setSpeechSpeed(getSession(chatId).ttsSpeed);
  const ok = await withGeneration(
    ctx,
    chatId,
    async () => {
      const session = getSession(chatId);
      await ctx.reply(feedback ? "Переписываю сценарий…" : "Пишу сценарий…");
      const { script, fixes, remaining, webSearchUnavailable, reviewUnavailable } = await generateCheckedScript(
        session.brief ?? "",
        feedback && session.script
          ? { previousScript: session.script, feedback }
          : undefined,
        session.maxVideoSeconds,
        resolveScriptModel(session.scriptModel),
      );
      // Новый сценарий делает старые картинки и озвучки неактуальными.
      updateSession(chatId, {
        step: "idle",
        script,
        images: undefined,
        audio: undefined,
      });
      // Раньше здесь стояло «✏️ Переписал: …» — то есть результат утверждался,
      // хотя правка это всего лишь просьба к модели. Теперь отдельно то, что
      // просили поправить, и отдельно то, что после правки осталось.
      for (const fix of fixes) {
        await ctx.reply(`✏️ Просил переписать: ${fix}.`);
      }
      if (remaining.length > 0) {
        await ctx.reply(
          `⚠️ После правки осталось: ${remaining.join("; ")}. ` +
            "Это объективные проверки — стоит поправить руками через «✏️ Правки».",
        );
      }
      if (webSearchUnavailable) {
        await ctx.reply(
          "⚠️ Веб-поиск не сработал — сценарий написан по знаниям модели, " +
            "без свежих данных. Тему стоит перепроверить.",
        );
      }
      if (reviewUnavailable) {
        // Молча пропустить нельзя: сценарий прошёл только структурные
        // проверки, то есть ритм и рекламу, но не смысл.
        await ctx.reply(
          `⚠️ ${reviewUnavailable}. Сценарий проверен только на ритм и ` +
            "структуру — смысл, хук и призыв посмотрите глазами.",
        );
      }
      await ctx.reply(formatScript(script));
      // Единственное, чего автоматика проверить не может: ведёт ли тема к
      // продукту. Ролик про энергопотребление дата-центров с финалом «попробуй
      // наш бот для картинок» проходит все проверки и при этом не продаёт —
      // боль хука не та, которую лечит продукт.
      if (autopilotOn(chatId)) {
        // На автопилоте кнопок нет, но замечания всё равно показываем: ролик
        // потом смотреть, и знать, с чем он вышел, полезно.
        //
        // Останавливают не все замечания: см. isSoftProblem. Модель, не
        // осилившая новое поле сценария, — это не повод класть завод.
        const blocking = remaining.filter((p) => !isSoftProblem(p));
        if (blocking.length > 0) {
          // Единственное, что автопилот останавливает: объективные проверки не
          // прошли ПОСЛЕ правки. Дальше пошли бы деньги на картинки и озвучку
          // ради ролика, который заведомо не годится.
          await ctx.reply(
            "🛑 Автопилот остановлен: после правки в сценарии осталось — " +
              `${blocking.join("; ")}.\n\nПопросите «✏️ Правки» или ` +
              "перегенерируйте: /new",
            { reply_markup: scriptKeyboard },
          );
          return;
        }
        await ctx.reply("🤖 Автопилот: сценарий прошёл проверки, рисую картинки.");
        return;
      }
      await ctx.reply(
        "Перед тем как рисовать, проверьте главное — то, что я проверить не " +
          "могу:\n\n" +
          "• если закрыть последнюю сцену, зритель догадается, что ему сейчас " +
          "предложат? Если нет — тема выбрана мимо продукта, и правкой текста " +
          "это не чинится, нужна другая тема;\n" +
          "• предпоследняя сцена оставляет вывод, а не разведённые руки?\n" +
          "• в хуке есть за что зацепиться в первые три секунды?",
        { reply_markup: scriptKeyboard },
      );
    },
    { retryData: "retry_script" },
  );

  // Продолжение автопилота — СНАРУЖИ withGeneration: внутри флаг генерации ещё
  // поднят, и вложенный шаг ответил бы «уже идёт другая генерация».
  if (autopilotContinues({ ok, session: getSession(chatId) })) {
    await runImagesStep(ctx, chatId);
  }
}

async function runImagesStep(ctx: Context, chatId: number): Promise<void> {
  const ok = await withGeneration(
    ctx,
    chatId,
    async () => {
      await ensureDirs();
      const session = getSession(chatId);
      const script = session.script;
      if (!script) throw new Error("Сценарий потерялся — начните заново: /new");

      const images = [...(session.images ?? [])];
      const overlays = [...(session.overlays ?? [])];
      // Картинка предыдущей сцены БОЛЬШЕ НЕ передаётся следующей как референс.
      // Замер присланного ролика: соседние иллюстрации совпадали на 93% и 77%
      // при медиане 39% по всем парам — модель копировала композицию, а не
      // палитру, и на смене темы картинка оставалась прежней. Стиль держит
      // STYLE_PROMPT. Внутри сцены сцепка осталась: вторая картинка обязана
      // быть похожей на первую, они видны почти одновременно.
      // Сцены без карточки: маскот во весь рост на белом. Картинка им не
      // нужна — рисовать её было бы и тратой денег, и путаницей: она попала
      // бы в согласование, а в ролик не вошла.
      const mascotScenes = new Set(
        mascotSceneIndexes(script.scenes.length, config.mascotScenes),
      );

      for (let i = 0; i < script.scenes.length; i++) {
        if (mascotScenes.has(i)) {
          await ctx.reply(
            `🧞 Сцена ${i + 1}: маскот во весь кадр, без карточки — картинку не рисую.`,
          );
          continue;
        }
        // Уже сгенерированные при прошлой попытке сцены пропускаем.
        if (images[i]) continue;
        const withCharacter = sceneWithCharacter(i, script.scenes.length);
        // Тон и план кадра — по номеру сцены. Без этого все картинки ролика
        // выходили одного цвета: 12 из 15 в замере попали в один сектор тона.
        // Подробности замера — в sceneLook.ts.
        const look = sceneLook(i, {
          withCharacter,
          seed: seedFromTitle(script.title),
        });
        await ctx.reply(
          `🎨 Сцена ${i + 1} из ${script.scenes.length} — ${lookLabel(look)}…`,
        );
        const illustration = await generateSceneIllustration(
          i,
          buildImagePrompt(
            script.scenes[i],
            session.styleNotes,
            withCharacter,
            look,
          ),
          undefined,
          session.imageModel,
          withCharacter,
        );
        const { imageFileName, resultUrl } = illustration;
        images[i] = illustration;
        updateSession(chatId, { images });

        // Вторая иллюстрация той же сцены: посреди реплики первая уезжает вниз
        // и растворяется, а эта открывается под ней. Рисуем её ПОСЛЕ первой и
        // ОТ НЕЁ ЖЕ — это единственное место, где сцепка нужна: обе картинки
        // видны почти одновременно, и расхождение стиля здесь бросается в
        // глаза. Между разными сценами такой сцепки, наоборот, быть не должно.
        const swapScene = script.scenes[i].swap?.scene;
        if (swapScene) {
          await ctx.reply(`🔄 Вторая картинка сцены ${i + 1}…`);
          try {
            const second = await generateSceneIllustration(
              i,
              buildImagePrompt(
                // swap.scene — уже описание кадра, поэтому оно идёт вместо
                // visual. Тон и план те же, что у первой картинки: обе видны
                // почти одновременно, и разный цвет читался бы как сбой.
                { ...script.scenes[i], visual: swapScene },
                session.styleNotes,
                false,
                look,
              ),
              resultUrl,
              session.imageModel,
              false,
              "swap",
            );
            images[i] = {
              ...illustration,
              swapImageFileName: second.imageFileName,
              swapImageWidth: second.imageWidth,
              swapImageHeight: second.imageHeight,
            };
            updateSession(chatId, { images });
            await ctx.replyWithPhoto(
              new InputFile(path.resolve("public/images", second.imageFileName)),
              { caption: `Сцена ${i + 1}, вторая картинка: ${swapScene}` },
            );
          } catch (error) {
            // Не получилась — сцена остаётся с одной картинкой. Ролик из-за
            // этого терять незачем.
            console.warn(
              `Вторая картинка сцены ${i + 1} не вышла: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        await ctx.replyWithPhoto(
          new InputFile(path.resolve("public/images", imageFileName)),
          { caption: `Сцена ${i + 1}: ${script.scenes[i].caption}` },
        );

        // Появляющийся объект: отдельная картинка с прозрачным фоном, которая
        // ляжет поверх этой же сцены, не заменяя её.
        const wanted = script.scenes[i].overlay?.object;
        if (wanted) {
          await ctx.reply(`✨ Объект для сцены ${i + 1}: ${wanted}…`);
          try {
            const { fileName } = await generateSceneOverlay(
              i,
              wanted,
              session.styleNotes,
              session.imageModel,
            );
            overlays[i] = {
              fileName,
              anchor: overlayAnchor(i),
              widthPercent: OVERLAY_WIDTH_PERCENT,
            };
            updateSession(chatId, { overlays });
            await ctx.replyWithPhoto(
              new InputFile(path.resolve("public/overlays", fileName)),
              {
                caption:
                  `Объект сцены ${i + 1} (фон вырезан). Появится на слове ` +
                  `«${script.scenes[i].overlay?.word ?? "—"}».`,
              },
            );
          } catch (error) {
            // Объект — украшение: если не получился, ролик собирается без него.
            overlays[i] = undefined;
            updateSession(chatId, { overlays });
            await ctx.reply(
              `Объект для сцены ${i + 1} не вышел (${
                error instanceof Error ? error.message : String(error)
              }). Собираю сцену без него.`,
            );
          }
        }
      }

      updateSession(chatId, { step: "idle", images, overlays });

      // Замер разнообразия — здесь, а не после сборки: если картинки вышли
      // одинаковыми, узнать об этом надо ДО того, как оплачена озвучка, и
      // пока сцену ещё можно перерисовать одной кнопкой.
      for (const line of await varietyMessage(chatId)) await ctx.reply(line);

      if (autopilotOn(chatId)) {
        await ctx.reply("🤖 Автопилот: картинки готовы, собираю видео.");
        return;
      }
      await ctx.reply("Как картинки?", { reply_markup: imagesKeyboard });
    },
    { retryData: "retry_images" },
  );

  // Та же причина, что и в шаге сценария: цепочка идёт снаружи withGeneration.
  if (autopilotContinues({ ok, session: getSession(chatId) })) {
    await runAssembleStep(ctx, chatId);
  }
}

/**
 * Картинки ИМЕННО ЭТОГО ролика. Папка между роликами не чистится, а имена в
 * ней постоянные — от прошлого ролика останутся лишние файлы, если сцен в нём
 * было больше.
 */
function sceneImageFiles(chatId: number): string[] {
  const images = getSession(chatId).images ?? [];
  return images.flatMap((image) =>
    image
      ? [image.imageFileName, image.swapImageFileName].filter(
          (name): name is string => Boolean(name),
        )
      : [],
  );
}

/**
 * Итог замера разнообразия одной строкой (или несколькими, если что-то не
 * дотянуло). Ничего не бросает: замер — это справка, и ронять из-за него шаг,
 * где уже оплачены картинки, нельзя.
 */
async function varietyMessage(chatId: number): Promise<string[]> {
  try {
    const images = await measureImages(PUBLIC_IMAGES_DIR, sceneImageFiles(chatId));
    // Одна-две картинки — сравнивать не с чем.
    if (images.length < 3) return [];
    const report = varietyReport(images);
    const lines = varietyLines(report);
    if (report.failed.length === 0) return [lines[0]];
    return [
      lines.join("\n"),
      "Перерисовка сцены меняет тон и план кадра — «🔄 Перегенерировать сцену».",
    ];
  } catch (error) {
    console.warn(
      `Замер разнообразия не вышел: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
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

      // Перегенерация одной сцены должна дать тот же тип кадра, что и общий
      // проход, иначе в середине ролика внезапно появится маскот.
      const regenWithCharacter = sceneWithCharacter(index, script.scenes.length);
      // Картинку просят перерисовать, потому что она НЕ понравилась. Значит,
      // повторять то же задание бессмысленно: сдвигаем тон и план. Шаг по
      // тону чётный, поэтому новый тон не совпадёт ни с предыдущей сценой, ни
      // со следующей — см. sceneLook.ts.
      const attempt = (images[index]?.attempt ?? 0) + 1;
      const look = sceneLook(index, {
        withCharacter: regenWithCharacter,
        seed: seedFromTitle(script.title),
        attempt,
      });
      await ctx.reply(`🎨 Перегенерирую сцену ${index + 1} — ${lookLabel(look)}…`);
      const illustration = await generateSceneIllustration(
        index,
        buildImagePrompt(
          script.scenes[index],
          session.styleNotes,
          regenWithCharacter,
          look,
        ),
        // Картинка предыдущей сцены НЕ передаётся: как референс она заставляет
        // модель повторить её композицию, и перерисованная сцена выходит
        // похожей на соседнюю — ровно то, от чего её просили избавить.
        undefined,
        session.imageModel,
        regenWithCharacter,
      );
      const { imageFileName } = illustration;
      images[index] = { ...illustration, attempt };
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
  // Скорость речи этого чата — до всего остального: от неё зависит и
  // бюджет слов сценария, и сам синтез.
  setSpeechSpeed(getSession(chatId).ttsSpeed);
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
    const clips = [...(session.clips ?? [])];
    const overlays = session.overlays ?? [];
    // Какие сцены оживляем клипом. Клип — самая дорогая часть сцены, поэтому
    // по умолчанию их нет вовсе; включается командой /clips.
    // Платные генерации — по счётчику /clips. Библиотечные клипы уже оплачены
    // и идут независимо от него: держать их за тем же счётчиком было ошибкой,
    // из-за неё при /clips 0 собранная библиотека не подставлялась никогда.
    const clipCount = session.clipScenes ?? config.clipScenes;
    const paid = new Set(clipSceneIndexes(script.scenes.length, clipCount));
    const fromLibrary = new Set(librarySceneIndexes(script.scenes.length));
    const mascotScenes = new Set(
      mascotSceneIndexes(script.scenes.length, config.mascotScenes),
    );
    const libraryReady = await readyClipIds();
    // Один и тот же жест два раза подряд выглядит как заевшая плёнка.
    const usedLibraryClips = new Set(
      clips.map((clip) => clip?.libraryId).filter(Boolean) as string[],
    );
    // Объект появляется на слове из озвучки, а слова известны только после
    // синтеза — поэтому момент считается здесь, а не при генерации картинки.
    const sceneOverlay = (i: number) => {
      const ready = overlays[i];
      if (!ready) return undefined;
      return {
        fileName: ready.fileName,
        anchor: ready.anchor,
        widthPercent: ready.widthPercent,
        startMs: overlayStartMs(
          audio[i]?.words ?? [],
          script.scenes[i].overlay?.word,
          ((audio[i]?.durationInFrames ?? 0) / config.fps) * 1000,
        ),
      };
    };
    // Про сочетание «клон + прокси Kie.ai» лучше сказать до озвучки, а не
    // после того, как ролик собран чужим голосом.
    if (!audio.length) {
      const warning = await cloneViaProxyWarning(
        session.voice ?? config.kieTtsVoice,
        session.ttsProvider,
      );
      if (warning) await ctx.reply(`⚠️ ${warning}`);
    }

    // Озвучка всего сценария ОДНИМ чтением: синтезатор ведёт интонацию через
    // весь ролик, а не читает каждую сцену как отдельное предложение с
    // падающим тоном в конце. Дорожка потом режется на сцены по таймингам
    // слов — они приходят от прямого ElevenLabs и считаются по символам
    // ВХОДНОГО текста, поэтому разрез попадает точно в стык слов.
    //
    // Делаем только когда озвучки нет вовсе: при повторе после сбоя часть сцен
    // уже оплачена, и переозвучивать всё заново ради интонации — плохой размен.
    if (audio.length === 0 || audio.every((item) => !item)) {
      await ctx.reply("🎙 Озвучиваю сценарий целиком — одним чтением…");
      try {
        const whole = await generateScriptAudio(
          script.scenes.map((scene) => scene.voiceoverText),
          PUBLIC_AUDIO_DIR,
          session.voice,
          session.ttsModel,
          session.ttsProvider,
        );
        if (whole) {
          for (const [i, item] of whole.entries()) audio[i] = item;
          updateSession(chatId, { audio });
          await ctx.reply(
            `Готово: одна дорожка, разрезана на ${whole.length} сцен(ы) по словам.`,
          );
        } else {
          // Через прокси Kie.ai таймингов не бывает, и резать нечем.
          await ctx.reply(
            "Таймингов слов нет — озвучиваю посценно, как раньше. Сквозная " +
              "интонация работает только на прямом ElevenLabs: /tts elevenlabs",
          );
        }
      } catch (error) {
        console.error(error);
        await ctx.reply(
          `Единая озвучка не получилась (${
            error instanceof Error ? error.message : String(error)
          }). Озвучиваю посценно.`,
        );
      }
    }

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

      // Оживление кадра. Первым кадром идёт уже согласованная картинка сцены,
      // поэтому подмена не видна на стыке. Готовые клипы кэшируем в сессии:
      // повторная сборка после сбоя не должна оплачивать их заново.
      // Клип живёт внутри карточки — сцене без неё он не нужен.
      if (!mascotScenes.has(i) && (paid.has(i) || fromLibrary.has(i)) && !clips[i]) {
        if (paid.has(i)) await ctx.reply(`🎞 Оживляю сцену ${i + 1}…`);
        clips[i] = await sceneClip({
          index: i,
          total: script.scenes.length,
          voiceoverText: script.scenes[i].voiceoverText,
          imageUrl: images[i]!.resultUrl,
          ready: libraryReady,
          used: usedLibraryClips,
          modelKey: session.videoModel,
          // Сцена попала сюда только из-за библиотеки — платить за неё не
          // договаривались.
          source: paid.has(i) ? undefined : "library",
        });
        const chosen = clips[i];
        if (chosen) {
          if (chosen.libraryId) usedLibraryClips.add(chosen.libraryId);
          updateSession(chatId, { clips });
          if (chosen.source === "library") {
            await ctx.reply(
              `Взял готовый клип из библиотеки — эта сцена бесплатна.`,
            );
          }
        } else if (paid.has(i)) {
          await ctx.reply(
            `Клип для сцены ${i + 1} не получился — она останется картинкой. ` +
              "Если это повторяется, проверьте слаг модели: /vidmodel",
          );
        }
      }

      scenes.push({
        caption: script.scenes[i].caption,
        voiceoverText: script.scenes[i].voiceoverText,
        audioFileName: audio[i].audioFileName,
        imageFileName: images[i]?.imageFileName,
        imageWidth: images[i]?.imageWidth,
        imageHeight: images[i]?.imageHeight,
        swapImageFileName: images[i]?.swapImageFileName,
        swapImageWidth: images[i]?.swapImageWidth,
        swapImageHeight: images[i]?.swapImageHeight,
        // Момент смены картинки, как и появление объекта, известен только
        // сейчас: он привязан к слову озвучки.
        swapStartMs: images[i]?.swapImageFileName
          ? overlayStartMs(
              audio[i].words ?? [],
              script.scenes[i].swap?.word,
              (audio[i].durationInFrames / config.fps) * 1000,
            )
          : undefined,
        mascotOnly: mascotScenes.has(i) || undefined,
        clipFileName: clips[i]?.clipFileName,
        clipDurationInFrames: clips[i]?.clipDurationInFrames,
        durationInFrames: audio[i].durationInFrames,
        // Слова с таймингами — для субтитров «по слову».
        words: audio[i].words,
        // Момент появления объекта известен только сейчас: он привязан к слову
        // из озвучки, а озвучка появляется на этом шаге.
        overlay: sceneOverlay(i),
      });
    }

    // Сколько в ролике движения — видно сразу, а не после просмотра. Нужно
    // потому, что оба приёма зависят от сценария: если модель не поставила ни
    // одного overlay и ни одного swap, ролик выйдет статичным, и это лучше
    // узнать здесь. Ровно так и пропустили пустые overlay в прошлый раз.
    const withOverlay = scenes.filter((scene) => scene.overlay).length;
    const withSwap = scenes.filter((scene) => scene.swapImageFileName).length;
    await ctx.reply(
      `Движение в кадре: смена картинки в ${withSwap} сцен(ах), ` +
        `появление объекта в ${withOverlay} из ${scenes.length}.` +
        (withSwap === 0 && withOverlay === 0
          ? "\n\n⚠️ Ни одного — ролик выйдет статичным. Это решает сценарий: " +
            "попросите «✏️ Правки» добавить смены картинок и появления объектов."
          : ""),
    );

    const limitSeconds = session.maxVideoSeconds ?? config.maxVideoSeconds;
    const fitted = fitToBudget(scenes, limitSeconds);
    const videoData: VideoData = {
      title: script.title,
      fps: config.fps,
      outro: buildOutro(),
      width: config.width,
      height: config.height,
      musicFileName: await pickMusic(),
      sfxEnabled: true,
      availableSfx: await listImportedSfx(),
      scenes: fitted.scenes,
    };
    await writeVideoData(videoData);

    if (fitted.overBudgetSeconds > 0.5) {
      await ctx.reply(
        `Внимание: ролик выходит на ${Math.round(fitted.totalSeconds)} с — ` +
          `дольше лимита ${limitSeconds} с. Паузы уже сжаты до ` +
          "предела, дальше сокращать можно только текст: нажмите «✏️ Правки» " +
          "у сценария и попросите короче — либо поднимите лимит: " +
          `/length ${Math.ceil(fitted.totalSeconds)}`,
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
        // CRF 20: компромисс между стандартным 18 и лёгким 23. Ролик уходит
        // документом, то есть без перекодирования на стороне Telegram, поэтому
        // качество исходника определяет то, что увидит зритель. Если файл не
        // влезет в лимит бота, ниже он сжимается отдельно.
        "--crf=20",
      ],
      { timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
    );

    // Размеры и длительность обязательны: без них Telegram не знает пропорций
    // и показывает вертикальный ролик квадратным превью.
    const totalFrames = fitted.scenes.reduce(
      (sum, s) => sum + s.durationInFrames,
      0,
    );
    const durationSeconds = Math.round(totalFrames / videoData.fps);

    // Даже с CRF 23 длинный ролик может не влезть в лимит бота. Проверяем
    // размер заранее: 413 от Telegram приходит уже после загрузки, и ролик,
    // за который заплачены генерации, остаётся лежать на сервере.
    let videoFile = path.resolve("out/video.mp4");

    // Громкость выравниваем по референсу. Это единственное, чем его звуковой
    // «фон» отличается от нашего: музыки там нет, а громкость на 2-3 дБ выше и
    // прижата лимитером. Картинку операция не пересчитывает (-c:v copy).
    if (config.masterLufs !== 0) {
      try {
        const mastered = path.resolve("out/video-loud.mp4");
        const { before, after, gainDb } = await masterLoudness(
          videoFile,
          mastered,
          config.masterLufs,
        );
        videoFile = mastered;
        console.log(
          `Громкость: ${before.lufs} → ${after.lufs} LUFS ` +
            `(${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} дБ), ` +
            `пик ${after.truePeakDb} dBTP, разброс ${after.lra} LU`,
        );
      } catch (error) {
        // Ролик уже готов — из-за громкости его терять незачем.
        console.error("Выравнивание громкости не удалось:", error);
      }
    }

    // Для соцсетей берём ролик ДО сжатия под Telegram: сжатие нужно только
    // чтобы файл пролез в чат, а на площадку надо отдавать лучшее, что есть.
    const publishFile = videoFile;

    const renderedBytes = await fileSizeBytes(videoFile);
    if (renderedBytes > SAFE_VIDEO_BYTES) {
      await ctx.reply(
        `Ролик получился ${formatMb(renderedBytes)} — для отправки ботом ` +
          "(лимит 50 МБ) многовато, сжимаю…",
      );
      const compressed = path.resolve("out/video-tg.mp4");
      const { bitrateKbps } = await compressToLimit(
        videoFile,
        compressed,
        durationSeconds,
      );
      videoFile = compressed;
      console.log(
        `Сжатие под Telegram: ${bitrateKbps} кбит/с, ` +
          `${formatMb(renderedBytes)} → ${formatMb(await fileSizeBytes(compressed))}`,
      );
    }

    // Обложку делаем сами: у документа Telegram превью не рисует.
    const thumbFile = path.resolve("out/thumb.jpg");
    let thumbnail: InputFile | undefined;
    try {
      await makeThumbnail(videoFile, thumbFile);
      thumbnail = new InputFile(thumbFile);
    } catch {
      // Без обложки файл всё равно уйдёт — это косметика.
    }

    // Отправляем документом, а не видео: sendVideo Telegram перекодирует под
    // стриминг, и качество теряется. Документ доходит байт в байт.
    await ctx.replyWithDocument(new InputFile(videoFile), {
      thumbnail,
      caption:
        `«${script.title}» готово — файлом, без сжатия Telegram.\n` +
        `${videoData.width}×${videoData.height}, ${durationSeconds} с, ` +
        `${formatMb(await fileSizeBytes(videoFile))}`,
    });

    // Ролик запоминаем ДО описания.
    //
    // Раньше это стояло внутри блока с описанием, и получалось так: ролик
    // отрендерен, отправлен, лежит на диске — а если описание не сгенерировалось
    // (сеть, лимит), /publish отвечал «публиковать нечего». Описание — текст
    // под пост, из-за него нельзя терять сам ролик. Пока описания нет, в
    // подписи будет название из сценария; настоящее подставим следом.
    rememberVideo(chatId, {
      file: publishFile,
      title: script.title,
      description: script.title,
      at: new Date().toISOString(),
    });

    // Текст под пост отдельным сообщением: так его удобно скопировать целиком,
    // не выцепляя из подписи к файлу.
    try {
      const { description, fixed, fromFallback, trimmed } =
        await generateDescription(script);
      await ctx.reply(description);
      const notes = [
        `📝 Описание под пост — ${description.length} символов.`,
        fixed ? `Переписал: ${fixed}.` : undefined,
        trimmed
          ? "Не уложилось в предел — обрезал по границе слова, хештеги на месте."
          : undefined,
        fromFallback
          ? "Собрано из сценария: модель описание не вернула."
          : undefined,
        "Новый ролик — /new",
      ].filter(Boolean);
      await ctx.reply(notes.join(" "));
      // Настоящее описание поверх заглушки: именно оно уйдёт текстом поста.
      rememberVideo(chatId, {
        file: publishFile,
        title: script.title,
        description,
        at: new Date().toISOString(),
      });
      if (isZernioConfigured()) {
        await ctx.reply(
          "Это же описание уйдёт текстом поста. Поменять — /caption, " +
            "опубликовать — /publish или /schedule 18:00",
        );
      }
    } catch (error) {
      // Видео уже отправлено и уже запомнено — из-за описания ролик терять
      // нельзя. Публиковать можно, но текстом поста будет название сценария,
      // и об этом надо сказать прямо.
      await ctx.reply(
        `Описание не получилось (${
          error instanceof Error ? error.message : String(error)
        }). Видео выше готово.` +
          (isZernioConfigured()
            ? " Опубликовать его можно, но текстом поста пойдёт название " +
              "ролика — задайте свой текст командой /caption."
            : "") +
          " Новый ролик — /new",
      );
    }
    resetSession(chatId);
    },
    { retryData: "retry_assemble" },
  );
}

bot.command(["start", "help"], async (ctx) => {
  await ctx.reply(
    "Бот собирает короткие вертикальные ролики с Шамилем.\n\n" +
      "/topics — темы дня из мира нейросетей (повестка + защита от повторов)\n" +
      "/new — начать новый ролик\n" +
      "/profiles — профили продуктов (роль + стиль референса)\n" +
      "/newprofile — создать профиль\n" +
      "/cancel — сбросить текущий диалог\n" +
      "/voice — посмотреть или сменить голос озвучки\n" +
      "/voices — список голосов, доступных вашему ключу ElevenLabs\n" +
      "/model — модель, которая пишет сценарий\n" +
      "/ttsmodel — модель озвучки\n" +
      "/length — лимит длины ролика в секундах\n" +
      "/speed — скорость речи\n" +
      "/variety — замер: не похожи ли картинки сцен друг на друга\n" +
      "/clips — сколько сцен оживлять видео (по умолчанию ни одной)\n" +
      "/library — библиотека клипов с маскотом (генерируется один раз)\n" +
      "/rules — чек-лист, по которому критик проверяет сценарий\n" +
      "/vidmodel — модель оживления кадра\n" +
      "/tts — провайдер озвучки (kie или elevenlabs)\n" +
      "/music — фоновая музыка: библиотека, загрузка и генерация\n" +
      "/addmusic — добавить свои треки в библиотеку\n" +
      "/clone — клонировать голос из своих роликов\n" +
      "/clonemore — добавить материал в уже созданный клон\n" +
      "/stems — разобрать чужую дорожку: что играет под речью\n" +
      "/autopilot — генерация без подтверждений на каждом шаге\n" +
      "/topicback — вернуть тему в подбор (ролик не доснят)\n" +
      "/topicsreset — забыть снятые темы (смена ниши канала)\n" +
      "/accounts — подключённые аккаунты соцсетей (Zernio)\n" +
      "/link — привязать аккаунт соцсети\n" +
      "/unlink — отвязать аккаунт\n" +
      "/caption — посмотреть или заменить текст поста\n" +
      "/publish — опубликовать последний ролик сразу\n" +
      "/schedule — календарь публикации (или /schedule 18:00)\n" +
      "/poststatus — что с последней публикацией\n" +
      "/retrypost — повторить неудачные площадки\n" +
      "/zprofiles — профили Zernio\n" +
      "/keys — какие ключи API заданы на сервере\n" +
      "/setkey — задать ключ прямо из чата (без ssh)\n" +
      "/restart — перезапустить бота, чтобы подхватить .env\n" +
      "/diag — проверить озвучку и найти рабочую модель\n" +
      "/deploy — обновить бота с GitHub прямо сейчас\n\n" +
      "Порядок: бриф → референс (по желанию) → сценарий с правками → " +
      "картинки с перегенерацией → озвучка и сборка.\n\n" +
      "Для потока проще: /topics → выбрать тему кнопкой → дальше как обычно. " +
      "Снятые темы бот помнит и второй раз не предлагает.\n\n" +
      `Автопилот: ${autopilotOn(ctx.chat.id) ? "включён" : "выключен"}\n` +
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

    const session = getSession(chatId);
    const warning = await cloneViaProxyWarning(current, session.ttsProvider);

    await ctx.reply(
      `Текущий голос: ${resolved}` +
        (resolved === current ? "" : ` (имя «${current}» → ID)`) +
        named +
        `\nПровайдер: ${session.ttsProvider ?? config.ttsProvider}` +
        `\nПохожесть: similarity ${config.ttsSimilarityBoost}, stability ` +
        `${config.ttsStability}, style ${config.ttsStyle}` +
        (config.ttsSpeakerBoost ? ", speaker boost вкл" : "") +
        (warning ? `\n\n⚠️ ${warning}` : "") +
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

// Длина ролика. Живёт в настройках чата, потому что от неё зависит и бюджет
// слов у сценариста, и подгонка при сборке — а лезть в .env на сервере ради
// одной цифры неудобно.
const MIN_LENGTH_SECONDS = 15;
const MAX_LENGTH_SECONDS = 120;

bot.command("speed", async (ctx) => {
  const chatId = ctx.chat.id;
  const current = getSession(chatId).ttsSpeed ?? config.ttsSpeed;
  const arg = (ctx.match ?? "").trim();

  if (!arg) {
    // Откуда значение — половина ответа. Скорость 1.13 стоит умолчанием в
    // коде, но старый ключ KIE_TTS_SPEED=1 в .env её перебивает, и снаружи
    // это выглядит так, будто настройка не работает. Видно должно быть сразу.
    const source =
      getSession(chatId).ttsSpeed !== undefined
        ? "задана в этом чате"
        : `из .env (в коде по умолчанию ${DEFAULT_SPEED})`;
    const stale =
      getSession(chatId).ttsSpeed === undefined && current !== DEFAULT_SPEED
        ? `\n\n⚠️ В .env стоит ${current}, а замер по референсу даёт ` +
          `${DEFAULT_SPEED}. Скорее всего там остался старый ключ ` +
          "KIE_TTS_SPEED=1 — он перебивает умолчание. Поправить можно прямо " +
          `отсюда: /speed ${DEFAULT_SPEED}.`
        : "";
    await ctx.reply(
      `Скорость речи: ${describeSpeed(current)} — ${source}.\n\n` +
        "Поменять: /speed 1.2 или /speed 120%. Обычная — /speed 1.\n\n" +
        "Ускоряет сам синтезатор, а не мы после записи: тайминги слов " +
        "приходят уже пересчитанными, и субтитры остаются на месте." +
        stale,
    );
    return;
  }

  const parsed = parseSpeed(arg);
  if (typeof parsed !== "number") {
    await ctx.reply(parsed.error);
    return;
  }
  updateSession(chatId, { ttsSpeed: parsed });
  await ctx.reply(
    `Скорость: ${describeSpeed(parsed)}.\n\n` +
      "Действует со следующей озвучки. Бюджет слов пересчитывается вместе с " +
      "ней: быстрее речь — больше слов влезает в те же секунды.",
  );
});

bot.command("variety", async (ctx) => {
  // Тот же замер, что бот показывает сам после отрисовки, — но по запросу и
  // подробно. Нужен, когда картинки уже нарисованы, а решить надо сейчас:
  // перерисовывать сцену или собирать как есть.
  const images = await measureImages(
    PUBLIC_IMAGES_DIR,
    sceneImageFiles(ctx.chat.id),
  );
  if (images.length < 3) {
    await ctx.reply(
      "Замерять нечего: картинок меньше трёх. Нарисуйте сцены — /new.",
    );
    return;
  }
  const report = varietyReport(images);
  const rows = images
    .map(
      (s) =>
        `${s.name.replace(/\.png$/, "").padEnd(16)} ${String(Math.round(s.hue)).padStart(4)}°  ` +
        `светлота ${s.lum.toFixed(2)}  занято ${(s.fill * 100).toFixed(0)}%`,
    )
    .join("\n");
  await ctx.reply(
    `${varietyLines(report).join("\n")}\n\n<pre>${rows}</pre>\n\n` +
      "Тон 30-45° — песочный беж, 160-190° — зелёно-бирюзовый, " +
      "200-220° — сине-стальной. Если почти все картинки в одном секторе, " +
      "ролик и выглядит стоящим на месте.",
    { parse_mode: "HTML" },
  );
});

bot.command("length", async (ctx) => {
  const chatId = ctx.chat.id;
  const current = getSession(chatId).maxVideoSeconds ?? config.maxVideoSeconds;
  const requested = Number(ctx.match.trim().replace(",", "."));

  if (!ctx.match.trim()) {
    await ctx.reply(
      `Лимит длины ролика: ${current} с.\n\n` +
        `Сменить: /length <секунды> (${MIN_LENGTH_SECONDS}-${MAX_LENGTH_SECONDS}).\n` +
        "От этого зависит и объём сценария (сценарист считает бюджет слов), и " +
        "подгонка при сборке. Reels, Shorts, TikTok и VK Клипы принимают и " +
        "больше минуты, так что 70-80 с — нормальный вариант, если хочется " +
        "плотных объяснений.",
    );
    return;
  }

  if (!Number.isFinite(requested) || requested < MIN_LENGTH_SECONDS || requested > MAX_LENGTH_SECONDS) {
    await ctx.reply(
      `Нужно число секунд от ${MIN_LENGTH_SECONDS} до ${MAX_LENGTH_SECONDS}. Например: /length 75`,
    );
    return;
  }

  const seconds = Math.round(requested);
  updateSession(chatId, { maxVideoSeconds: seconds });
  await ctx.reply(
    `Лимит длины: ${seconds} с. Сценарист получит бюджет примерно ` +
      `${Math.floor(seconds * 2.4)} слов озвучки.`,
  );
});

// Сколько сцен оживлять клипом. Это единственная настройка в проекте, которая
// заметно меняет стоимость ролика, поэтому цифру видно в чате и по умолчанию
// она нулевая.
const MAX_CLIP_SCENES = 5;

// Цену считаем по выбранной модели, а не по одной константе: между Mini и
// полной 2.0 разница больше чем вдвое, а длительность модель может поднять до
// своего минимума (Seedance 2 короче четырёх секунд не делает), и цифра «за
// две секунды» врала бы в полтора раза.
function clipCostNote(count: number, modelKey?: string): string {
  const spec = getVideoModel(modelKey);
  const seconds = clampClipSeconds(spec, config.clipSeconds);
  const cost = count * seconds * spec.pricePerSecond;
  return `${count} × ${seconds} с на ${spec.title} ≈ $${cost.toFixed(2)} за ролик`;
}

bot.command("clips", async (ctx) => {
  const chatId = ctx.chat.id;
  const current = getSession(chatId).clipScenes ?? config.clipScenes;
  const modelKey = getSession(chatId).videoModel;
  const requested = Number(ctx.match.trim());

  if (!ctx.match.trim()) {
    await ctx.reply(
      `Оживлённых сцен в ролике: ${current}` +
        (current > 0 ? ` (${clipCostNote(current, modelKey)})` : "") +
        ".\n\n" +
        `Сменить: /clips <число> (0-${MAX_CLIP_SCENES}).\n\n` +
        "Клип делается из уже согласованной картинки сцены — она идёт его " +
        "первым кадром, поэтому стиль не «уплывает». Оживляются в первую " +
        "очередь хук и финал: там движение важнее всего. Клип — самая дорогая " +
        "часть сцены, дороже картинки и озвучки вместе, поэтому по умолчанию " +
        "их нет.\n\n" +
        "Модель для этого выбирается отдельно: /vidmodel",
    );
    return;
  }

  if (
    !Number.isInteger(requested) ||
    requested < 0 ||
    requested > MAX_CLIP_SCENES
  ) {
    await ctx.reply(
      `Нужно целое число от 0 до ${MAX_CLIP_SCENES}. Например: /clips 2`,
    );
    return;
  }

  updateSession(chatId, { clipScenes: requested });
  await ctx.reply(
    requested === 0
      ? "Клипов не будет — все сцены останутся картинками."
      : `Оживляю ${requested} сцен(ы): ${clipCostNote(requested, modelKey)}.`,
  );
});

// Чек-лист, по которому критик проверяет сценарий. Живёт текстовым файлом, а
// не в коде, потому что правила вкуса меняются вместе с продуктом и
// площадкой: на контент-заводе правка правила не должна упираться в
// программиста и деплой.
bot.command("rules", async (ctx) => {
  const chatId = ctx.chat.id;
  const argument = ctx.match.trim();

  if (argument === "reset") {
    resetChecklist();
    await ctx.reply("Чек-лист возвращён к исходному. Посмотреть: /rules");
    return;
  }

  if (argument) {
    // Текст пришёл прямо в команде — обычно вставкой целиком.
    writeChecklist(argument);
    await ctx.reply(
      `Чек-лист обновлён (${argument.length} символов). ` +
        "Он применится к следующему сценарию — правки на сервере не нужны.",
    );
    return;
  }

  if (!config.scriptReview) {
    await ctx.reply(
      "Проверка критиком выключена (SCRIPT_REVIEW=0 в .env), чек-лист сейчас " +
        "ни на что не влияет.",
    );
    return;
  }

  const text = readChecklist();
  updateSession(chatId, { step: "awaiting_checklist" });
  await ctx.reply(
    "По этому чек-listу критик проверяет каждый сценарий. " +
      "Пришлите новый текст одним сообщением — он заменит нынешний. " +
      "Отмена — /cancel, вернуть исходный — /rules reset\n\n" +
      "———\n\n" +
      text.slice(0, 3500),
  );
});

// Библиотека клипов с маскотом: генерируется один раз и переиспользуется во
// всех роликах. Отдельная команда, потому что это не часть сборки конкретного
// видео — это разовая закупка, после которой оживление сцен становится
// бесплатным.
function libraryStatus(ready: Set<string>): string {
  const byRole = new Map<string, string[]>();
  for (const clip of CLIP_LIBRARY) {
    const line = `${ready.has(clip.id) ? "✅" : "▫️"} ${clip.title} (${clip.id})`;
    byRole.set(clip.role, [...(byRole.get(clip.role) ?? []), line]);
  }
  const titles: Record<string, string> = {
    intro: "Появление (хук)",
    reaction: "Реакция (середина)",
    handoff: "Показ (середина)",
    outro: "Прощание (финал)",
  };
  return [...byRole.entries()]
    .map(([role, lines]) => `*${titles[role] ?? role}*\n${lines.join("\n")}`)
    .join("\n\n");
}

bot.command("library", async (ctx) => {
  const chatId = ctx.chat.id;
  const argument = ctx.match.trim();
  const ready = await readyClipIds();

  const [verb, ...rest] = argument.split(/\s+/).filter(Boolean);

  if (verb === "build" || verb === "rebuild") {
    // Можно назвать роль («intro») или конкретные клипы — тогда трогаем
    // только их. Пересобирать все десять ради трёх — это лишние деньги.
    const selected = resolveClipSelection(rest);
    if (!selected) {
      await ctx.reply(
        `Не понял, что пересобирать: «${rest.join(" ")}».\n\n` +
          "Можно роль (intro, reaction, handoff, outro) или идентификаторы " +
          "клипов через пробел. Список: /library",
      );
      return;
    }
    const todo =
      verb === "rebuild"
        ? selected
        : selected.filter((clip) => !ready.has(clip.id));
    if (todo.length === 0) {
      await ctx.reply(
        rest.length
          ? `Эти клипы уже готовы. Перегенерировать заново: /library rebuild ${rest.join(" ")}`
          : "Библиотека уже собрана целиком. Пересобрать: /library rebuild",
      );
      return;
    }
    const spec = getVideoModel(getSession(chatId).videoModel);
    const seconds = clampClipSeconds(spec, config.clipSeconds);
    const cost = todo.length * seconds * spec.pricePerSecond;
    await withGeneration(ctx, chatId, async () => {
      await ctx.reply(
        `Генерирую ${todo.length} клип(ов) по ${seconds} с на ${spec.title}, ` +
          `примерно $${cost.toFixed(2)}. Это надолго — по паре минут на клип.`,
      );
      let done = 0;
      const failed: string[] = [];
      for (const clip of todo) {
        try {
          await generateLibraryClip(clip, config.clipSeconds, getSession(chatId).videoModel);
          done++;
        } catch (error) {
          failed.push(
            `${clip.title} — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await ctx.reply(
        `Готово ${done} из ${todo.length}: ` +
          todo.map((clip) => clip.title).join(", ") +
          "." +
          (failed.length ? `\n\nНе получились:\n${failed.join("\n")}` : "") +
          "\n\nПосмотреть: /library <id>. Состояние: /library",
      );
    });
    return;
  }

  if (argument) {
    const clip = getClipDefinition(argument);
    if (!clip) {
      await ctx.reply(
        `Не знаю клип «${argument}». Список: /library`,
      );
      return;
    }
    if (!ready.has(clip.id)) {
      await ctx.reply(
        `Клип «${clip.title}» ещё не сгенерирован. Собрать недостающие: /library build`,
      );
      return;
    }
    await ctx.replyWithVideo(
      new InputFile(path.join(CLIP_LIBRARY_DIR, libraryFileName(clip.id))),
      { caption: `${clip.title} — ${clip.action}` },
    );
    return;
  }

  // Файлы от переписанных клипов сами не удаляются: они оплачены, и решать
  // должен человек. Но показать их надо — иначе библиотека тихо обрастает
  // мусором, который никогда не подставится.
  const orphans = await orphanClipFiles();

  await ctx.reply(
    `🎭 Библиотека клипов с маскотом: готово ${ready.size} из ${CLIP_LIBRARY.length}.\n\n` +
      libraryStatus(ready) +
      (orphans.length
        ? `\n\n🗑 Лежат от прошлых версий и уже не используются:\n` +
          orphans.map((file) => `• \`${file}\``).join("\n") +
          "\nМожно удалить руками из assets/clips."
        : "") +
      "\n\nЭти клипы генерируются один раз и дальше подставляются в ролики " +
      "бесплатно — платить за оживление сцены приходится только там, где " +
      "готового клипа нет.\n\n" +
      "Собрать недостающие: /library build\n" +
      "Только одну роль: /library build intro\n" +
      "Перегенерировать заново: /library rebuild intro-lean\n" +
      "Посмотреть один: /library <id>",
    { parse_mode: "Markdown" },
  );
});

// Модель оживления кадра. Отдельная команда, а не кнопка в диалоге: здесь
// можно не просто выбрать модель, а проверить пробным запросом, что именно
// принимает аккаунт.
//
// Проба устроена так, потому что цена ошибки несимметрична. Отказ ничего не
// стоит: Kie.ai отвечает на createTask 422 сразу, задача не создаётся, денег
// не списывается — поэтому перебирать кандидатов можно свободно. А вот успех
// создаёт настоящую оплаченную генерацию, и перебирать после первого рабочего
// слага незачем: цикл на нём останавливается.
//
// Длительность берём минимальную допустимую для модели, а не «1 секунду»:
// Seedance 2 короче четырёх не делает, и проба на секунду отвергалась бы даже
// у верного слага — то есть врала бы.
async function probeVideoModels(ctx: Context): Promise<void> {
  await ctx.reply(
    "Проверяю модели пробным запросом. Отказ ничего не стоит — Kie.ai " +
      "отвергает неизвестную модель сразу, не создавая задачу. На первой " +
      "рабочей перебор останавливается: успех — это уже настоящая " +
      "оплаченная генерация.",
  );
  const lines: string[] = [];
  let found: (typeof VIDEO_MODELS)[number] | undefined;

  for (const spec of VIDEO_MODELS) {
    const result = await probeKieTask({
      model: spec.model,
      input: spec.buildInput(
        buildClipPrompt("проверка связи"),
        config.characterReferenceUrl,
        spec.minSeconds,
      ),
      timeoutMs: 180_000,
    });
    lines.push(
      `${result.ok ? "✅" : "❌"} ${spec.title} (\`${spec.model}\`) — ${result.detail}`,
    );
    if (result.ok) {
      found = spec;
      break;
    }
  }

  const skipped = VIDEO_MODELS.length - lines.length;
  const tail = found
    ? `\n\nРабочая модель: *${found.title}*. Выбрать её для этого чата: ` +
      `/vidmodel ${found.key}` +
      (skipped > 0 ? `\nОстальные ${skipped} не проверял — незачем.` : "")
    : "\n\nНи одна модель не принята. Сообщения выше от Kie.ai — в них " +
      "обычно написано, что именно не так: неизвестная модель, недопустимая " +
      "длительность или разрешение. Разрешение меняется без правки кода: " +
      "`CLIP_RESOLUTION` в .env (пробовать 720P прописной).";

  await ctx.reply(lines.join("\n") + tail, { parse_mode: "Markdown" });
}

bot.command("vidmodel", async (ctx) => {
  const chatId = ctx.chat.id;
  const argument = ctx.match.trim();

  if (argument === "probe") {
    await withGeneration(ctx, chatId, () => probeVideoModels(ctx));
    return;
  }

  if (argument) {
    const spec = VIDEO_MODELS.find((item) => item.key === argument);
    if (!spec) {
      await ctx.reply(
        `Не знаю ключ «${argument}». Доступны: ` +
          VIDEO_MODELS.map((item) => item.key).join(", "),
      );
      return;
    }
    updateSession(chatId, { videoModel: spec.key });
    await ctx.reply(
      `Оживляю кадры моделью ${spec.title}.` +
        (config.kieVideoModel
          ? "\n\n⚠️ Но выбор ни на что не влияет: `KIE_VIDEO_MODEL` в .env " +
            `перебивает реестр и жёстко задаёт слаг \`${config.kieVideoModel}\`. ` +
            "Очистите переменную, если хотите переключать модель из чата."
          : ""),
      { parse_mode: "Markdown" },
    );
    return;
  }

  const current = getSession(chatId).videoModel ?? DEFAULT_VIDEO_MODEL_KEY;
  const keyboard = new InlineKeyboard();
  for (const spec of VIDEO_MODELS) {
    keyboard
      .text(
        `${spec.key === current ? "⭐ " : ""}${spec.title}`,
        `vidmodel_${spec.key}`,
      )
      .row();
  }
  await ctx.reply(
    "Чем оживлять кадры?\n\n" +
      VIDEO_MODELS.map((spec) => `• ${spec.title} — ${spec.note}`).join("\n") +
      (config.kieVideoModel
        ? `\n\nСейчас всё перебивает \`KIE_VIDEO_MODEL\` из .env: \`${config.kieVideoModel}\`.`
        : "\n\nСлаги моделей не проверены на вашем аккаунте. Проверить " +
          "пробным запросом: /vidmodel probe"),
    { reply_markup: keyboard, parse_mode: "Markdown" },
  );
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

// Модель сценария. Раньше /model означало модель ОЗВУЧКИ — она переехала в
// /ttsmodel: моделей стало две, и «модель» без уточнения теперь естественнее
// читается как та, что пишет текст.
bot.command("model", async (ctx) => {
  const chatId = ctx.chat.id;
  const requested = ctx.match.trim();
  const stored = getSession(chatId).scriptModel;

  if (requested) {
    // Аргументом принимаем и ключ из списка, и произвольный слаг: ID моделей
    // на OpenRouter меняются чаще, чем наш список.
    updateSession(chatId, { scriptModel: requested });
    await ctx.reply(
      `Сценарий будет писать: ${resolveScriptModel(requested)}\n\n` +
        "Проверить — /new и обычный бриф. Модель озвучки — /ttsmodel.",
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const spec of SCRIPT_MODELS) {
    keyboard
      .text(
        `${spec.key === (stored ?? DEFAULT_SCRIPT_MODEL_KEY) ? "⭐ " : ""}${spec.title}`,
        `scriptmodel_${spec.key}`,
      )
      .row();
  }

  await ctx.reply(
    `Сценарий сейчас пишет: ${resolveScriptModel(stored)}\n\n` +
      SCRIPT_MODELS.map((spec) => `• ${spec.title} — ${spec.note}`).join("\n") +
      "\n\nЦены списочные, за один сценарий целиком. Для сравнения: 15 " +
      "картинок стоят около $1.35, так что на модели сценария экономить " +
      "почти нечего.\n\n" +
      "Можно задать любой слаг руками: /model <слаг с openrouter.ai/models>\n" +
      "Модель озвучки — /ttsmodel.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery(/^scriptmodel_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  const spec = getScriptModel(ctx.match[1]);
  updateSession(chatId, { scriptModel: spec.key });
  await ctx.reply(
    `Сценарий будет писать ${spec.title} (${spec.model}).\n` +
      "Дальше — /new и бриф.",
  );
});

bot.command("ttsmodel", async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  const provider = session.ttsProvider ?? config.ttsProvider;
  const requested = ctx.match.trim();

  if (!requested) {
    const current =
      session.ttsModel ??
      (provider === "elevenlabs" ? config.elevenLabsModelId : config.kieTtsModel);
    await ctx.reply(
      `Текущая модель озвучки: ${current}\n` +
        `Путь озвучки: ${provider === "elevenlabs" ? "прямой ElevenLabs" : "прокси Kie.ai"}\n\n` +
        (provider === "elevenlabs"
          ? `Модели прямого пути: ${DIRECT_TTS_MODELS.join(", ")}\n\n`
          : "") +
        "Сменить: /ttsmodel <имя модели>\n" +
        "Найти рабочую автоматически: /diag\n" +
        "Модель сценария — /model.",
    );
    return;
  }

  updateSession(chatId, { ttsModel: requested });
  // На прямом пути имя модели другое, чем у прокси. Раньше настройка туда не
  // доходила вовсе, и человек не понимал, почему ничего не изменилось.
  const note = provider === "elevenlabs" ? directModelNote(requested) : undefined;
  await ctx.reply(
    `Модель озвучки: ${requested}.` +
      (note ? `\n\n${note}` : "") +
      `\n\nПроверить — /voice ${session.voice ?? config.kieTtsVoice}`,
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

// Мгновенный клон не «дообучается»: отпечаток считается по набору сэмплов, и
// после двух-трёх минут добавка почти ничего не меняет. Это не предел — файлы
// принимаются и дальше, просто предупреждение, чтобы не ждать от объёма того,
// чего он не даёт.
const CLONE_ENOUGH_SECONDS = 180;

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

  // Тот же ролик, присланный второй раз, дальше не пускаем: ElevenLabs
  // отвергает повторную загрузку того же файла (400 duplicated_files) и валит
  // этим всю операцию. Сказать об этом здесь полезнее, чем на /done: видно,
  // какой именно файл лишний, и ничего не потеряно.
  const hash = await fileHash(target);
  for (const file of samples) {
    if ((await fileHash(file)) !== hash) continue;
    await rm(target, { force: true });
    await ctx.reply(
      "Этот файл уже есть в наборе — дорожка совпадает с присланной ранее " +
        "побайтово. Пропускаю: для голоса второй экземпляр той же записи " +
        "ничего не добавляет.",
    );
    return;
  }

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
        : total > CLONE_ENOUGH_SECONDS
          ? "Материала уже с запасом: мгновенный клон считает голос по всему " +
            "набору сразу, и после двух-трёх минут добавка на похожесть почти " +
            "не влияет.\n"
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
  if (getSession(chatId).cloneTargetVoiceId) {
    await runAddSamplesStep(ctx, chatId);
    return;
  }
  await runCloneStep(ctx, chatId);
});

// Добавление материала в уже существующий клон. Отдельная команда, потому что
// это принципиально другой сценарий: не «сделать новый голос», а «улучшить тот,
// который уже выбран для роликов».
bot.command("clonemore", async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isElevenLabsAvailable()) {
    await ctx.reply(
      "Нужен ELEVENLABS_API_KEY в .env на сервере: изменение клона идёт " +
        "напрямую через ElevenLabs.",
    );
    return;
  }
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }

  let clones;
  try {
    clones = (await listVoices()).filter((v) => v.category !== "premade");
  } catch (error) {
    await ctx.reply(
      `Не смог получить список голосов: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (clones.length === 0) {
    await ctx.reply(
      "В аккаунте нет клонированных голосов — сначала создайте: /clone",
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  const active = resolveVoiceId(getSession(chatId).voice ?? config.kieTtsVoice);
  for (const clone of clones.slice(0, 10)) {
    keyboard
      .text(
        `${clone.voiceId === active ? "▶️ " : ""}${clone.name}`,
        `clonemore_${clone.voiceId}`,
      )
      .row();
  }
  await ctx.reply(
    "В какой голос добавить материал?\n\n" +
      "Важно понимать, что произойдёт: мгновенный клон не «дообучается» — " +
      "ElevenLabs заново считает отпечаток голоса по всему набору сэмплов. " +
      "Старые сэмплы я скачаю и отправлю обратно вместе с новыми, так что " +
      "материал только добавится.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery(/^clonemore_(.+)$/, async (ctx) => {
  const voiceId = ctx.match[1];
  const chatId = ctx.chat?.id;
  await ctx.answerCallbackQuery();
  if (!chatId) return;

  let details;
  try {
    details = await getVoiceSamples(voiceId);
  } catch (error) {
    await ctx.reply(
      `Не смог посмотреть состав голоса: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const seconds = details.samples.reduce(
    (sum, sample) => sum + (sample.durationSeconds ?? 0),
    0,
  );
  updateSession(chatId, {
    step: "awaiting_clone_links",
    cloneName: details.name,
    cloneTargetVoiceId: voiceId,
    cloneSamples: undefined,
  });
  await ctx.reply(
    `Голос «${details.name}»: сейчас в нём ${details.samples.length} сэмпл(ов)` +
      (seconds > 0 ? `, примерно ${Math.round(seconds)} с материала` : "") +
      ".\n\nПрисылайте новые файлы или ссылки на Google Drive — по одному, " +
      "можно вперемешку. Когда всё — /done. Отменить — /cancel.",
  );
});

// ——— Разбор чужой дорожки на стемы ———

/**
 * Ответ на «а есть ли под речью музыка и какая». ElevenLabs умеет разделять
 * дорожку на стемы (v1/music/stem-separation): в режиме двух стемов это голос и
 * «минус». Слышно и видно по цифрам сразу: если минус тише голоса на 25+ дБ, то
 * под речью не музыка, а шум и звуки стыков.
 *
 * Важно про использование: вытащенный минус — чужая запись. Он годится
 * разобраться, что там играет, и повторить это своей генерацией. Ставить его в
 * свои ролики нельзя.
 */
const MUSIC_PRESENT_WITHIN_DB = 25;

async function runStemsStep(
  ctx: Context,
  chatId: number,
  sourceFile: string,
  variation: StemVariation,
): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), "amg-stems-"));
  try {
    const audio = path.join(workDir, "source.mp3");
    await extractAudio(sourceFile, audio);
    const seconds = await audioDurationSeconds(audio);

    // Тот же предел 11 МБ на файл, что и у остальных загрузок.
    const [fitted, ...extra] = await prepareUploadFiles([audio], workDir);
    if (extra.length > 0) {
      await ctx.reply(
        `Фрагмент длинный (${Math.round(seconds)} с) — разберу первые ` +
          `${Math.round(await audioDurationSeconds(fitted))} с: в один запрос ` +
          "больше 11 МБ не влезает.",
      );
    }

    await ctx.reply("🎛 Разделяю дорожку на стемы…");
    const stems = await separateStems({
      inFile: fitted,
      outDir: path.join(workDir, "stems"),
      variation,
    });

    const measured: { name: string; lufs: number; file: string }[] = [];
    for (const stem of stems) {
      try {
        const { lufs } = await measureLoudness(stem.file);
        measured.push({ name: stem.name, lufs, file: stem.file });
      } catch {
        measured.push({ name: stem.name, lufs: Number.NaN, file: stem.file });
      }
    }

    // Голосовой стем ElevenLabs называет vocals; если имя другое, берём самый
    // громкий — под речью он и есть голос.
    const vocals =
      measured.find((s) => /vocal|voice/i.test(s.name)) ??
      measured.reduce((a, b) => (b.lufs > a.lufs ? b : a));

    const lines = measured.map((s) => {
      const level = Number.isFinite(s.lufs) ? `${s.lufs} LUFS` : "тишина";
      const gap =
        s !== vocals && Number.isFinite(s.lufs) && Number.isFinite(vocals.lufs)
          ? ` (тише голоса на ${(vocals.lufs - s.lufs).toFixed(1)} дБ)`
          : "";
      return `• ${s.name}: ${level}${gap}`;
    });

    const backing = measured.filter((s) => s !== vocals && Number.isFinite(s.lufs));
    const loudest = backing.length
      ? backing.reduce((a, b) => (b.lufs > a.lufs ? b : a))
      : undefined;
    const verdict =
      loudest === undefined
        ? "Кроме голоса ничего не выделилось."
        : vocals.lufs - loudest.lufs <= MUSIC_PRESENT_WITHIN_DB
          ? `Под речью есть слой на ${(vocals.lufs - loudest.lufs).toFixed(1)} дБ ` +
            "тише голоса — послушайте, музыка это или шум зала."
          : `Всё, кроме голоса, тише его на ${(vocals.lufs - loudest.lufs).toFixed(1)} дБ ` +
            "— это уже уровень шума и звуков стыков, а не музыкальный фон.";

    await ctx.reply(`Готово. Стемы:\n${lines.join("\n")}\n\n${verdict}`);

    for (const stem of measured) {
      await ctx.replyWithAudio(new InputFile(stem.file), {
        title: stem.name,
      });
    }
    // Разобрали — теперь предлагаем законный путь: обмерить минус и заказать
    // генератору свой трек в том же темпе и тональности. Сам минус в библиотеку
    // не кладём: это чужая запись.
    if (loudest) {
      const sample = musicSamplePath(chatId);
      await mkdir(path.dirname(sample), { recursive: true });
      await copyFile(loudest.file, sample);
      try {
        const analysis = await analyzeMusic(sample);
        await ctx.reply(
          `Обмер «${loudest.name}»:\n` +
            (analysis.onsetContrast >= BEAT_FOUND_ABOVE
              ? `• темп ${analysis.bpm} BPM\n`
              : "• выраженного пульса нет\n") +
            `• тональность ${analysis.root} ${analysis.minor ? "минор" : "мажор"}\n` +
            `• по полосам: ${analysis.bands
              .map((b) => `${b.name} ${b.percent.toFixed(0)}%`)
              .join(", ")}\n\n` +
            "Описание для генератора:\n" +
            `«${musicPromptFromAnalysis(analysis)}»`,
          {
            reply_markup: new InlineKeyboard().text(
              "🎵 Сгенерировать похожий и добавить в библиотеку",
              "music_like",
            ),
          },
        );
      } catch (error) {
        await ctx.reply(
          `Обмерить минус не получилось: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await ctx.reply(
      "Сам вытащенный минус — чужая запись: он годится понять, что там играет, " +
        "и повторить это своей генерацией, но ставить его в свои ролики нельзя.",
    );
    updateSession(chatId, { step: "idle" });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Куда кладётся обмеренный минус — из него генерируется похожий трек. */
function musicSamplePath(chatId: number): string {
  return path.resolve("data/music-samples", `${chatId}.mp3`);
}

bot.callbackQuery("music_like", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  await withGeneration(ctx, chatId, async () => {
    const sample = musicSamplePath(chatId);
    let analysis;
    try {
      analysis = await analyzeMusic(sample);
    } catch {
      throw new Error(
        "Обмеренного трека уже нет на диске — разберите дорожку заново: /stems",
      );
    }
    const prompt = musicPromptFromAnalysis(analysis);
    await ensureMusicLibraryDir();
    await ctx.reply(
      "🎵 Заказываю свой трек по этому обмеру — минуту-две…\n\n" +
        `«${prompt}»`,
    );
    const raw = path.join(MUSIC_LIBRARY_DIR, `like-${Date.now()}.raw.mp3`);
    const info = await generateMusicTrack(prompt, raw);
    const { file, caption } = await addPreparedTrack(raw, "like");
    const made = await analyzeMusic(file);
    await ctx.replyWithAudio(new InputFile(file), {
      title: info.title ?? "Похожий трек",
      caption:
        `${caption}\n\nСверка с образцом: темп ${made.bpm} против ${analysis.bpm} BPM, ` +
        `тональность ${made.root} ${made.minor ? "минор" : "мажор"} против ` +
        `${analysis.root} ${analysis.minor ? "минор" : "мажор"}.`,
    });
  });
});

/**
 * Автопилот: сценарий → картинки → сборка без кнопок между шагами.
 *
 * Что он НЕ делает: не отменяет проверки. Структурные (ритм, длина хука,
 * реклама не в финале) и критик по чек-листу работают как раньше, и если после
 * правки объективные проверки не прошли — цепочка останавливается на сценарии,
 * до того как начнутся траты на картинки и озвучку.
 *
 * Чего он лишает: взгляда человека на сценарий перед отрисовкой. Автоматика
 * умеет проверить ритм и структуру, но не то, ведёт ли тема к продукту — а это
 * как раз то, из-за чего ролик может оказаться бесполезным при всех пройденных
 * проверках. Поэтому текст сообщения об этом и говорит: решение осознанное.
 */
// Темы дня: что происходит в мире нейросетей прямо сейчас.
//
// Контент-завод на одной теме перестаёт собирать охваты — два ролика подряд
// вышли про то, как нейросети делают картинки и контент, и для зрителя это
// один ролик, снятый дважды. Здесь тема берётся из новостей, а уже снятые
// уходят в запрос запретом.
//
// Предложенные темы держим в памяти процесса, а не в состоянии: они живут до
// нажатия кнопки, и переживать перезапуск бота им незачем.
const topicOffers = new Map<number, NewsTopic[]>();

async function sendTopics(ctx: Context, chatId: number): Promise<void> {
  const used = listShotTopics(chatId);
  await ctx.reply(
    used.length > 0
      ? `🗞 Смотрю повестку. Уже снятые темы (${used.length}) исключаю из подбора…`
      : "🗞 Смотрю, что сегодня в мире нейросетей…",
  );

  let result;
  try {
    result = await suggestNewsTopics(
      used,
      undefined,
      true,
      getSession(chatId).scriptModel ?? config.openRouterModel,
    );
  } catch (error) {
    await ctx.reply(
      `Не вышло подобрать темы: ${
        error instanceof Error ? error.message : String(error)
      }\n\nТему можно задать и руками: /new`,
    );
    return;
  }

  // Модель может предложить то же самое другими словами — отсеиваем до того,
  // как на теме будут потрачены сценарий и картинки.
  const fresh = result.topics.filter((t) => isFreshTopic(t.title, used));
  const dropped = result.topics.length - fresh.length;
  const offer = fresh.length > 0 ? fresh : result.topics;
  topicOffers.set(chatId, offer);

  const keyboard = new InlineKeyboard();
  offer.forEach((topic, i) => {
    keyboard.text(`${i + 1}. ${topic.title.slice(0, 48)}`, `topic_${i}`).row();
  });
  keyboard.text("Другие темы", "topic_more");

  const lines = offer.map(
    (t, i) =>
      `${i + 1}. ${t.title}` +
      (t.what ? `\n    ${t.what}` : "") +
      (t.why ? `\n    Чем цепляет: ${t.why}` : ""),
  );
  await ctx.reply(
    (result.webSearchUnavailable
      ? "⚠️ Веб-поиск не сработал — темы из памяти модели, за свежесть не ручаюсь.\n\n"
      : "") +
      lines.join("\n\n") +
      (dropped > 0
        ? `\n\nЕщё ${dropped} — про то, что уже снимали, их убрал.`
        : "") +
      (fresh.length === 0 && result.topics.length > 0
        ? "\n\n⚠️ Все предложенные темы похожи на уже снятые. Показываю как есть — " +
          "возможно, пора сменить нишу или почистить память: /topicsreset"
        : ""),
    { reply_markup: keyboard },
  );
}

bot.command("topics", async (ctx) => {
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  await sendTopics(ctx, ctx.chat.id);
});

bot.command("topicback", async (ctx) => {
  const chatId = ctx.chat.id;
  const shot = listShotTopics(chatId);
  if (shot.length === 0) {
    await ctx.reply("Снятых тем пока нет — возвращать нечего.");
    return;
  }

  const arg = (ctx.match ?? "").trim();
  // Без аргумента — последняя выбранная: обычно её и хотят вернуть, потому
  // что ролик не доснят. С числом — из списка ниже, с текстом — по названию.
  const which = arg ? (/^\d+$/.test(arg) ? Number(arg) - 1 : arg) : 0;
  const removed = forgetShotTopic(chatId, which);
  if (!removed) {
    await ctx.reply(
      `Не нашёл такую тему. Снятые темы:\n\n${numberedTopics(shot)}\n\n` +
        "Вернуть: /topicback <номер> или /topicback <часть названия>.",
    );
    return;
  }

  const left = listShotTopics(chatId);
  await ctx.reply(
    `Вернул в подбор: «${removed}».\n\n` +
      `Снятых тем осталось ${left.length}. Теперь /topics может предложить ` +
      "её снова — или начните ролик сразу: /new." +
      (left.length > 0 ? `\n\nПоследние:\n${numberedTopics(left.slice(0, 5))}` : ""),
  );
});

/** Пронумерованный список тем — по этим номерам работает /topicback. */
function numberedTopics(topics: string[]): string {
  return topics.map((title, i) => `${i + 1}. ${title}`).join("\n");
}

bot.command("topicsreset", async (ctx) => {
  const chatId = ctx.chat.id;
  const had = listShotTopics(chatId).length;
  forgetShotTopics(chatId);
  await ctx.reply(
    had === 0
      ? "Память тем и так пуста."
      : `Забыл ${had} снятых тем. Теперь подбор их не исключает.`,
  );
});

bot.callbackQuery(/^topic_(\d+)$/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const topic = topicOffers.get(chatId)?.[Number(ctx.match![1])];
  await ctx.answerCallbackQuery();
  if (!topic) {
    await ctx.reply("Список тем устарел — соберите заново: /topics");
    return;
  }
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }

  const session = getSession(chatId);
  // Роль из профиля сохраняем: тема дня ложится ПОВЕРХ неё, как и ручная тема.
  const base = session.profileId ? session.brief ?? "" : "";
  const brief = base
    ? `${base}\n\nТема этого ролика: ${topicBrief(topic)}`
    : topicBrief(topic);
  updateSession(chatId, { brief, step: "idle" });
  // Запоминаем СРАЗУ, а не после удачной сборки: если ролик не вышел, тема всё
  // равно уже обдумана, и предлагать её завтра снова незачем. Одну тему можно
  // вернуть — /topicback, всю память чистит /topicsreset.
  rememberShotTopic(chatId, topic.title);
  await ctx.reply(`Тема: ${topic.title}\n\nПишу сценарий…`);
  await runScriptStep(ctx, chatId);
});

bot.callbackQuery("topic_more", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  await sendTopics(ctx, ctx.chat!.id);
});

// ——— Ключи API из чата, без SSH ———
//
// Ключи живут только в .env на сервере: репозиторий публичный. Раньше это
// означало «зайдите по ssh и откройте nano», а весь смысл этого бота в том,
// что заходить никуда не надо.
//
// Опасность понятна: ключ, набранный в чат, остаётся в истории Telegram.
// Поэтому сообщение удаляется сразу, в ответ уходит только хвост из четырёх
// знаков, менять можно лишь перечисленные переменные, и всё это работает
// только при заданном TELEGRAM_ALLOWED_CHAT_ID — иначе бот открыт всем, кто
// его найдёт, и правка ключей из чата была бы дырой, а не удобством.

function keyEditingBlocked(chatId: number): string | undefined {
  if (!process.env.TELEGRAM_ALLOWED_CHAT_ID) {
    // Chat id печатаем прямо здесь. Раньше в этом сообщении стояло «смотрите
    // /diag», а /diag его не показывает вовсе — человек оставался с задачей
    // «узнайте число» без способа его узнать.
    return (
      "Правка ключей из чата выключена: не задан TELEGRAM_ALLOWED_CHAT_ID.\n\n" +
      "Пока он пуст, бот отвечает любому, кто его найдёт, — и любой мог бы " +
      "переписать ключи. Задайте его на сервере один раз (это тот самый случай, " +
      "когда без ssh не обойтись), после чего остальные ключи меняются отсюда.\n\n" +
      `Вписать в .env на сервере:\nTELEGRAM_ALLOWED_CHAT_ID=${chatId}\n\n` +
      "Потом: systemctl restart amg-bot"
    );
  }
  return undefined;
}

bot.command("keys", async (ctx) => {
  const blocked = keyEditingBlocked(ctx.chat.id);
  if (blocked) {
    await ctx.reply(blocked);
    return;
  }
  const lines = EDITABLE_KEYS.map((name) => {
    const inFile = getEnvValue(name);
    const live = process.env[name] ?? "";
    const pending =
      inFile && inFile !== live ? " ⏳ записан, но нужен перезапуск" : "";
    return `• ${keyStatusLine(name, inFile)}${pending}`;
  });
  await ctx.reply(
    "Ключи в .env на сервере:\n\n" +
      lines.join("\n") +
      "\n\nЗадать: /setkey ИМЯ значение\n" +
      "Сообщение с ключом я удалю сразу, в ответе будет только хвост.",
  );
});

bot.command("setkey", async (ctx) => {
  const blocked = keyEditingBlocked(ctx.chat.id);
  if (blocked) {
    await ctx.reply(blocked);
    return;
  }
  if (ctx.chat.type !== "private") {
    await ctx.reply(
      "Ключи принимаю только в личном чате: в группе сообщение видно всем, " +
        "и удаление уже не спасает.",
    );
    return;
  }

  const parsed = parseSetKey(ctx.match);

  // Удаляем сообщение с ключом ДО любых ответов и до записи на диск: если
  // дальше что-то упадёт, ключ всё равно не останется висеть в истории.
  let deleted = true;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message!.message_id);
  } catch {
    // Telegram не даёт удалять сообщения старше 48 часов и в некоторых
    // случаях чужие. Молчать об этом нельзя — человек должен знать, что ключ
    // остался в переписке.
    deleted = false;
  }

  if ("error" in parsed) {
    await ctx.reply(parsed.error);
    return;
  }

  try {
    setEnvValue(parsed.name, parsed.value);
  } catch (error) {
    await ctx.reply(
      `Не смог записать в .env: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  await ctx.reply(
    `${parsed.name} записан: ${maskSecret(parsed.value)}\n\n` +
      (deleted
        ? "Сообщение с ключом удалил.\n\n"
        : "⚠️ Удалить ваше сообщение не получилось — удалите его вручную, " +
          "ключ виден в переписке.\n\n") +
      "Чтобы ключ заработал, нужен перезапуск: /restart\n" +
      "Проверить, что записалось: /keys",
  );
});

bot.command("restart", async (ctx) => {
  if (generationRunning) {
    await ctx.reply("Идёт генерация — перезапущусь, когда закончится.");
    return;
  }
  await ctx.reply(
    "Перезапускаюсь, чтобы подхватить .env. Буду на связи через несколько " +
      "секунд — проверьте /keys",
  );
  try {
    // Тем же способом, что и деплой: отдельный юнит systemd переживает смерть
    // самого бота. Без systemd (запуск через npm run bot) перезапустить себя
    // нечем — об этом честно говорим.
    await execFileAsync("systemd-run", [
      "--collect",
      `--unit=amg-restart-${Date.now()}`,
      "/bin/bash",
      "-c",
      "sleep 1; systemctl restart amg-bot.service",
    ]);
  } catch {
    await ctx.reply(
      "Автоматически перезапуститься не вышло: бот запущен не как systemd-сервис. " +
        "Перезапустите его тем способом, которым запускали.",
    );
  }
});

// ——— Публикация ролика в соцсети ———
//
// Порядок один и тот же для «сразу» и «на время»: берём последний собранный
// ролик, заливаем файл, прогоняем через проверку форматов Zernio и только
// потом создаём пост. Проверка стоит ДО заливки на площадку намеренно: отказ
// по формату после публикации разгребать дороже.

async function publishFlow(
  ctx: Context,
  chatId: number,
  when: { publishNow: true } | { scheduledFor: string; timezone: string },
): Promise<void> {
  const video = getLastVideo(chatId);
  if (!video) {
    await ctx.reply(
      "Публиковать нечего: собранного ролика нет. Сделайте ролик — /topics или /new.",
    );
    return;
  }
  if (!existsSync(video.file)) {
    await ctx.reply(
      `Файл ролика не найден на сервере (${path.basename(video.file)}). ` +
        "Скорее всего, папка out очищена — соберите ролик заново.",
    );
    return;
  }

  let targets;
  try {
    const profileId = await resolveProfileId();
    const accounts = await listAccounts(profileId);
    targets = publishableTargets(accounts);
    if (targets.length === 0) {
      await ctx.reply(
        accounts.length === 0
          ? "Нет подключённых аккаунтов. Подключить: /link"
          : "Все подключённые аккаунты требуют повторной привязки: /link",
      );
      return;
    }
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
    return;
  }

  const where = targets.map((t) => platformTitle(t.platform)).join(", ");
  await ctx.reply(`Публикую «${video.title}» в: ${where}\n\nЗаливаю файл…`);

  try {
    const url = await uploadVideo(video.file);
    const body = buildPostBody(video, url, targets, when);

    // Прогон без публикации: их проверка знает пределы площадок лучше, чем
    // любые наши зашитые числа, и всегда свежее.
    try {
      const { errors, warnings } = await validatePost(body);
      if (errors.length > 0) {
        await ctx.reply(
          "Проверка форматов не пропустила:\n\n" +
            errors
              .map((e) => `• ${e.platform ? `${platformTitle(e.platform)}: ` : ""}${e.message}`)
              .join("\n") +
            "\n\nПубликацию не начинал.",
        );
        return;
      }
      if (warnings.length > 0) {
        await ctx.reply(
          "Замечания (публикую всё равно):\n" +
            warnings
              .map((w) => `• ${w.platform ? `${platformTitle(w.platform)}: ` : ""}${w.message}`)
              .join("\n"),
        );
      }
    } catch (error) {
      // Проверка — подстраховка, а не условие. Её сбой не повод не публиковать,
      // но и молчать о нём нельзя.
      await ctx.reply(
        `Проверку форматов сделать не вышло (${
          error instanceof Error ? error.message : String(error)
        }) — публикую без неё.`,
      );
    }

    const state = await createPost(video, url, targets, when);
    rememberPostId(chatId, state.id);

    if ("scheduledFor" in when) {
      const at = new Date(when.scheduledFor).toLocaleString("ru-RU", {
        timeZone: when.timezone,
        dateStyle: "short",
        timeStyle: "short",
      });
      await ctx.reply(
        `📅 Запланировано на ${at} (${when.timezone}).\n\n` +
          "Состояние — /poststatus",
      );
      return;
    }

    await ctx.reply(
      postStateLines(state, platformTitle).join("\n\n") +
        (isSettled(state)
          ? ""
          : "\n\nЧасть площадок ещё публикует — /poststatus"),
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
}

// ——— Календарь публикации ———
//
// Кнопками, а не текстом: набирать дату каждый раз неудобно, а промахнуться
// легко. Занятые дни помечены конвертом — видно, на что уже что-то стоит.
//
// Всё считается в поясе канала: сервер живёт по UTC, и «сегодня» у него и у
// человека — разные дни.

async function sendCalendar(
  ctx: Context,
  year: number,
  month: number,
  edit = false,
): Promise<void> {
  const tz = config.postTimezone;
  const today = todayIn(tz);

  // Отметки — приятная мелочь, а не условие: если список не пришёл, календарь
  // всё равно должен открыться.
  let marked = new Set<number>();
  try {
    const profileId = await resolveProfileId();
    marked = markedDays(await listScheduledDates(profileId), year, month, tz);
  } catch {
    // Молча: причину человек увидит на самой публикации.
  }

  const keyboard = new InlineKeyboard();
  const prev = prevMonth(year, month);
  const next = nextMonth(year, month);
  keyboard
    .text(`‹ ${monthTitle(prev.year, prev.month).split(" ")[0]}`, `cal_${prev.year}_${prev.month}`)
    .text(monthTitle(year, month), "cal_noop")
    .text(`${monthTitle(next.year, next.month).split(" ")[0]} ›`, `cal_${next.year}_${next.month}`)
    .row();
  for (const day of WEEKDAYS) keyboard.text(day, "cal_noop");
  keyboard.row();

  for (const week of monthGrid(year, month, today, marked)) {
    for (const cell of week) {
      keyboard.text(
        dayLabel(cell),
        cell.day === null || cell.isPast
          ? "cal_noop"
          : `calday_${year}_${month}_${cell.day}`,
      );
    }
    keyboard.row();
  }

  const text =
    "🕐 В какой день опубликовать?\n\n" +
    `Выберите дату или пришлите в формате: ${String(today.day).padStart(2, "0")}-` +
    `${String(today.month).padStart(2, "0")}-${today.year}, ` +
    `${String(today.hours).padStart(2, "0")}:${String(today.minutes).padStart(2, "0")}\n\n` +
    `Часовой пояс канала: ${tz}` +
    (marked.size > 0 ? `\n✉ — на этот день уже что-то запланировано` : "");

  if (edit) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

bot.callbackQuery("cal_noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^cal_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendCalendar(ctx, Number(ctx.match![1]), Number(ctx.match![2]), true);
});

bot.callbackQuery(/^calday_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const year = Number(ctx.match![1]);
  const month = Number(ctx.match![2]);
  const day = Number(ctx.match![3]);
  const tz = config.postTimezone;
  const today = todayIn(tz);
  const isToday = year === today.year && month === today.month && day === today.day;

  const keyboard = new InlineKeyboard();
  keyboard.text("↩️ Вернуться", `cal_${year}_${month}`).row();
  hourCells(isToday, today.hours, today.minutes).forEach((cell, i) => {
    keyboard.text(
      hourLabel(cell),
      cell.isPast ? "cal_past" : `calhour_${year}_${month}_${day}_${cell.hour}`,
    );
    if (i % 4 === 3) keyboard.row();
  });

  await ctx.editMessageText(
    "🕐 В какое время опубликовать?\n\n" +
      `Выбранная дата: ${humanDate(year, month, day)}\n\n` +
      "Выберите время кнопками или пришлите в формате: 21:31" +
      (isToday ? "\n\n· — этот час сегодня уже прошёл" : ""),
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("cal_past", async (ctx) => {
  await ctx.answerCallbackQuery({
    text: "Этот час уже прошёл — выберите позже или другой день.",
    show_alert: true,
  });
});

bot.callbackQuery(/^calhour_(\d+)_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const m = ctx.match as RegExpMatchArray;
  const [year, month, day, hour] = [m[1], m[2], m[3], m[4]].map(Number);
  const when = pickedMoment(year, month, day, hour, config.postTimezone);
  if ("error" in when) {
    await ctx.reply(when.error);
    return;
  }
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  await publishFlow(ctx, ctx.chat!.id, when);
});

bot.command("caption", async (ctx) => {
  const chatId = ctx.chat.id;
  const video = getLastVideo(chatId);
  if (!video) {
    await ctx.reply("Ролика пока нет — задавать текст не к чему.");
    return;
  }
  const text = (ctx.match ?? "").trim();
  if (!text) {
    await ctx.reply(
      `Текст поста сейчас (${video.description.length} символов):\n\n` +
        video.description +
        "\n\nПоменять: /caption и следом новый текст одним сообщением.",
    );
    return;
  }
  rememberVideo(chatId, { ...video, description: text });
  await ctx.reply(
    `Готово, ${text.length} символов. Публиковать: /publish или /schedule 18:00`,
  );
});

bot.command("publish", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  await publishFlow(ctx, ctx.chat.id, { publishNow: true });
});

bot.command("schedule", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    // Без аргументов — календарь. Текстовый ввод никуда не делся: он быстрее,
    // когда время известно заранее.
    const today = todayIn(config.postTimezone);
    await sendCalendar(ctx, today.year, today.month);
    return;
  }

  // Полная дата со временем — как в подсказке под календарём.
  const full = parseDateTime(arg, config.postTimezone);
  if (!("error" in full)) {
    await publishFlow(ctx, ctx.chat.id, full);
    return;
  }
  // Иначе пробуем короткую форму «18:00» или «завтра 09:30».
  const when = parseWhen(arg);
  if ("error" in when) {
    await ctx.reply(
      `${when.error}\n\nИли выберите кнопками: /schedule без аргументов.\n` +
        `Часовой пояс канала: ${config.postTimezone}`,
    );
    return;
  }
  await publishFlow(ctx, ctx.chat.id, when);
});

bot.command("poststatus", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  const postId = getLastPostId(ctx.chat.id);
  if (!postId) {
    await ctx.reply("Постов ещё не было. Опубликовать: /publish");
    return;
  }
  try {
    const state = await getPost(postId);
    const failed = state.platforms.filter((p) => p.status === "failed");
    await ctx.reply(
      `Пост: ${state.status}` +
        (state.scheduledFor
          ? ` (на ${new Date(state.scheduledFor).toLocaleString("ru-RU", {
              timeZone: config.postTimezone,
              dateStyle: "short",
              timeStyle: "short",
            })})`
          : "") +
        "\n\n" +
        postStateLines(state, platformTitle).join("\n\n") +
        (failed.length > 0 ? "\n\nПовторить неудачные — /retrypost" : ""),
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
});

bot.command("retrypost", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  const postId = getLastPostId(ctx.chat.id);
  if (!postId) {
    await ctx.reply("Повторять нечего: постов ещё не было.");
    return;
  }
  await ctx.reply("Повторяю публикацию…");
  try {
    const state = await retryPost(postId);
    await ctx.reply(postStateLines(state, platformTitle).join("\n\n"));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
});

// ——— Привязка аккаунтов соцсетей через Zernio ———
//
// Только привязка: посмотреть подключённое, подключить новое, отключить.
// Публикация — отдельная работа, её просили сделать позже, и мешать в одну
// кучу не стоит: привязку можно проверить руками сегодня, а постинг тянет за
// собой расписание, лимиты площадок и разбор ошибок публикации.

async function requireZernio(ctx: Context): Promise<boolean> {
  if (isZernioConfigured()) return true;
  await ctx.reply(
    "Zernio не подключён: нет ZERNIO_API_KEY.\n\n" +
      "Ключ берётся в личном кабинете zernio.com и кладётся в .env НА СЕРВЕРЕ — " +
      "в репозиторий он не попадает, репозиторий публичный. После правки .env " +
      "перезапустите бота: /deploy",
  );
  return false;
}

bot.command("accounts", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  await ctx.reply("Смотрю подключённые аккаунты…");
  try {
    const profileId = await resolveProfileId();
    const accounts = await listAccounts(profileId);
    if (accounts.length === 0) {
      await ctx.reply(
        "Подключённых аккаунтов нет. Подключить: /link",
      );
      return;
    }
    const broken = accounts.filter((a) => a.needsReconnection);
    await ctx.reply(
      `Подключено ${accounts.length}:\n\n` +
        accounts.map((a) => `• ${accountLine(a)}`).join("\n") +
        (broken.length > 0
          ? `\n\n⚠️ ${broken.length} аккаунт(ов) требуют повторной привязки — ` +
            "площадка сообщила, что доступ отозван. Лечится тем же /link."
          : "") +
        "\n\nПодключить ещё — /link, отключить — /unlink",
    );
  } catch (error) {
    await ctx.reply(
      error instanceof Error ? error.message : String(error),
    );
  }
});

bot.command("link", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  const keyboard = new InlineKeyboard();
  for (const platform of PRIMARY_PLATFORMS) {
    keyboard.text(platformTitle(platform), `zlink_${platform}`).row();
  }
  keyboard.text("Другие площадки", "zlink_more");
  await ctx.reply(
    "Какую площадку подключаем?\n\n" +
      "⚠️ ВКонтакте Zernio не поддерживает — VK Клипы придётся заливать " +
      "отдельно. Список площадок взят из их спецификации, не из головы.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("zlink_more", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard();
  const rest = ZERNIO_PLATFORMS.filter((p) => !PRIMARY_PLATFORMS.includes(p));
  rest.forEach((platform, i) => {
    keyboard.text(platformTitle(platform), `zlink_${platform}`);
    if (i % 2 === 1) keyboard.row();
  });
  await ctx.reply("Остальные площадки:", { reply_markup: keyboard });
});

bot.callbackQuery(/^zlink_(.+)$/, async (ctx) => {
  const platform = ctx.match![1] as ZernioPlatform;
  await ctx.answerCallbackQuery();
  if (!ZERNIO_PLATFORMS.includes(platform)) return;
  if (!(await requireZernio(ctx))) return;

  try {
    const profileId = await resolveProfileId();
    const url = await connectUrl(platform, profileId);
    await ctx.reply(
      `Подключение ${platformTitle(platform)}.\n\n` +
        "Откройте ссылку и войдите в свой аккаунт — дальше Zernio всё сделает " +
        "сам и вернёт вас обратно:\n\n" +
        url +
        "\n\n⚠️ Ссылка одноразовая и привязывает аккаунт К НАШЕМУ профилю " +
        "Zernio. Никому её не пересылайте.\n\n" +
        "Когда закончите — /accounts, там будет видно, подключилось ли.",
      { link_preview_options: { is_disabled: true } },
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
});

bot.command("unlink", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  try {
    const profileId = await resolveProfileId();
    const accounts = await listAccounts(profileId);
    if (accounts.length === 0) {
      await ctx.reply("Отключать нечего — подключённых аккаунтов нет.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const account of accounts) {
      keyboard.text(accountLine(account).slice(0, 60), `zunlink_${account.id}`).row();
    }
    await ctx.reply("Какой аккаунт отключить?", { reply_markup: keyboard });
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
});

bot.callbackQuery(/^zunlink_(.+)$/, async (ctx) => {
  const accountId = ctx.match![1];
  await ctx.answerCallbackQuery();
  // Отключение необратимо: подключать придётся заново через OAuth. Поэтому
  // спрашиваем ещё раз, а не выполняем по первому касанию.
  //
  // Кнопка отмены называется zcancel, а НЕ zunlink_cancel. Второе выглядит
  // стройнее, но попадает вот в этот же обработчик: «Отмена» читалась бы как
  // аккаунт с id «cancel», и диалог подтверждения показывался бы снова. Проверено
  // на настоящем grammY — порядок регистрации тут не спасает, потому что этот
  // обработчик стоит выше.
  const keyboard = new InlineKeyboard()
    .text("Да, отключить", `zunlinkyes_${accountId}`)
    .text("Отмена", "zcancel");
  await ctx.reply(
    "Отключить аккаунт? Публиковать в него будет нельзя, а обратно — только " +
      "через повторный вход по ссылке.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("zcancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Оставил как есть.");
});

bot.callbackQuery(/^zunlinkyes_(.+)$/, async (ctx) => {
  const accountId = ctx.match![1];
  await ctx.answerCallbackQuery();
  if (!(await requireZernio(ctx))) return;
  try {
    await disconnectAccount(accountId);
    await ctx.reply("Отключил. Список: /accounts");
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
});

bot.command("zprofiles", async (ctx) => {
  if (!(await requireZernio(ctx))) return;
  try {
    const profiles = await listZernioProfiles();
    const active = await resolveProfileId();
    await ctx.reply(
      "Профили Zernio (аккаунты подключаются внутрь профиля):\n\n" +
        profiles
          .map(
            (p) =>
              `• ${p.name}${p.isDefault ? " (по умолчанию)" : ""}` +
              `${p.id === active ? " ← используем" : ""}`,
          )
          .join("\n") +
        "\n\nСменить — задайте ZERNIO_PROFILE_ID в .env на сервере.",
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
});

bot.command("autopilot", async (ctx) => {
  const chatId = ctx.chat.id;
  const next = parseAutopilotArg(ctx.match, autopilotOn(chatId));

  updateSession(chatId, { autopilot: next });

  if (!next) {
    await ctx.reply(
      "Автопилот выключен. Каждый шаг снова ждёт кнопки: сценарий → " +
        "картинки → сборка.",
    );
    return;
  }

  const clips = getSession(chatId).clipScenes ?? config.clipScenes;
  await ctx.reply(
    "🤖 Автопилот включён. Один бриф — и дальше без кнопок: сценарий, " +
      "картинки, озвучка, сборка, готовое видео.\n\n" +
      "Проверки при этом никуда не делись. Если после автоправки в сценарии " +
      "останется объективная проблема (ритм, длина хука, реклама не в финале), " +
      "цепочка встанет на сценарии — до трат на картинки.\n\n" +
      "Чего вы лишаетесь: взгляда на сценарий перед отрисовкой. Проверить " +
      "ритм и структуру я могу, а ведёт ли тема к продукту — нет. Ролик с " +
      "хорошим ритмом и мимо продукта пройдёт все проверки.\n\n" +
      (clips > 0
        ? `⚠️ Оживление кадров включено (${clips} сцен) — это самая дорогая ` +
          "часть, и на автопилоте она тоже пойдёт без подтверждения. " +
          "Выключить: /clips\n\n"
        : "") +
      "Быстрее всего так: /profiles → выбрать профиль → отправить тему (или " +
      "/skip) → и ждать готовое видео. Два касания на ролик.\n\n" +
      "Выключить автопилот — /autopilot off",
  );
});

bot.command("stems", async (ctx) => {
  if (!isElevenLabsAvailable()) {
    await ctx.reply(
      "Для разделения на стемы нужен ELEVENLABS_API_KEY в .env на сервере.",
    );
    return;
  }
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  const six = /six|6/.test(ctx.match ?? "");
  updateSession(ctx.chat.id, {
    step: "awaiting_stems_source",
    stemsVariation: six ? "six_stems_v1" : "two_stems_v1",
  });
  await ctx.reply(
    "Пришлите видео, аудио или ссылку на Google Drive — разберу дорожку на " +
      "стемы и покажу, что под речью.\n\n" +
      (six
        ? "Режим: шесть стемов (вокал, барабаны, бас и остальное)."
        : "Режим: два стема (голос и минус). Шесть — /stems six.") +
      "\n\nОтменить — /cancel.",
  );
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

/**
 * Добавление материала в существующий клон.
 *
 * В запрос уходит только новый материал. Прежние сэмплы мы всё равно скачиваем,
 * но как страховку, а не как часть запроса: ElevenLabs отвергает файл, который
 * в голосе уже лежит, — 400 duplicated_files, «You cannot upload the same file
 * twice». Этой ошибкой он же и ответил на вопрос, который в документации не
 * описан: edit ДОПОЛНЯЕТ набор сэмплов, а не заменяет его — иначе сравнивать
 * присланное с уже лежащим не имело бы смысла.
 */
async function runAddSamplesStep(ctx: Context, chatId: number): Promise<void> {
  await withGeneration(
    ctx,
    chatId,
    async () => {
      const session = getSession(chatId);
      const voiceId = session.cloneTargetVoiceId;
      const parts = session.cloneSamples ?? [];
      if (!voiceId) throw new Error("Не выбран голос — начните заново: /clonemore");
      if (parts.length === 0) {
        throw new Error("Нет ни одного нового файла. Пришлите их, потом /done.");
      }

      const before = await getVoiceSamples(voiceId);
      const workDir = await mkdtemp(path.join(tmpdir(), "amg-clonemore-"));
      try {
        let newSeconds = 0;
        for (const file of parts) newSeconds += await audioDurationSeconds(file);

        const merged = path.join(workDir, "new.mp3");
        await concatAudio(parts, merged);
        await ctx.reply(
          `Нового материала: ${Math.round(newSeconds)} с из ${parts.length} файл(ов).`,
        );

        await ctx.reply("🧹 Убираю музыку с фона…");
        const cleaned = path.join(workDir, "new-clean.mp3");
        await isolateVoice(merged, cleaned);
        await ctx.replyWithAudio(new InputFile(cleaned), {
          title: `${before.name} — новый материал без музыки`,
          caption: "Это добавляется к голосу.",
        });

        // Копии прежних сэмплов — страховка на случай, если набор всё же
        // заменится: тогда старый материал не пропадёт, мы пришлём его файлами
        // в чат. В сам запрос они не идут (см. комментарий к функции).
        const backups = new Map<string, string>();
        for (const sample of before.samples) {
          const file = path.join(workDir, `old-${sample.sampleId}.mp3`);
          try {
            await downloadVoiceSample(voiceId, sample.sampleId, file);
            backups.set(sample.sampleId, file);
          } catch {
            // Страховка не удалась — на саму операцию это не влияет.
          }
        }

        await ctx.reply("🧬 Обновляю голос…");
        await editInstantVoiceClone({
          voiceId,
          name: before.name,
          files: [cleaned],
        });

        // Проверяем результат по составу голоса — это то, что можно увидеть
        // глазами, а не поверить на слово.
        const after = await getVoiceSamples(voiceId);

        // Прежние сэмплы должны остаться на месте. Если какой-то исчез, набор
        // всё-таки заменился — отдаём страховочные копии в чат, пока рабочая
        // папка не удалена.
        const lost = before.samples.filter(
          (sample) => !after.samples.some((s) => s.sampleId === sample.sampleId),
        );
        if (lost.length > 0) {
          await ctx.reply(
            `⚠️ ElevenLabs не дополнил набор, а заменил его: из голоса ушли ` +
              `${lost.length} прежних сэмпл(ов). Присылаю их файлами — чтобы ` +
              "вернуть материал, добавьте их через /clonemore.",
          );
          for (const sample of lost) {
            const file = backups.get(sample.sampleId);
            if (file) {
              await ctx.replyWithAudio(new InputFile(file), {
                title: `${before.name} — прежний сэмпл ${sample.fileName}`,
              });
            }
          }
        }
        const secondsBefore = before.samples.reduce(
          (sum, s) => sum + (s.durationSeconds ?? 0),
          0,
        );
        const secondsAfter = after.samples.reduce(
          (sum, s) => sum + (s.durationSeconds ?? 0),
          0,
        );

        updateSession(chatId, {
          voice: voiceId,
          step: "idle",
          cloneName: undefined,
          cloneSamples: undefined,
          cloneTargetVoiceId: undefined,
        });
        await rm(cloneDir(chatId), { recursive: true, force: true });

        await ctx.reply(
          `Готово. Голос «${after.name}»:\n` +
            `сэмплов было ${before.samples.length}, стало ${after.samples.length}` +
            (secondsAfter > 0
              ? `\nматериала было ${Math.round(secondsBefore)} с, стало ${Math.round(secondsAfter)} с`
              : "") +
            `\nVoice ID: ${voiceId}`,
        );

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
            "Так голос звучит после добавления. Ещё материал — /clonemore, " +
            "новый голос с нуля — /clone.",
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    {
      errorStep: "awaiting_clone_links",
      errorHint: "Присланные файлы сохранены — повторите /done или /cancel.",
    },
  );
}

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
  keyboard.text("⬆️ Загрузить свои треки", "music_upload").row();
  if (tracks.length > 0) {
    keyboard.text("🎚 Привести треки к порядку", "music_prepare").row();
    keyboard.text("🗑 Очистить библиотеку", "music_clear");
  }

  await ctx.reply(
    (tracks.length === 0
      ? "Библиотека музыки пуста — ролики собираются без фона.\n\n"
      : `В библиотеке ${tracks.length} трек(ов):\n` +
        tracks.map((t) => `• ${t}`).join("\n") +
        "\n\nДля каждого ролика берётся случайный.\n\n") +
      "Можно загрузить свои файлы кнопкой ниже или сгенерировать трек " +
      "(Suno через Kie.ai, ~1-2 минуты, тратит кредиты). Генерацию можно " +
      "нажать несколько раз — соберётся набор на разные настроения:",
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
    const raw = path.join(MUSIC_LIBRARY_DIR, `${preset.key}-${Date.now()}.raw.mp3`);
    const info = await generateMusicTrack(preset.prompt, raw);
    const { file, caption } = await addPreparedTrack(raw, preset.key);

    await ctx.replyWithAudio(new InputFile(file), {
      title: info.title ?? preset.title,
      caption,
    });
  });
});

/**
 * Кладёт трек в библиотеку, приведя его к рабочему виду: ровная громкость,
 * освобождённое место под голос, бесшовная петля. Без этого громкость подложки
 * зависела от того, каким мастерингом её отдал генератор.
 */
async function addPreparedTrack(
  rawFile: string,
  keyName: string,
): Promise<{ file: string; caption: string }> {
  const target = path.join(MUSIC_LIBRARY_DIR, `${keyName}-${Date.now()}.wav`);
  const result = await prepareMusicTrack(rawFile, target);
  await rm(rawFile, { force: true });
  return {
    file: target,
    caption:
      `Добавлен в библиотеку: ${path.basename(target)}\n` +
      `Громкость выровнена: ${result.before.lufs} → ${result.after.lufs} LUFS` +
      (result.looped ? ", петля склеена без щелчка" : "") +
      "\nБудет случайно подмешиваться в ролики. Ещё треки — /music",
  };
}

/**
 * Кладёт в библиотеку присланный файл. Дорожка вытаскивается из чего угодно
 * (видео, аудио, голосовое), поэтому «музыкой» может стать и звук из ролика.
 */
async function addUploadedTrack(
  ctx: Context,
  sourceFile: string,
  originalName: string,
): Promise<void> {
  await ensureMusicLibraryDir();
  const workDir = await mkdtemp(path.join(tmpdir(), "amg-music-up-"));
  try {
    // Через extractAudio, а не напрямую: присылают и видео, и m4a, и ogg, а
    // подготовке нужна обычная дорожка.
    const raw = path.join(workDir, "source.mp3");
    await extractAudio(sourceFile, raw);

    const target = path.join(MUSIC_LIBRARY_DIR, libraryTrackName(originalName));
    const result = await prepareMusicTrack(raw, target);
    await ctx.reply(
      `✅ ${path.basename(target)}\n` +
        `Громкость выровнена: ${result.before.lufs} → ${result.after.lufs} LUFS` +
        (result.looped
          ? `, петля склеена (${result.secondsBefore.toFixed(0)} → ${result.secondsAfter.toFixed(0)} с)`
          : ", трек короткий — петлю не склеивал") +
        "\n\nПрисылайте ещё или /done, чтобы закончить.",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

bot.callbackQuery("music_upload", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startMusicUpload(ctx);
});

bot.command("addmusic", async (ctx) => {
  await startMusicUpload(ctx);
});

async function startMusicUpload(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (generationRunning) {
    await ctx.reply("Сейчас идёт генерация — дождитесь её окончания.");
    return;
  }
  updateSession(chatId, { step: "awaiting_music_upload" });
  await ctx.reply(
    "Присылайте треки — по одному, можно подряд. Годятся аудиофайлы и видео " +
      "(возьму из них дорожку), а файлы больше 20 МБ — ссылкой на Google Drive: " +
      "больше Telegram боту не отдаёт.\n\n" +
      "Каждый трек я подготовлю: выровняю громкость под остальные, уберу низ, " +
      "который мешает ударам на склейках, и склею бесшовную петлю.\n\n" +
      "Загружайте только то, на что у вас есть права: за чужой трек площадка " +
      "может заглушить ролик.\n\n" +
      "Закончить — /done, отменить — /cancel.",
  );
}

bot.callbackQuery("music_prepare", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat!.id;
  await withGeneration(ctx, chatId, async () => {
    const tracks = await listMusicTracks();
    if (tracks.length === 0) {
      await ctx.reply("Библиотека пуста — приводить нечего.");
      return;
    }
    await ctx.reply(`🎚 Обрабатываю ${tracks.length} трек(ов)…`);
    const lines: string[] = [];
    for (const track of tracks) {
      try {
        const { file, result } = await prepareMusicTrackInPlace(
          path.join(MUSIC_LIBRARY_DIR, track),
        );
        lines.push(
          `• ${path.basename(file)}: ${result.before.lufs} → ${result.after.lufs} LUFS` +
            (result.looped ? ", петля склеена" : ""),
        );
      } catch (error) {
        lines.push(
          `• ${track}: не получилось — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await ctx.reply(
      `Готово:\n${lines.join("\n")}\n\nТеперь все треки одинаковой громкости, ` +
        "низ ниже 60 Гц убран, полоса разборчивости речи приглушена на 3 дБ.",
    );
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

bot.callbackQuery(/^vidmodel_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const spec = getVideoModel(ctx.match[1]);
  updateSession(ctx.chat!.id, { videoModel: ctx.match[1] });
  await ctx.reply(`Оживляю кадры моделью ${spec.title}.`);
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
  const step = getSession(chatId).step;
  if (
    step !== "awaiting_clone_links" &&
    step !== "awaiting_stems_source" &&
    step !== "awaiting_music_upload"
  ) {
    return;
  }

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
        if (step === "awaiting_stems_source") {
          await runStemsStep(
            ctx,
            chatId,
            localPath,
            getSession(chatId).stemsVariation ?? "two_stems_v1",
          );
        } else if (step === "awaiting_music_upload") {
          // Имя для библиотеки берём из присланного файла, а не из пути в
          // Telegram: тот выглядит как «music/file_12.mp3» и в списке треков
          // ничего не говорит.
          const sent =
            ctx.message?.audio?.file_name ??
            ctx.message?.document?.file_name ??
            ctx.message?.audio?.title ??
            path.basename(file.file_path);
          await addUploadedTrack(ctx, localPath, sent);
          // Шаг возвращаем: withGeneration после успеха сбрасывает его в idle, а
          // треки присылают подряд.
          updateSession(chatId, { step: "awaiting_music_upload" });
        } else {
          await addCloneSample(ctx, chatId, localPath);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    {
      errorStep: step,
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

    case "awaiting_music_upload": {
      if (text === "/done") {
        const tracks = await listMusicTracks();
        updateSession(chatId, { step: "idle" });
        await ctx.reply(
          tracks.length === 0
            ? "Ничего не добавилось. Библиотека пуста — ролики будут без музыки."
            : `Готово. В библиотеке ${tracks.length} трек(ов):\n` +
                tracks.map((t) => `• ${t}`).join("\n") +
                "\n\nДля каждого ролика берётся случайный. Ещё треки — /music",
        );
        return;
      }
      const musicLink = text
        .split(/\s+/)
        .find((part) => /^https?:\/\//.test(part));
      if (!musicLink) {
        await ctx.reply(
          "Жду файл или ссылку на Google Drive. Закончить — /done, отменить — /cancel.",
        );
        return;
      }
      await withGeneration(
        ctx,
        chatId,
        async () => {
          const workDir = await mkdtemp(path.join(tmpdir(), "amg-music-dl-"));
          try {
            await ctx.reply("⬇️ Скачиваю…");
            const file = path.join(workDir, "track.mp3");
            await downloadDriveFile(musicLink, file);
            await addUploadedTrack(ctx, file, "track");
            updateSession(chatId, { step: "awaiting_music_upload" });
          } finally {
            await rm(workDir, { recursive: true, force: true });
          }
        },
        {
          errorStep: "awaiting_music_upload",
          errorHint: "Пришлите ссылку ещё раз, файл или /cancel.",
        },
      );
      return;
    }

    case "awaiting_stems_source": {
      const link = text.split(/\s+/).find((part) => /^https?:\/\//.test(part));
      if (!link) {
        await ctx.reply(
          "Жду видео, аудио или ссылку на Google Drive. Отменить — /cancel.",
        );
        return;
      }
      await withGeneration(
        ctx,
        chatId,
        async () => {
          const workDir = await mkdtemp(path.join(tmpdir(), "amg-stems-dl-"));
          try {
            await ctx.reply("⬇️ Скачиваю…");
            const file = path.join(workDir, "source.mp4");
            await downloadDriveFile(link, file);
            await runStemsStep(
              ctx,
              chatId,
              file,
              session.stemsVariation ?? "two_stems_v1",
            );
          } finally {
            await rm(workDir, { recursive: true, force: true });
          }
        },
        {
          errorStep: "awaiting_stems_source",
          errorHint: "Пришлите ссылку ещё раз, файл или /cancel.",
        },
      );
      return;
    }

    case "awaiting_clone_links": {
      if (text === "/done") {
        if (getSession(chatId).cloneTargetVoiceId) {
          await runAddSamplesStep(ctx, chatId);
          return;
        }
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

    case "awaiting_checklist": {
      // Чек-лист — это текст на несколько экранов, и присылают его вставкой.
      // Минимальная длина нужна, чтобы случайное «ок» не стёрло правила.
      if (text.trim().length < 40) {
        await ctx.reply(
          "Похоже, это не чек-лист. Пришлите текст целиком одним сообщением " +
            "или отмените: /cancel",
        );
        return;
      }
      writeChecklist(text);
      updateSession(chatId, { step: "idle" });
      await ctx.reply(
        `Чек-лист обновлён (${text.trim().length} символов) и применится к ` +
          "следующему сценарию. Посмотреть: /rules",
      );
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
