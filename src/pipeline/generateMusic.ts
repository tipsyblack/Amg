import { writeFile } from "node:fs/promises";
import { config } from "./config";

// Музыка через Suno на Kie.ai. Внимание: у неё отдельные адреса, не общий
// /jobs/createTask, которым идут картинки и озвучка.
const CREATE_URL = "https://api.kie.ai/api/v1/generate";
const RECORD_URL = "https://api.kie.ai/api/v1/generate/record-info";

// Готовые описания под наши ролики: короткие, бодрые, без вокала — фон не
// должен перебивать озвучку. Пользователь может задать своё описание.
export const MUSIC_PRESETS: { key: string; title: string; prompt: string }[] = [
  {
    key: "upbeat",
    title: "Бодрый бит",
    prompt:
      "Upbeat modern corporate background music, light electronic beat, " +
      "optimistic and energetic, clean and simple, no vocals",
  },
  {
    key: "lofi",
    title: "Лоу-фай",
    prompt:
      "Chill lo-fi hip hop background music, soft dusty drums, mellow keys, " +
      "relaxed and friendly, no vocals",
  },
  {
    key: "playful",
    title: "Игривый",
    prompt:
      "Playful quirky background music, bouncy plucked synths and marimba, " +
      "light humor, cartoonish, no vocals",
  },
  {
    key: "tech",
    title: "Технологичный",
    prompt:
      "Minimal tech background music, pulsing synth arpeggio, futuristic and " +
      "clean, steady rhythm, no vocals",
  },
  {
    key: "cinematic",
    title: "Кинематографичный",
    prompt:
      "Light cinematic background music, warm strings and soft piano, " +
      "inspiring build-up, no vocals",
  },
  {
    key: "eastern",
    title: "Восточный",
    prompt:
      "Modern eastern background music, oud and darbuka groove, warm " +
      "oriental scales, energetic but not loud, no vocals",
  },
  {
    key: "funk",
    title: "Фанк",
    prompt:
      "Light funk background music, muted electric guitar, groovy bassline, " +
      "confident and fun, no vocals",
  },
];

interface CreateResponse {
  code?: number;
  msg?: string;
  data?: { taskId?: string };
}

interface RecordResponse {
  code?: number;
  msg?: string;
  data?: {
    status?: string;
    errorMessage?: string;
    response?: {
      sunoData?: { audioUrl?: string; title?: string; duration?: number }[];
    };
  };
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.kieApiKey}`,
    "Content-Type": "application/json",
  };
}

async function createMusicTask(prompt: string): Promise<string> {
  const response = await fetch(CREATE_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      prompt,
      customMode: false,
      instrumental: true,
      model: config.kieMusicModel,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Kie.ai (музыка) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as CreateResponse;
  if (body.code !== 200 || !body.data?.taskId) {
    throw new Error(
      `Kie.ai (музыка) не создал задачу: code=${body.code}, msg=${body.msg}`,
    );
  }
  return body.data.taskId;
}

/**
 * Генерирует инструментальный трек и сохраняет его в outFile. Suno выдаёт
 * обычно два варианта на запрос — берём первый готовый.
 */
export async function generateMusicTrack(
  prompt: string,
  outFile: string,
): Promise<{ title?: string; durationSeconds?: number }> {
  const taskId = await createMusicTask(prompt);
  // Музыка считается заметно дольше картинок, поэтому свой лимит ожидания.
  const deadline = Date.now() + config.kieMusicTimeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${RECORD_URL}?taskId=${encodeURIComponent(taskId)}`,
      { headers: authHeaders() },
    );
    if (!response.ok) {
      throw new Error(
        `Kie.ai (музыка, статус) вернул ошибку ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as RecordResponse;
    const status = body.data?.status ?? "";
    const track = body.data?.response?.sunoData?.find((item) => item.audioUrl);

    if (status === "SUCCESS" && track?.audioUrl) {
      const audio = await fetch(track.audioUrl);
      if (!audio.ok) {
        throw new Error(`Не удалось скачать трек: HTTP ${audio.status}`);
      }
      await writeFile(outFile, Buffer.from(await audio.arrayBuffer()));
      return { title: track.title, durationSeconds: track.duration };
    }

    // Промежуточные статусы содержат слово PENDING/PROCESSING; всё, что
    // похоже на ошибку, прекращает ожидание.
    if (/FAIL|ERROR/i.test(status)) {
      throw new Error(
        `Kie.ai (музыка) не смог сгенерировать трек: ${body.data?.errorMessage ?? status}`,
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, config.kiePollIntervalMs),
    );
  }

  throw new Error(
    `Музыка не готова за ${Math.round(config.kieMusicTimeoutMs / 1000)} с. ` +
      "Можно увеличить KIE_MUSIC_TIMEOUT_SECONDS.",
  );
}
