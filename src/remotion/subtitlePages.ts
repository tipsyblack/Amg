import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";

// Разбивка слов на страницы субтитров.
//
// createTikTokStyleCaptions из @remotion/captions группирует слова по ПАУЗАМ
// между ними: параметр combineTokensWithinMilliseconds — это «склеивай слова,
// между которыми меньше N мс». У нас тайминги идут слитно (и расчётные, и от
// ElevenLabs), поэтому библиотека честно возвращает одну страницу на всю
// реплику. Читать такое невозможно, поэтому длинные страницы дополнительно
// режутся по числу символов — под ширину вертикального кадра.

// Через сколько миллисекунд тишины начинается новая страница.
const PAGE_GAP_MS = 400;
// Сколько символов помещается в две строки субтитров без выхода за поля.
const MAX_PAGE_CHARS = 26;

export interface SubtitleToken {
  text: string;
  fromMs: number;
  toMs: number;
}

export interface SubtitlePage {
  startMs: number;
  tokens: SubtitleToken[];
}

export function buildSubtitlePages(
  words: { text: string; startMs: number; endMs: number }[],
  maxChars = MAX_PAGE_CHARS,
): SubtitlePage[] {
  if (words.length === 0) return [];

  const captions: Caption[] = words.map((word) => ({
    text: word.text,
    startMs: word.startMs,
    endMs: word.endMs,
    timestampMs: (word.startMs + word.endMs) / 2,
    confidence: null,
  }));

  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: PAGE_GAP_MS,
  });

  const result: SubtitlePage[] = [];
  for (const page of pages) {
    let current: SubtitleToken[] = [];
    let length = 0;
    for (const token of page.tokens) {
      const tokenLength = token.text.trim().length + 1;
      if (length + tokenLength > maxChars && current.length > 0) {
        result.push({ startMs: current[0].fromMs, tokens: current });
        current = [];
        length = 0;
      }
      current.push({
        text: token.text.trim(),
        fromMs: token.fromMs,
        toMs: token.toMs,
      });
      length += tokenLength;
    }
    if (current.length > 0) {
      result.push({ startMs: current[0].fromMs, tokens: current });
    }
  }
  return result;
}

/**
 * Страница, которая показывается в этот момент: последняя из начавшихся.
 */
export function pageAt(
  pages: SubtitlePage[],
  timeMs: number,
): SubtitlePage | undefined {
  // Перебор с конца, а не findLastIndex: цель сборки ниже es2023.
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i].startMs <= timeMs) return pages[i];
  }
  return undefined;
}
