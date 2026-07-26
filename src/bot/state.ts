import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GeneratedScript } from "../pipeline/generateScript";

// Состояние диалога хранится в JSON-файле, чтобы переживать перезапуски
// бота. Для личного использования этого достаточно; при росте нагрузки
// заменить на SQLite.

export type Step =
  | "idle"
  | "awaiting_brief"
  | "awaiting_reference"
  | "awaiting_script_feedback"
  | "awaiting_scene_number"
  | "busy";

export interface SceneImage {
  imageFileName: string;
  resultUrl: string;
}

export interface SceneAudio {
  audioFileName: string;
  durationInFrames: number;
}

export interface Session {
  step: Step;
  brief?: string;
  styleNotes?: string;
  script?: GeneratedScript;
  images?: SceneImage[];
  // Кэш готовых озвучек: при повторе сборки после сбоя уже озвученные
  // сцены не переозвучиваются (и не оплачиваются) заново.
  audio?: SceneAudio[];
  // Голос, выбранный командой /voice — переопределяет KIE_TTS_VOICE из .env
  // и живёт между роликами (в отличие от остальных полей, /new его не трёт).
  voice?: string;
}

const STATE_FILE = path.resolve("data/bot-state.json");

let sessions: Record<string, Session> = {};

try {
  sessions = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
} catch {
  sessions = {};
}

function persist(): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(sessions, null, 2));
}

export function getSession(chatId: number): Session {
  return sessions[String(chatId)] ?? { step: "idle" };
}

export function updateSession(chatId: number, patch: Partial<Session>): Session {
  const next = { ...getSession(chatId), ...patch };
  sessions[String(chatId)] = next;
  persist();
  return next;
}

export function resetSession(chatId: number): void {
  // Выбранный голос — это настройка, а не часть диалога: переживает сброс.
  const { voice } = getSession(chatId);
  sessions[String(chatId)] = { step: "idle", voice };
  persist();
}
