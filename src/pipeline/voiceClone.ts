import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config";
import { unzip } from "./unzip";
import {
  MAX_UPLOAD_BYTES,
  concatAudio,
  fileSizeBytes,
  prepareUploadFiles,
} from "./voiceSamples";

// Клонирование голоса и очистка дорожки от музыки — прямые вызовы ElevenLabs.
// Через Kie.ai эти операции недоступны, нужен свой ключ (Creator и выше).
const ISOLATION_URL = "https://api.elevenlabs.io/v1/audio-isolation";
const STEMS_URL = "https://api.elevenlabs.io/v1/music/stem-separation";
const ADD_VOICE_URL = "https://api.elevenlabs.io/v1/voices/add";
const VOICES_URL = "https://api.elevenlabs.io/v1/voices";

function requireKey(): string {
  if (!config.elevenLabsApiKey) {
    throw new Error(
      "Нужен ELEVENLABS_API_KEY в .env на сервере: клонирование голоса и " +
        "очистка от музыки идут напрямую через ElevenLabs.",
    );
  }
  return config.elevenLabsApiKey;
}

async function fileToBlob(file: string): Promise<Blob> {
  const buffer = await readFile(file);
  return new Blob([new Uint8Array(buffer)]);
}

/**
 * Готовит файлы под лимит ElevenLabs на один загружаемый файл и убирает за
 * собой куски, если резать пришлось.
 */
async function withUploadFiles<T>(
  files: string[],
  run: (prepared: string[]) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(path.join(tmpdir(), "amg-samples-"));
  try {
    return await run(await prepareUploadFiles(files, workDir));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function isolateOne(inFile: string, outFile: string): Promise<void> {
  const form = new FormData();
  form.append("audio", await fileToBlob(inFile), path.basename(inFile));

  const response = await fetch(ISOLATION_URL, {
    method: "POST",
    headers: { "xi-api-key": requireKey() },
    body: form,
  });

  if (!response.ok) {
    throw new Error(
      `ElevenLabs (очистка от музыки) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}

/**
 * Убирает музыку и шум, оставляя голос (Voice Isolator). Полезно послушать
 * результат до клонирования: если голос звучит «подводно», исходник не годится.
 *
 * Дорожку длиннее лимита на загрузку чистим по частям и склеиваем обратно:
 * материал на клон собирается из нескольких роликов и легко перерастает 11 МБ,
 * а отказ здесь обнуляет всю сессию сбора.
 */
export async function isolateVoice(
  inFile: string,
  outFile: string,
): Promise<void> {
  if ((await fileSizeBytes(inFile)) <= MAX_UPLOAD_BYTES) {
    await isolateOne(inFile, outFile);
    return;
  }

  await withUploadFiles([inFile], async (parts) => {
    if (parts.length === 1) {
      await isolateOne(parts[0], outFile);
      return;
    }
    const workDir = path.dirname(parts[0]);
    const cleaned: string[] = [];
    for (const [index, part] of parts.entries()) {
      const out = path.join(workDir, `clean-${index}.mp3`);
      await isolateOne(part, out);
      cleaned.push(out);
    }
    await concatAudio(cleaned, outFile);
  });
}

/**
 * Создаёт мгновенный клон голоса из набора сэмплов.
 * removeBackgroundNoise просит ElevenLabs самому прогнать сэмплы через
 * шумоподавление — исходники из роликов идут с музыкой.
 */
export async function createInstantVoiceClone({
  name,
  files,
  removeBackgroundNoise = true,
}: {
  name: string;
  files: string[];
  removeBackgroundNoise?: boolean;
}): Promise<{ voiceId: string }> {
  const response = await withUploadFiles(files, async (prepared) => {
    const form = new FormData();
    form.append("name", name);
    form.append("remove_background_noise", String(removeBackgroundNoise));
    for (const file of prepared) {
      form.append("files", await fileToBlob(file), path.basename(file));
    }
    return fetch(ADD_VOICE_URL, {
      method: "POST",
      headers: { "xi-api-key": requireKey() },
      body: form,
    });
  });

  if (!response.ok) {
    const body = await response.text();
    if (body.includes("upload_file_size_exceeded")) {
      throw new Error(
        "ElevenLabs отверг сэмплы по размеру, хотя каждый файл уложен в 11 МБ " +
          "— похоже, упёрлись в предел на весь набор. Пришлите меньше " +
          "материала: мгновенному клону хватает одной-двух минут речи.",
      );
    }
    if (body.includes("duplicated_files")) {
      throw new Error(
        "ElevenLabs увидел среди сэмплов два одинаковых файла. Побайтовые " +
          "повторы отсеиваются автоматически, значит совпадение неточное — " +
          "один и тот же фрагмент речи пришёл в разных файлах. Уберите " +
          "дубликат из набора и повторите.",
      );
    }
    if (body.includes("can_not_use_instant_voice_cloning") || response.status === 403) {
      throw new Error(
        "Тариф ElevenLabs не разрешает клонирование голоса. Нужен Starter " +
          "или выше (у Creator есть).",
      );
    }
    if (body.includes("voice_limit_reached")) {
      throw new Error(
        "Достигнут лимит голосов на аккаунте ElevenLabs — удалите ненужный " +
          "голос в разделе Voices и повторите.",
      );
    }
    throw new Error(
      `ElevenLabs (клонирование) вернул ошибку ${response.status}: ${body}`,
    );
  }

  const data = (await response.json()) as { voice_id?: string };
  if (!data.voice_id) {
    throw new Error("ElevenLabs не вернул voice_id созданного голоса");
  }
  return { voiceId: data.voice_id };
}

/**
 * Разделение дорожки на стемы.
 *
 * `two_stems_v1` — голос и всё остальное («минус»); именно он отвечает на
 * вопрос «есть ли под речью музыка». `six_stems_v1` дробит дальше: вокал,
 * барабаны, бас и прочее — полезно, когда музыка нашлась и нужно понять, из
 * чего она собрана.
 *
 * Контракт сверен с официальным SDK (@elevenlabs/elevenlabs-js 2.59.0,
 * resources/music/client/Client.js): POST v1/music/stem-separation, файл полем
 * `file`, вариация полем `stem_variation_id`, формат — query-параметром
 * `output_format`, ответ — zip. Живым ключом отсюда проверить нельзя:
 * api.elevenlabs.io из песочницы недоступен.
 */
export type StemVariation = "two_stems_v1" | "six_stems_v1";

export interface Stem {
  /** Имя файла внутри архива — им ElevenLabs и называет стем. */
  name: string;
  file: string;
}

export async function separateStems({
  inFile,
  outDir,
  variation = "two_stems_v1",
  outputFormat = "mp3_44100_192",
}: {
  inFile: string;
  outDir: string;
  variation?: StemVariation;
  outputFormat?: string;
}): Promise<Stem[]> {
  const form = new FormData();
  form.append("file", await fileToBlob(inFile), path.basename(inFile));
  form.append("stem_variation_id", variation);

  const response = await fetch(
    `${STEMS_URL}?output_format=${encodeURIComponent(outputFormat)}`,
    {
      method: "POST",
      headers: { "xi-api-key": requireKey() },
      body: form,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    if (body.includes("upload_file_size_exceeded")) {
      throw new Error(
        "Файл больше 11 МБ — ElevenLabs его не примет. Пришлите фрагмент " +
          "покороче.",
      );
    }
    if (response.status === 403 || body.includes("missing_permissions")) {
      throw new Error(
        "Тариф или ключ ElevenLabs не разрешает разделение на стемы " +
          "(v1/music/stem-separation). Проверьте, что у ключа есть доступ к " +
          "Music.",
      );
    }
    throw new Error(
      `ElevenLabs (разделение на стемы) вернул ошибку ${response.status}: ${body}`,
    );
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const entries = unzip(archive);
  if (entries.length === 0) {
    throw new Error("ElevenLabs вернул пустой архив стемов");
  }

  await mkdir(outDir, { recursive: true });
  const stems: Stem[] = [];
  for (const entry of entries) {
    // Имя приходит от сервиса: берём только базовое, чтобы «../» из архива не
    // мог увести запись за пределы папки.
    const file = path.join(outDir, path.basename(entry.name));
    await writeFile(file, entry.data);
    stems.push({ name: path.basename(entry.name), file });
  }
  return stems;
}

export interface VoiceSample {
  sampleId: string;
  fileName: string;
  durationSeconds?: number;
}

/**
 * Состав уже созданного клона: из каких сэмплов он собран. По нему видно, что
 * добавление материала действительно прошло — количество и суммарная
 * длительность растут.
 */
export async function getVoiceSamples(
  voiceId: string,
): Promise<{ name: string; samples: VoiceSample[] }> {
  const response = await fetch(`${VOICES_URL}/${voiceId}`, {
    headers: { "xi-api-key": requireKey() },
  });
  if (!response.ok) {
    throw new Error(
      `ElevenLabs (состав голоса) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }
  const data = (await response.json()) as {
    name?: string;
    samples?: {
      sample_id?: string;
      file_name?: string;
      duration_secs?: number;
    }[];
  };
  return {
    name: data.name ?? "без имени",
    samples: (data.samples ?? [])
      .filter((sample) => sample.sample_id)
      .map((sample) => ({
        sampleId: sample.sample_id as string,
        fileName: sample.file_name ?? "sample",
        durationSeconds: sample.duration_secs,
      })),
  };
}

/**
 * Скачивает сэмпл, уже загруженный в голос. Нужен, чтобы при добавлении нового
 * материала отправить старые сэмплы обратно вместе с новым: у ElevenLabs
 * непонятно, дополняет ли edit набор или заменяет его, а терять исходники
 * нельзя. Скачали — значит гарантированно сохранили.
 */
export async function downloadVoiceSample(
  voiceId: string,
  sampleId: string,
  outFile: string,
): Promise<void> {
  const response = await fetch(
    `${VOICES_URL}/${voiceId}/samples/${sampleId}/audio`,
    { headers: { "xi-api-key": requireKey() } },
  );
  if (!response.ok) {
    throw new Error(
      `ElevenLabs (сэмпл ${sampleId}) вернул ошибку ${response.status}`,
    );
  }
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}

/**
 * Дополняет существующий клон новыми сэмплами.
 *
 * Важно про суть операции: мгновенный клон (Instant Voice Cloning) не
 * «дообучается» — ElevenLabs заново считает отпечаток голоса по всему набору
 * сэмплов. Поэтому добавление материала = обновление набора, и в запрос
 * отправляются и старые файлы, и новые.
 */
export async function editInstantVoiceClone({
  voiceId,
  name,
  files,
  removeBackgroundNoise = true,
}: {
  voiceId: string;
  name: string;
  files: string[];
  removeBackgroundNoise?: boolean;
}): Promise<void> {
  const response = await withUploadFiles(files, async (prepared) => {
    const form = new FormData();
    form.append("name", name);
    form.append("remove_background_noise", String(removeBackgroundNoise));
    for (const file of prepared) {
      form.append("files", await fileToBlob(file), path.basename(file));
    }
    return fetch(`${VOICES_URL}/${voiceId}/edit`, {
      method: "POST",
      headers: { "xi-api-key": requireKey() },
      body: form,
    });
  });

  if (!response.ok) {
    const body = await response.text();
    if (body.includes("upload_file_size_exceeded")) {
      throw new Error(
        "ElevenLabs отверг сэмплы по размеру, хотя каждый файл уложен в 11 МБ " +
          "— похоже, упёрлись в предел на весь набор голоса. Материала в нём " +
          "уже много: создайте новый голос из свежих записей (/clone) вместо " +
          "добавления к этому.",
      );
    }
    if (body.includes("duplicated_files")) {
      throw new Error(
        "Этот материал в голосе уже есть: ElevenLabs не принимает повторную " +
          "загрузку того же файла. Пришлите фрагменты, которых в голосе ещё " +
          "не было — состав показывает /voices.",
      );
    }
    if (body.includes("can_not_use_instant_voice_cloning") || response.status === 403) {
      throw new Error(
        "Тариф ElevenLabs не разрешает изменять клонированный голос. Нужен " +
          "Starter или выше (у Creator есть).",
      );
    }
    if (response.status === 404) {
      throw new Error(
        `Голос ${voiceId} не найден в аккаунте — возможно, он удалён. ` +
          "Список: /voices",
      );
    }
    if (body.includes("voice_not_editable") || body.includes("professional")) {
      throw new Error(
        "Этот голос нельзя изменить: похоже, он не мгновенный клон, а " +
          "профессиональный (PVC) или библиотечный. Материал можно добавить " +
          "только к мгновенным клонам — создайте новый: /clone",
      );
    }
    throw new Error(
      `ElevenLabs (добавление сэмплов) вернул ошибку ${response.status}: ${body}`,
    );
  }
}
