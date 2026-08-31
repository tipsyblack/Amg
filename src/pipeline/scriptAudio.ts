import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Caption } from "@remotion/captions";
import { config } from "./config";
import { trimTrailingSilence } from "./assets";
import { getAudioDurationInSeconds } from "./audioDuration";
import { synthesizeSpeech, type TtsProvider } from "./generateVoiceover";

const execFileAsync = promisify(execFile);

/**
 * Озвучка всего сценария ОДНИМ чтением, с последующей нарезкой на сцены.
 *
 * Зачем: раньше каждая сцена озвучивалась отдельным запросом, и синтезатор читал
 * её как самостоятельное предложение — с падающей интонацией в конце и без связи
 * со следующей. Отсюда рваная речь: даже когда паузы убраны, на каждой границе
 * слышен шов. Одно чтение даёт сквозную интонацию через весь ролик.
 *
 * Резать можно точно, потому что ElevenLabs отдаёт тайминги по символам ВХОДНОГО
 * текста: слова из выравнивания — это ровно слова того, что мы послали, а не то,
 * как синтезатор развернул числа при чтении. Поэтому «1287» в тексте остаётся
 * одним словом с одним интервалом, сколько бы слов из него ни произнеслось.
 */

/** Слова текста в том же разбиении, что и у выравнивания: по пробелам. */
function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export interface SlicePlan {
  /** Границы куска в исходной дорожке, мс. */
  startMs: number;
  endMs: number;
  /** Слова сцены, пересчитанные от начала её куска. */
  words: Caption[];
}

/**
 * Куда резать сплошную дорожку. Отдельно от нарезки, потому что вся тонкость
 * здесь, а проверить арифметику можно без синтезатора.
 *
 * Возвращает undefined, если слова не сходятся с текстом: значит выравнивание
 * пришло не про тот текст, и резать по нему нельзя — лучше честно вернуться к
 * прежнему способу, чем разложить сцены со сдвигом.
 */
export function planScriptAudioSlices(
  texts: string[],
  words: Caption[],
  totalMs: number,
): SlicePlan[] | undefined {
  const counts = texts.map((text) => tokenize(text).length);
  const expected = counts.reduce((sum, n) => sum + n, 0);
  if (expected === 0 || words.length !== expected) return undefined;

  const plans: SlicePlan[] = [];
  let offset = 0;
  for (let i = 0; i < counts.length; i++) {
    const mine = words.slice(offset, offset + counts[i]);
    offset += counts[i];
    if (mine.length === 0) return undefined;

    // Начало куска: для первой сцены — начало дорожки, дальше — середина между
    // концом предыдущего слова и началом своего. На сплошной речи эти два
    // момента почти совпадают, и разрез приходится ровно в стык слов; если же
    // диктор там всё-таки вдохнул, пауза делится между сценами поровну, и ни
    // одна не начинается с обрубленного звука.
    const first = mine[0];
    const startMs =
      i === 0
        ? 0
        : Math.round((words[offset - counts[i] - 1].endMs + first.startMs) / 2);

    // Конец: начало следующей сцены (её посчитаем на следующем витке) либо
    // конец дорожки для последней. Промежуточные считаем ниже, одним проходом.
    plans.push({ startMs, endMs: 0, words: [] });
  }

  for (let i = 0; i < plans.length; i++) {
    plans[i].endMs = i + 1 < plans.length ? plans[i + 1].startMs : totalMs;
  }

  offset = 0;
  for (let i = 0; i < counts.length; i++) {
    const mine = words.slice(offset, offset + counts[i]);
    offset += counts[i];
    plans[i].words = mine.map((word) => ({
      ...word,
      startMs: word.startMs - plans[i].startMs,
      endMs: word.endMs - plans[i].startMs,
      timestampMs:
        word.timestampMs === null
          ? null
          : word.timestampMs - plans[i].startMs,
    }));
  }

  return plans;
}

export interface SceneAudio {
  audioFileName: string;
  durationInFrames: number;
  words?: Caption[];
}

/**
 * Озвучивает весь сценарий одним запросом и режет на сцены.
 *
 * undefined означает «так не вышло» — нет таймингов (через прокси Kie.ai их не
 * бывает) или они не сошлись с текстом. Вызывающий в этом случае озвучивает
 * посценно, как раньше: непрерывная интонация лучше, но ролик без озвучки хуже
 * всего.
 */
export async function generateScriptAudio(
  texts: string[],
  outDir: string,
  voiceOverride?: string,
  modelOverride?: string,
  providerOverride?: TtsProvider,
): Promise<SceneAudio[] | undefined> {
  const joined = texts.map((text) => text.trim()).filter(Boolean).join(" ");
  if (!joined) return undefined;

  const wholeFile = path.join(outDir, "script.mp3");
  const { words } = await synthesizeSpeech(
    joined,
    wholeFile,
    voiceOverride,
    modelOverride,
    providerOverride,
  );
  if (!words || words.length === 0) {
    await rm(wholeFile, { force: true });
    return undefined;
  }

  // Хвост тишины от синтезатора достался бы последней сцене целиком: у неё
  // разрез приходится на конец дорожки, а не на стык слов. Срезаем с КОНЦА —
  // начало трогать нельзя, к нему привязаны тайминги всех слов сразу.
  await trimTrailingSilence(wholeFile);

  const measuredMs = Math.round((await getAudioDurationInSeconds(wholeFile)) * 1000);
  // Если срез тишины или округление длительности оставили дорожку короче
  // последнего слова, последняя сцена обрубила бы его на полуслове.
  const totalMs = Math.max(measuredMs, words[words.length - 1].endMs);
  const plans = planScriptAudioSlices(texts, words, totalMs);
  if (!plans) {
    await rm(wholeFile, { force: true });
    return undefined;
  }

  const scenes = await cutScenes(wholeFile, plans, outDir);
  await rm(wholeFile, { force: true });
  return scenes;
}

/**
 * Режет сплошную дорожку на куски по плану. Отдельной функцией, чтобы нарезку
 * можно было проверить на настоящем файле, не ходя в синтезатор.
 */
export async function cutScenes(
  wholeFile: string,
  plans: SlicePlan[],
  outDir: string,
): Promise<SceneAudio[]> {
  const scenes: SceneAudio[] = [];
  for (const [index, plan] of plans.entries()) {
    const audioFileName = `scene-${index}.mp3`;
    const outFile = path.join(outDir, audioFileName);
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", wholeFile,
      "-ss", (plan.startMs / 1000).toFixed(3),
      "-to", (plan.endMs / 1000).toFixed(3),
      // Перекодируем, а не копируем: у mp3 кадр 26 мс, и копированием разрез
      // уехал бы до кадра — на стыке сцен это слышно.
      "-c:a", "libmp3lame", "-b:a", "192k",
      outFile,
    ], { timeout: 2 * 60 * 1000 });

    const seconds = await getAudioDurationInSeconds(outFile);
    scenes.push({
      audioFileName,
      durationInFrames: Math.max(Math.round(seconds * config.fps), 1),
      words: config.wordSubtitles ? plan.words : undefined,
    });
  }
  return scenes;
}
