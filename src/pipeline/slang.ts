import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stem } from "./scriptRepeat";
import type { GeneratedScript } from "./generateScript";

/**
 * Речь Шамиля: кавказский говор в озвучке.
 *
 * Список лежит в файле, а не в коде, по той же причине, что и чек-лист
 * критика: словечки — вещь живая, их подбирают на слух, и каждая правка не
 * должна упираться в программиста. Правится из чата командой /slang.
 *
 * ГЛАВНОЕ ПРАВИЛО, из-за которого здесь вообще есть проверка: жаргон работает
 * пока он редкий. Три «лее» на минуту — это характер, десять — пародия на
 * кавказца, и ролик из фирменного превращается в неловкий. Поэтому в промпте
 * стоит потолок, а в коде — счётчик, который его сторожит.
 */

export const SLANG_FILE = path.resolve("data/slang.json");

/**
 * Список по умолчанию. Семь слов заказчика плюс «брат» — самое обычное
 * обращение в этой манере, без него речь звучит как набор вставок.
 */
export const DEFAULT_SLANG = [
  "лее",
  "моросишь",
  "чальянка",
  "родничок",
  "внатуре",
  "беспредел",
  "суета",
  "брат",
];

/** Сколько раз за ролик жаргон допустим. Выше — уже пародия. */
export const SLANG_LIMIT = 3;

export interface SlangState {
  words: string[];
  /** Выключатель: список остаётся, но в промпт не уходит. */
  on: boolean;
}

export function readSlang(): SlangState {
  try {
    if (existsSync(SLANG_FILE)) {
      const raw = JSON.parse(readFileSync(SLANG_FILE, "utf-8")) as SlangState;
      if (Array.isArray(raw.words)) {
        return { words: raw.words.filter(Boolean), on: raw.on !== false };
      }
    }
  } catch {
    // Испорченный файл — не повод ронять генерацию.
  }
  return { words: DEFAULT_SLANG, on: true };
}

export function writeSlang(state: SlangState): void {
  mkdirSync(path.dirname(SLANG_FILE), { recursive: true });
  writeFileSync(SLANG_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/**
 * Кусок промпта про манеру речи. Пустой список или выключенный говор — пустая
 * строка: тогда сценарий пишется как раньше.
 */
export function slangPrompt(state: SlangState): string {
  if (!state.on || state.words.length === 0) return "";
  return `
ГОВОР ШАМИЛЯ. Ведущий — свой человек с Кавказа, и это слышно по паре словечек,
а не по каждой фразе. Держи под рукой: ${state.words.join(", ")}.
- НЕ БОЛЬШЕ ${SLANG_LIMIT} ТАКИХ СЛОВ НА ВЕСЬ РОЛИК. Это потолок, а не норма:
  два — характер, десять — пародия на кавказца, и ролик становится неловким.
- Не больше одного слова в сцене.
- Жаргон — это РЕАКЦИЯ, а не объяснение. «Лее, они там совсем обнаглели» —
  хорошо. Объяснять механику этими словами нельзя: там зритель должен понять
  с первого раза.
- Слово должно стоять в живой фразе и склоняться естественно. Если оно не
  ложится в предложение — не вставляй вовсе, лучше без него.
- В призыве (последняя сцена) жаргон не нужен: там человек решает, идти к нам
  или нет, и говорить надо просто.`;
}

/** Сколько раз жаргон встречается в тексте. Считает и склонённые формы. */
export function countSlang(text: string, words: string[]): number {
  const marks = new Set(words.map((w) => stem(w.toLowerCase())));
  let count = 0;
  for (const raw of text.toLowerCase().split(/[^а-яёa-z]+/)) {
    if (!raw) continue;
    if (marks.has(stem(raw))) count++;
  }
  return count;
}

/**
 * Перебор жаргона. Считаем по всему ролику и отдельно смотрим на сцену: два
 * словечка в одной реплике слышны как передразнивание, даже если на ролик их
 * всего три.
 */
export function slangProblem(
  script: GeneratedScript,
  state: SlangState = readSlang(),
): string | undefined {
  if (state.words.length === 0) return undefined;

  let total = 0;
  const crowded: number[] = [];
  script.scenes.forEach((scene, index) => {
    const inScene = countSlang(scene.voiceoverText, state.words);
    total += inScene;
    if (inScene > 1) crowded.push(index + 1);
  });

  if (crowded.length > 0) {
    return (
      `жаргона слишком много в одной сцене (${crowded.join(", ")}) — ` +
      "в реплике хватает одного слова"
    );
  }
  if (total > SLANG_LIMIT) {
    return (
      `жаргона на ролик ${total} при потолке ${SLANG_LIMIT} — ` +
      "с таким количеством говор звучит пародией, а не характером"
    );
  }
  return undefined;
}

export interface SlangCommand {
  state: SlangState;
  message: string;
}

/**
 * Разбор аргумента /slang. Отдельной функцией, чтобы правила разбора
 * проверялись тестом, а не глазами в обработчике команды.
 */
export function parseSlangCommand(
  arg: string | undefined,
  current: SlangState,
): SlangCommand | { error: string } {
  const text = (arg ?? "").trim();
  if (!text) return { state: current, message: "" };

  const [verb, ...rest] = text.split(/\s+/);
  const tail = rest.join(" ").trim();
  const words = tail
    .split(/[,;\n]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

  switch (verb.toLowerCase()) {
    case "off":
    case "выкл":
      return {
        state: { ...current, on: false },
        message: "Говор выключен — сценарии пишутся обычной речью.",
      };
    case "on":
    case "вкл":
      return {
        state: { ...current, on: true },
        message: "Говор включён.",
      };
    case "reset":
    case "сброс":
      return {
        state: { words: DEFAULT_SLANG, on: true },
        message: "Вернул список по умолчанию.",
      };
    case "add":
    case "плюс": {
      if (words.length === 0) {
        return { error: "Что добавить? Пример: /slang add лее, эй брат" };
      }
      const added = words.filter((w) => !current.words.includes(w));
      return {
        state: { ...current, words: [...current.words, ...added] },
        message: added.length
          ? `Добавил: ${added.join(", ")}.`
          : "Такие слова уже есть.",
      };
    }
    case "del":
    case "минус": {
      if (words.length === 0) {
        return { error: "Что убрать? Пример: /slang del чальянка" };
      }
      const kept = current.words.filter((w) => !words.includes(w));
      const removed = current.words.length - kept.length;
      return {
        state: { ...current, words: kept },
        message: removed
          ? `Убрал ${removed}: ${words.join(", ")}.`
          : "Таких слов в списке не было.",
      };
    }
    default:
      return {
        error:
          "Не понял. /slang — показать список, /slang add слово, " +
          "/slang del слово, /slang off, /slang on, /slang reset.",
      };
  }
}
