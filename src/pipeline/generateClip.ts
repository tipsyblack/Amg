import path from "node:path";
import {
  buildLibraryClipPrompt,
  CLIP_LIBRARY_DIR,
  ensureLibraryDir,
  libraryFileName,
  PUBLIC_CLIPS_DIR,
  type ClipDefinition,
} from "./clipLibrary";
import { config } from "./config";
import { runKieTask } from "./kie";
import { clampClipSeconds, getVideoModel } from "./videoModels";

// Оживление кадра. В референсе не все сцены — статичные картинки: часть из них
// живёт, и именно эти секунды удерживают внимание. Делаем так же, но не
// генерацией сцены с нуля, а анимацией той картинки, которая для сцены уже
// нарисована: она идёт первым кадром клипа. Три следствия:
//   • стиль не «уплывает» — движение начинается ровно с той картинки, которую
//     мы согласовали в боте;
//   • сцену можно оживить выборочно, не трогая остальные;
//   • если генерация клипа не удалась, сцена просто остаётся картинкой —
//     ролик от этого не ломается (см. поведение при ошибке ниже).
//
// Маскота сюда специально не тянем: анимируется то, что уже нарисовано в
// сцене. Если персонажа в кадре нет — оживает предмет или место, и это
// нормально.

/**
 * Промпт движения. Камера почти неподвижна намеренно: карточка в кадре и так
 * приезжает анимацией, а если внутри неё ещё и поедет камера, стык перестаёт
 * читаться — то же самое мы уже выяснили про наезд на картинку (см. Scene.tsx).
 * Поэтому просим движение внутри сцены, а не движение камеры.
 */
export function buildClipPrompt(voiceoverText: string): string {
  return (
    "Оживи приложенный кадр, сохранив его в точности: та же композиция, те же " +
    "персонажи и предметы, тот же стиль плоской векторной иллюстрации с " +
    "толстым чёрным контуром и та же палитра. Ничего не дорисовывай и не " +
    "перерисовывай.\n\n" +
    `Что происходит в сцене: ${voiceoverText}\n\n` +
    "Движение — небольшое и естественное: жест, мимика, покачивание, дым, " +
    "частицы, лёгкое движение элементов сцены. Камера стоит неподвижно: без " +
    "наездов, отъездов, панорам и облётов. Смены плана нет, склейки нет — " +
    "это один непрерывный кадр.\n\n" +
    "КРИТИЧНО: никакого текста, надписей, букв и цифр в кадре."
  );
}

/**
 * Оживляет картинку сцены и сохраняет клип в public/clips.
 *
 * Ошибку не бросает, а возвращает undefined: клип — это украшение поверх уже
 * готовой сцены, и ронять из-за него ролик, в котором уже оплачены картинки и
 * озвучка, нельзя. Сцена в этом случае остаётся картинкой.
 */
export async function generateSceneClip(
  index: number,
  voiceoverText: string,
  // Публичная ссылка на картинку сцены — Kie.ai принимает вход только по URL.
  imageUrl: string,
  seconds: number = config.clipSeconds,
  modelKey?: string,
): Promise<{ clipFileName: string } | undefined> {
  const spec = getVideoModel(modelKey);
  // Длительность приводим к тому, что модель принимает: просьба о двух
  // секундах у Seedance 2 отвергается — короче четырёх он не умеет.
  const duration = clampClipSeconds(spec, seconds);
  const clipFileName = `scene-${index}.mp4`;
  const outFile = path.join(PUBLIC_CLIPS_DIR, clipFileName);

  try {
    await runKieTask({
      model: spec.model,
      input: spec.buildInput(buildClipPrompt(voiceoverText), imageUrl, duration),
      outFile,
      label: `клип для сцены ${index + 1}, модель ${spec.model}`,
    });
    return { clipFileName };
  } catch (error) {
    console.error(
      `Клип для сцены ${index + 1} не сгенерировался, сцена останется картинкой: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return undefined;
  }
}

/**
 * Генерирует один клип библиотеки маскота в assets/clips.
 *
 * В отличие от оживления сцены, здесь ошибка бросается: библиотека собирается
 * отдельной командой, а не посреди сборки ролика, и молча пропустить неудачу
 * значит оставить дыру в библиотеке, о которой узнаешь через месяц.
 *
 * Первым кадром идёт эталон внешности маскота — тот же файл, которым мы
 * держим его лицо одинаковым в картинках сцен.
 */
export async function generateLibraryClip(
  clip: ClipDefinition,
  seconds: number = config.clipSeconds,
  modelKey?: string,
): Promise<string> {
  const spec = getVideoModel(modelKey);
  const fileName = libraryFileName(clip.id);
  await ensureLibraryDir();

  await runKieTask({
    model: spec.model,
    input: spec.buildInput(
      buildLibraryClipPrompt(clip),
      config.characterReferenceUrl,
      clampClipSeconds(spec, seconds),
    ),
    outFile: path.join(CLIP_LIBRARY_DIR, fileName),
    label: `клип библиотеки «${clip.title}», модель ${spec.model}`,
  });

  return fileName;
}

/**
 * Каким сценам достаётся клип.
 *
 * Оживлять все сцены дорого: при ~$0.125 за секунду 720p клип на 2 секунды
 * стоит примерно четверть доллара, а сцен до пятнадцати. Поэтому оживляем
 * ограниченное число сцен, и в первую очередь те, где это важнее всего:
 * хук (первые полторы секунды решают, досмотрят ли ролик), затем финал
 * (призыв к действию), затем середина — равномерно, чтобы движение было
 * распределено по ролику, а не сгрудилось в начале.
 *
 * CLIP_SCENES=0 (по умолчанию) — клипов нет вовсе, поведение как раньше.
 */
export function clipSceneIndexes(total: number, count: number): number[] {
  if (count <= 0 || total <= 0) return [];
  if (count >= total) {
    return Array.from({ length: total }, (_, i) => i);
  }

  const chosen: number[] = [0];
  if (count >= 2 && total > 1) chosen.push(total - 1);

  // Остальные — по середине, поровну между уже выбранными краями.
  const remaining = count - chosen.length;
  for (let i = 1; i <= remaining; i++) {
    const candidate = Math.round((i * (total - 1)) / (remaining + 1));
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }

  return chosen.sort((a, b) => a - b).slice(0, count);
}
