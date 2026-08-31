import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Предел ElevenLabs на ОДИН загружаемый файл — 11 МБ. Превышение не «грузится
 * дольше», а отвергается: 400 upload_file_size_exceeded, «maximum of 11MB».
 *
 * Наступить на это легко и незаметно: семь минут речи после очистки от музыки
 * возвращаются от ElevenLabs примерно на 320 кбит/с и весят 16 МБ, хотя тот же
 * материал на моно 192 кбит/с — 10 МБ. То есть лимит пробивался не объёмом
 * материала, а битрейтом, и терялась при этом вся собранная сессия.
 *
 * Считаем мегабайт десятичным: что имеет в виду ElevenLabs, из сообщения не
 * видно, а разница между 11 000 000 и 11 534 336 целиком в нашу пользу.
 */
export const MAX_UPLOAD_BYTES = 11_000_000;

/** Сколько файлов принимает набор сэмплов мгновенного клона. */
export const MAX_UPLOAD_FILES = 25;

/**
 * Битрейт, к которому приводим слишком большой файл. Моно 192 кбит/с — с
 * запасом для речи (ElevenLabs всё равно пережимает материал у себя), зато это
 * ровно 24 000 байт в секунду, поэтому размер куска считается из длительности
 * без сюрпризов.
 */
const SAMPLE_BITRATE = "192k";
const SAMPLE_BYTES_PER_SECOND = 24_000;

/** Запас на заголовки mp3 и на то, что битрейт не строго постоянный. */
const SIZE_MARGIN = 0.9;

export async function fileSizeBytes(file: string): Promise<number> {
  return (await stat(file)).size;
}

/**
 * Отпечаток содержимого файла. Нужен потому, что ElevenLabs отвергает загрузку
 * одного и того же файла дважды (400 duplicated_files), и один случайно
 * присланный второй раз ролик валит всю операцию.
 */
export async function fileHash(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export async function audioDurationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number(stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

/**
 * Склеивает несколько дорожек в одну. Для клонирования лучше один файл на
 * 1-2 минуты, чем горсть коротких: модели нужен объём материала.
 */
export async function concatAudio(
  files: string[],
  outFile: string,
): Promise<void> {
  if (files.length === 1) {
    await execFileAsync("ffmpeg", ["-y", "-i", files[0], "-c", "copy", outFile]);
    return;
  }

  // Пути пишем в список для concat-демуксера, экранируя кавычки.
  const listFile = path.join(path.dirname(outFile), "concat-list.txt");
  await writeFile(
    listFile,
    files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8",
  );

  // Перекодируем, а не -c copy: у файлов из разных источников могут не
  // совпадать параметры, и склейка копированием дала бы битый результат.
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-ac",
    "1",
    "-ar",
    "44100",
    "-b:a",
    SAMPLE_BITRATE,
    outFile,
  ]);
}

/** Приводит дорожку к моно 192 кбит/с — предсказуемый размер, речь не страдает. */
async function transcodeToSampleFormat(
  inFile: string,
  outFile: string,
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    inFile,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "44100",
    "-b:a",
    SAMPLE_BITRATE,
    outFile,
    "-loglevel",
    "error",
  ]);
}

/**
 * Режет дорожку на куски, каждый из которых заведомо влезает в лимит.
 *
 * Куски считаем от нужного их числа, а не «по столько-то секунд подряд»: иначе
 * у файла на 434 секунды при пределе 432 последним куском отваливается огрызок
 * на две секунды — как сэмпл голоса он бесполезен.
 */
export async function splitAudioForUpload(
  file: string,
  outDir: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<string[]> {
  const limit = Math.floor(maxBytes * SIZE_MARGIN);
  const seconds = await audioDurationSeconds(file);
  const pieces = Math.max(
    Math.ceil((seconds * SAMPLE_BYTES_PER_SECOND) / limit),
    1,
  );
  if (pieces === 1 && (await fileSizeBytes(file)) <= maxBytes) return [file];

  await mkdir(outDir, { recursive: true });
  const prefix = "part";
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    file,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "44100",
    "-b:a",
    SAMPLE_BITRATE,
    "-f",
    "segment",
    "-segment_time",
    String(Math.ceil(seconds / pieces)),
    "-reset_timestamps",
    "1",
    path.join(outDir, `${prefix}-%03d.mp3`),
    "-loglevel",
    "error",
  ]);

  const parts = (await readdir(outDir))
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".mp3"))
    .sort()
    .map((name) => path.join(outDir, name));
  if (parts.length === 0) {
    throw new Error(`Не удалось разрезать ${path.basename(file)} на части`);
  }
  return parts;
}

/**
 * Приводит набор файлов к тому, что примет ElevenLabs: всё, что не влезает в
 * лимит на файл, сначала пережимается, и только если и этого не хватило —
 * режется на части. Порядок именно такой: набор сэмплов клона — это один
 * отпечаток голоса, границы файлов внутри него роли не играют, а вот один файл
 * вместо трёх экономит место в наборе (их не больше 25).
 *
 * Файлы, которые в лимит уже влезают, не трогаются вовсе — никакого лишнего
 * перекодирования материала, из которого будет считаться голос.
 */
export async function prepareUploadFiles(
  files: string[],
  workDir: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<string[]> {
  const prepared: string[] = [];
  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    // Побайтово одинаковые файлы ElevenLabs не принимает: 400 duplicated_files.
    // Отсеиваем их здесь — для отпечатка голоса второй экземпляр той же записи
    // ничего не добавляет, а отказ стоил бы всей операции.
    const hash = await fileHash(file);
    if (seen.has(hash)) continue;
    seen.add(hash);

    if ((await fileSizeBytes(file)) <= maxBytes) {
      prepared.push(file);
      continue;
    }

    const dir = path.join(workDir, `fit-${index}`);
    await mkdir(dir, { recursive: true });
    const smaller = path.join(dir, "whole.mp3");
    await transcodeToSampleFormat(file, smaller);
    if ((await fileSizeBytes(smaller)) <= maxBytes) {
      prepared.push(smaller);
      continue;
    }
    prepared.push(...(await splitAudioForUpload(smaller, dir, maxBytes)));
  }

  if (prepared.length > MAX_UPLOAD_FILES) {
    throw new Error(
      `Материал не помещается в набор сэмплов: получилось ${prepared.length} ` +
        `файлов, а ElevenLabs принимает ${MAX_UPLOAD_FILES}. Пришлите меньше ` +
        "материала — мгновенному клону хватает одной-двух минут речи.",
    );
  }
  return prepared;
}
