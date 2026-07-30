import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Громкость финального микса, снятая с присланного референса. Все 11
 * присланных агентских роликов лежат в диапазоне −9.8…−12.2 LUFS при разбросе
 * громкости (LRA) около одной единицы — то есть это лимитированная,
 * «радийная» речь. Наш ролик измерялся на −14.6 LUFS: на телефоне в шуме это
 * слышно как «тише и вяло», и именно эта разница читается как «у них фон
 * другой», хотя музыки в референсе нет вовсе (проверено: в паузах низы падают
 * на 20-30 дБ, устойчивых тонов нет).
 *
 * Берём −12: нижний край диапазона референса. Громче смысла нет — площадки всё
 * равно приводят к своей норме (−14 у большинства), а перелимитированный звук
 * после их нормализации звучит плоско.
 */
export const TARGET_LUFS = -12;

/**
 * Потолок по истинному пику. −1.5 дБ, а не 0: дальше ролик перекодируется в AAC
 * (и ещё раз на стороне площадки), а лоссёвое сжатие поднимает пики. Без запаса
 * они клиппуют уже не у нас.
 */
export const TARGET_PEAK_DB = -1.5;

/** Ближе этого к цели не гонимся: слух такой разницы не замечает. */
const TOLERANCE_LU = 0.3;

export interface Loudness {
  lufs: number;
  lra: number;
  truePeakDb: number;
}

/**
 * Громкость по EBU R128 — тем же способом, которым мерялся референс.
 */
export async function measureLoudness(file: string): Promise<Loudness> {
  // ebur128 пишет сводку в stderr, а на stdout идёт (пустой) выходной поток.
  const { stderr } = await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
    { maxBuffer: 16 * 1024 * 1024 },
  );

  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const pick = (label: string): number => {
    const match = new RegExp(`${label}:\\s*(-?[\\d.]+)`).exec(summary);
    if (!match) {
      throw new Error(`ffmpeg не отдал ${label} для ${file}`);
    }
    return Number(match[1]);
  };

  return { lufs: pick("I"), lra: pick("LRA"), truePeakDb: pick("Peak") };
}

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Приводит громкость готового ролика к референсной.
 *
 * Почему не loudnorm: наш микс уже упирается пиками в ноль, а поднять его надо
 * на пару децибел. Линейный режим loudnorm в такой ситуации молча
 * переключается на динамический и начинает править разброс громкости — то есть
 * делает не то, что просили, и не то, что можно проверить. Здесь всё явно:
 * усиление плюс лимитер, и результат замеряется тем же прибором, что и
 * референс.
 *
 * Видео копируется потоком (-c:v copy): картинку эта операция не касается, и
 * перекодировать её было бы чистой потерей качества.
 */
export async function masterLoudness(
  inFile: string,
  outFile: string,
  targetLufs = TARGET_LUFS,
): Promise<{ before: Loudness; after: Loudness; gainDb: number }> {
  const before = await measureLoudness(inFile);

  // Лимитер срезает пики и тем самым немного убавляет громкость, поэтому
  // одного прохода по расчёту не хватает: считаем усиление, применяем, мерим и
  // добираем остаток. Второй проход обычно попадает в десятые доли.
  let gainDb = targetLufs - before.lufs;
  let after = before;
  for (let attempt = 0; attempt < 2; attempt++) {
    await execFileAsync(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", inFile,
        "-c:v", "copy",
        // level=disabled обязателен. По умолчанию alimiter «автоматически
        // выравнивает уровень», то есть домножает результат на 1/limit и
        // возвращает пик к нулю — ровно отменяя заданный потолок. Проверено
        // замером: без этого ключа выход шёл на 0.1 dBTP вместо −1.5.
        "-af",
        `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${dbToLinear(TARGET_PEAK_DB).toFixed(4)}:level=disabled`,
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        outFile,
      ],
      { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
    after = await measureLoudness(outFile);
    const missing = targetLufs - after.lufs;
    if (Math.abs(missing) <= TOLERANCE_LU) break;
    gainDb += missing;
  }

  return { before, after, gainDb };
}
