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
}

const STATE_FILE = path.resolve("data/bot-state.json");

function loadStore(): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { sessions: {}, profiles: {} };
  }

  if (raw && typeof raw === "object" && "sessions" in raw) {
    const store = raw as Partial<Store>;
    return { sessions: store.sessions ?? {}, profiles: store.profiles ?? {} };
  }
  // Старый формат: файл был просто картой сессий. Переносим как есть.
  return { sessions: (raw as Record<string, Session>) ?? {}, profiles: {} };
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
