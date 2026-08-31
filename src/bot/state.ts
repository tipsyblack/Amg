import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GeneratedScript } from "../pipeline/generateScript";

// Состояние бота хранится в JSON-файле, чтобы переживать перезапуски.
// Для личного использования этого достаточно; при росте нагрузки заменить
// на SQLite.

export type Step =
  | "idle"
  | "awaiting_brief"
  | "awaiting_reference"
  | "awaiting_topic"
  | "awaiting_profile_name"
  | "awaiting_profile_brief"
  | "awaiting_profile_reference"
  | "awaiting_clone_name"
  | "awaiting_clone_links"
  | "awaiting_script_feedback"
  | "awaiting_scene_number"
  | "awaiting_checklist"
  | "awaiting_stems_source"
  | "awaiting_music_upload"
  | "awaiting_guide_title"
  | "collecting_guide"
  | "busy";

export interface SceneImage {
  imageFileName: string;
  resultUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  // Вторая иллюстрация той же сцены: сменяет первую посреди реплики. Лежит
  // здесь же, чтобы при повторе сборки не рисоваться и не оплачиваться заново.
  swapImageFileName?: string;
  swapImageWidth?: number;
  swapImageHeight?: number;
  // Какая это по счёту попытка нарисовать сцену. По ней сдвигается тон и план
  // кадра при перерисовке: повторять задание, которое уже не понравилось,
  // смысла нет.
  attempt?: number;
}

export interface SceneOverlay {
  fileName: string;
  anchor: "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "center";
  widthPercent: number;
}

export interface SceneClip {
  clipFileName: string;
  clipDurationInFrames: number;
  // Откуда клип взялся и какой именно был взят из библиотеки. Второе нужно,
  // чтобы при повторе сборки не выдать тот же жест в соседнюю сцену.
  source: "library" | "generated";
  libraryId?: string;
}

export interface SceneAudio {
  audioFileName: string;
  durationInFrames: number;
  // Слова с таймингами для субтитров: кладём в состояние вместе с озвучкой,
  // чтобы при повторе сборки не терялись (переозвучка стоит денег).
  words?: { text: string; startMs: number; endMs: number }[];
}

/**
 * Профиль продукта: роль/контекст для сценариста и разобранный стиль
 * референса. Смысл в том, чтобы не пересылать референс и не переписывать
 * бриф для каждого ролика — разбор видео делается один раз.
 */
export interface Profile {
  id: string;
  name: string;
  brief: string;
  styleNotes?: string;
  referenceLink?: string;
  createdAt: string;
}

export interface Session {
  step: Step;
  brief?: string;
  styleNotes?: string;
  script?: GeneratedScript;
  images?: SceneImage[];
  // Гайд по боту: слайды, которые прислал человек. Ролик из них собирается
  // иначе — сценарий пишет он сам, а картинки берутся из его скриншотов.
  guideSlides?: {
    file: string;
    text: string;
    note?: string;
    // Куда показать нажатие: разбирается из пометки в реплике, см. guide.ts.
    tap?: {
      kind: "cursor" | "ring" | "frame" | "ripple" | "arrow";
      xPercent: number;
      yPercent: number;
    };
  }[];
  guideTitle?: string;
  // Покадровый план гайда: заготовка, из которой берутся реплики, если к
  // скриншоту не приложили свою. Живёт рядом со слайдами и умирает с /new.
  guidePlan?: { screen: string; line: string }[];
  // Этот ролик — гайд. От флага зависит не только сборка: маскот в кадрах
  // гайда не нужен вовсе, там на экране интерфейс.
  guide?: boolean;
  // Появляющиеся объекты: файл готов вместе с картинками, а момент появления
  // считается при сборке — он привязан к слову из озвучки.
  overlays?: (SceneOverlay | undefined)[];
  // Кэш готовых озвучек: при повторе сборки после сбоя уже озвученные
  // сцены не переозвучиваются (и не оплачиваются) заново.
  audio?: SceneAudio[];
  // То же самое для клипов — они самая дорогая часть сцены.
  clips?: (SceneClip | undefined)[];
  // Голос, модель озвучки и модель картинок — настройки, а не часть диалога:
  // переопределяют .env и живут между роликами (/new их не трёт).
  voice?: string;
  ttsModel?: string;
  ttsProvider?: "kie" | "elevenlabs";
  /** Скорость речи для этого чата: перекрывает TTS_SPEED из .env. */
  ttsSpeed?: number;
  imageModel?: string;
  // Модель оживления кадра (команда /vidmodel): ключ из VIDEO_MODELS.
  videoModel?: string;
  // Сколько сцен ролика оживлять клипом (команда /clips). 0 — ни одной.
  clipScenes?: number;
  // Модель, которая пишет сценарий (команда /model): ключ из SCRIPT_MODELS
  // либо слаг OpenRouter, введённый руками.
  scriptModel?: string;
  // Лимит длины ролика в секундах (команда /length). Тоже настройка: сценарист
  // получает из него бюджет слов, а сборка — предел для подгонки паузами.
  maxVideoSeconds?: number;
  // Профиль, из которого собирается текущий ролик.
  profileId?: string;
  // Имя будущего клонированного голоса и уже собранные сэмплы (пути к
  // файлам). Копятся между сообщениями, пока не придёт /done.
  cloneName?: string;
  cloneSamples?: string[];
  // Если задан — собранный материал добавляется к этому голосу, а не создаёт
  // новый клон (команда /clonemore).
  cloneTargetVoiceId?: string;
  // Режим разделения на стемы, выбранный командой /stems.
  stemsVariation?: "two_stems_v1" | "six_stems_v1";
  // Автопилот: шаги идут подряд без кнопок согласования. Настройка, а не часть
  // диалога — переживает /new, как модели и голос.
  autopilot?: boolean;
  // Профиль в процессе создания.
  draftProfile?: {
    name?: string;
    brief?: string;
    styleNotes?: string;
    referenceLink?: string;
  };
}

interface Store {
  sessions: Record<string, Session>;
  profiles: Record<string, Profile[]>;
  /**
   * Темы уже снятых роликов — по чату, новые в начале.
   *
   * Нужно, чтобы контент-завод не топтался на одном месте: два ролика подряд
   * вышли про «нейросети рисуют картинки» и «нейросети делают контент», а для
   * зрителя это один ролик, снятый дважды. Список уходит в подбор тем как
   * запрет, а рядом стоит быстрая проверка похожести.
   *
   * Живёт вне сессии: /new чистит диалог, а память о снятом обязана
   * пережить и его, и перезапуск бота.
   */
  shotTopics?: Record<string, string[]>;
  /**
   * Последний собранный ролик — то, что можно опубликовать.
   *
   * Живёт вне сессии намеренно: /new чистит диалог, а готовый ролик остаётся
   * готовым. Иначе опубликовать вчерашнее было бы нечем.
   */
  lastVideo?: Record<string, LastVideo>;
  /** Последний пост в соцсети: по нему смотрим состояние и повторяем. */
  lastPostId?: Record<string, string>;
}

export interface LastVideo {
  /** Путь к файлу НА СЕРВЕРЕ — в качестве для площадок, не сжатом под Telegram. */
  file: string;
  title: string;
  description: string;
  /** Когда собран, ISO. */
  at: string;
}

const STATE_FILE = path.resolve("data/bot-state.json");

function loadStore(): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { sessions: {}, profiles: {}, shotTopics: {}, lastVideo: {}, lastPostId: {} };
  }

  if (raw && typeof raw === "object" && "sessions" in raw) {
    const store = raw as Partial<Store>;
    return {
      sessions: store.sessions ?? {},
      profiles: store.profiles ?? {},
      shotTopics: store.shotTopics ?? {},
      lastVideo: store.lastVideo ?? {},
      lastPostId: store.lastPostId ?? {},
    };
  }
  // Старый формат: файл был просто картой сессий. Переносим как есть.
  return {
    sessions: (raw as Record<string, Session>) ?? {},
    profiles: {},
    shotTopics: {},
    lastVideo: {},
    lastPostId: {},
  };
}

const store = loadStore();

function persist(): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(store, null, 2));
}

export function getSession(chatId: number): Session {
  return store.sessions[String(chatId)] ?? { step: "idle" };
}

export function updateSession(chatId: number, patch: Partial<Session>): Session {
  const next = { ...getSession(chatId), ...patch };
  store.sessions[String(chatId)] = next;
  persist();
  return next;
}

export function resetSession(chatId: number): void {
  // Настройки озвучки, картинок и сценария — не часть диалога, переживают сброс.
  const {
    voice,
    ttsModel,
    ttsProvider,
    ttsSpeed,
    imageModel,
    videoModel,
    clipScenes,
    scriptModel,
    maxVideoSeconds,
    autopilot,
  } = getSession(chatId);
  store.sessions[String(chatId)] = {
    step: "idle",
    voice,
    ttsModel,
    ttsProvider,
    ttsSpeed,
    imageModel,
    videoModel,
    clipScenes,
    scriptModel,
    maxVideoSeconds,
    autopilot,
  };
  persist();
}

export function listProfiles(chatId: number): Profile[] {
  return store.profiles[String(chatId)] ?? [];
}

export function getProfile(chatId: number, id: string): Profile | undefined {
  return listProfiles(chatId).find((profile) => profile.id === id);
}

export function saveProfile(
  chatId: number,
  profile: Omit<Profile, "id" | "createdAt">,
): Profile {
  const profiles = listProfiles(chatId);
  // Короткий id: он уезжает в callback_data кнопок, где мало места.
  const used = new Set(profiles.map((p) => p.id));
  let n = 1;
  while (used.has(`p${n}`)) n++;

  const created: Profile = {
    ...profile,
    id: `p${n}`,
    createdAt: new Date().toISOString(),
  };
  store.profiles[String(chatId)] = [...profiles, created];
  persist();
  return created;
}

export function deleteProfile(chatId: number, id: string): boolean {
  const profiles = listProfiles(chatId);
  const rest = profiles.filter((profile) => profile.id !== id);
  if (rest.length === profiles.length) return false;
  store.profiles[String(chatId)] = rest;
  persist();
  return true;
}


// Сколько тем помним. Достаточно, чтобы не повториться в пределах пары
// месяцев ежедневного выпуска, и мало, чтобы список запретов не разрастался
// в промпте подбора тем.
const SHOT_TOPICS_KEPT = 60;

/** Темы уже снятых роликов, новые первыми. */
export function listShotTopics(chatId: number): string[] {
  return store.shotTopics?.[String(chatId)] ?? [];
}

/**
 * Запоминает тему как снятую. Повтор той же строки не плодит дублей — иначе
 * повторная сборка одного ролика забила бы всю память одной темой.
 */
export function rememberShotTopic(chatId: number, topic: string): void {
  const title = topic.trim();
  if (!title) return;
  store.shotTopics ??= {};
  const key = String(chatId);
  const kept = (store.shotTopics[key] ?? []).filter(
    (t) => t.toLowerCase() !== title.toLowerCase(),
  );
  store.shotTopics[key] = [title, ...kept].slice(0, SHOT_TOPICS_KEPT);
  persist();
}

/**
 * Вернуть одну тему в подбор.
 *
 * Тема запоминается сразу при выборе, а не после удачной сборки — иначе она
 * предлагалась бы снова назавтра. Обратная сторона нашлась в работе: ролик не
 * доснят, идея понравилась, а тема уже занята. Стирать ради этого всю память
 * (`/topicsreset`) — потерять защиту от повторов за два месяца.
 *
 * @param which номер в списке (0 — самая свежая) или часть названия
 * @returns что именно убрали, либо undefined, если не нашли
 */
export function forgetShotTopic(
  chatId: number,
  which: number | string = 0,
): string | undefined {
  const key = String(chatId);
  const topics = store.shotTopics?.[key] ?? [];
  const index =
    typeof which === "number"
      ? which
      : topics.findIndex((t) =>
          t.toLowerCase().includes(which.trim().toLowerCase()),
        );
  if (index < 0 || index >= topics.length) return undefined;

  const [removed] = topics.splice(index, 1);
  store.shotTopics ??= {};
  store.shotTopics[key] = topics;
  persist();
  return removed;
}

/** Забыть снятые темы — на случай смены ниши канала. */
export function forgetShotTopics(chatId: number): void {
  store.shotTopics ??= {};
  store.shotTopics[String(chatId)] = [];
  persist();
}


/** Запоминает собранный ролик как готовый к публикации. */
export function rememberVideo(chatId: number, video: LastVideo): void {
  store.lastVideo ??= {};
  store.lastVideo[String(chatId)] = video;
  persist();
}

export function getLastVideo(chatId: number): LastVideo | undefined {
  return store.lastVideo?.[String(chatId)];
}

export function rememberPostId(chatId: number, postId: string): void {
  store.lastPostId ??= {};
  store.lastPostId[String(chatId)] = postId;
  persist();
}

export function getLastPostId(chatId: number): string | undefined {
  return store.lastPostId?.[String(chatId)];
}
