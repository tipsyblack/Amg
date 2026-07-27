import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// Клонирование голоса и очистка дорожки от музыки — прямые вызовы ElevenLabs.
// Через Kie.ai эти операции недоступны, нужен свой ключ (Creator и выше).
const ISOLATION_URL = "https://api.elevenlabs.io/v1/audio-isolation";
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
 * Убирает музыку и шум, оставляя голос (Voice Isolator). Полезно послушать
 * результат до клонирования: если голос звучит «подводно», исходник не годится.
 */
export async function isolateVoice(
  inFile: string,
  outFile: string,
): Promise<void> {
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
  const form = new FormData();
  form.append("name", name);
  form.append("remove_background_noise", String(removeBackgroundNoise));
  for (const file of files) {
    form.append("files", await fileToBlob(file), path.basename(file));
  }

  const response = await fetch(ADD_VOICE_URL, {
    method: "POST",
    headers: { "xi-api-key": requireKey() },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
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
  const form = new FormData();
  form.append("name", name);
  form.append("remove_background_noise", String(removeBackgroundNoise));
  for (const file of files) {
    form.append("files", await fileToBlob(file), path.basename(file));
  }

  const response = await fetch(`${VOICES_URL}/${voiceId}/edit`, {
    method: "POST",
    headers: { "xi-api-key": requireKey() },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
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
