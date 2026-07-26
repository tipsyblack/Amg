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

export interface Session {
  step: Step;
  brief?: string;
  styleNotes?: string;
  script?: GeneratedScript;
  images?: SceneImage[];
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
  sessions[String(chatId)] = { step: "idle" };
  persist();
}
