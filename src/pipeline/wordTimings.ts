import type { Caption } from "@remotion/captions";

// Тайминги слов для субтитров «по слову». Берём их из двух источников:
//
// 1. ElevenLabs умеет возвращать выравнивание по символам вместе с аудио
//    (эндпоинт /with-timestamps) — это точные тайминги, ничего распознавать не
//    надо: модель сама знает, когда произносит каждый символ.
// 2. Если выравнивания нет (прокси Kie.ai его не отдаёт), раскладываем слова по
//    длине реплики пропорционально числу букв. Это приближение, но для
//    коротких фраз расхождение незаметно, а субтитры всё равно появляются.

export interface AlignmentPayload {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}

/**
 * Собирает слова из посимвольного выравнивания ElevenLabs.
 * Пробелы и знаки препинания приклеиваются к слову, а не образуют своё.
 */
export function charactersToWords(alignment: AlignmentPayload): Caption[] {
  const chars = alignment.characters ?? [];
  const starts = alignment.character_start_times_seconds ?? [];
  const ends = alignment.character_end_times_seconds ?? [];
  if (chars.length === 0 || starts.length !== chars.length) return [];

  const words: Caption[] = [];
  let current = "";
  let startSeconds = 0;
  let endSeconds = 0;

  const flush = () => {
    const text = current.trim();
    if (text) {
      words.push({
        text,
        startMs: Math.round(startSeconds * 1000),
        endMs: Math.round(endSeconds * 1000),
        timestampMs: Math.round(((startSeconds + endSeconds) / 2) * 1000),
        confidence: null,
      });
    }
    current = "";
  };

  chars.forEach((char, index) => {
    if (/\s/.test(char)) {
      flush();
      return;
    }
    if (!current) startSeconds = starts[index] ?? endSeconds;
    current += char;
    endSeconds = ends[index] ?? starts[index] ?? endSeconds;
  });
  flush();

  return words;
}

/**
 * Приблизительные тайминги: слова делят длительность реплики пропорционально
 * своей длине. Знаки препинания добавляют вес — на них речь притормаживает.
 */
export function estimateWordTimings(
  text: string,
  durationSeconds: number,
): Caption[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSeconds <= 0) return [];

  const weight = (word: string) =>
    word.length + (/[.,!?…:;—]$/.test(word) ? 2 : 0);
  const total = words.reduce((sum, word) => sum + weight(word), 0);

  let cursorMs = 0;
  return words.map((word) => {
    const shareMs = (weight(word) / total) * durationSeconds * 1000;
    const startMs = Math.round(cursorMs);
    cursorMs += shareMs;
    const endMs = Math.round(cursorMs);
    return {
      text: word,
      startMs,
      endMs,
      timestampMs: Math.round((startMs + endMs) / 2),
      confidence: null,
    };
  });
}

/**
 * Слова для сцены: точные, если провайдер их дал, иначе расчётные.
 */
export function wordsForScene(
  text: string,
  durationSeconds: number,
  fromProvider?: Caption[],
): Caption[] {
  if (fromProvider && fromProvider.length > 0) return fromProvider;
  return estimateWordTimings(text, durationSeconds);
}
