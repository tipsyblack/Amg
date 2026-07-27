import { writeFile } from "node:fs/promises";
import { config } from "./config";
import { resolveVoiceId } from "./voices";

// Прямой ElevenLabs — резервный путь на случай, когда прокси Kie.ai для
// моделей ElevenLabs не работает. Синхронный: сразу отдаёт mp3, без задач и
// опроса статуса.
const API_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const VOICES_URL = "https://api.elevenlabs.io/v1/voices";

export function isElevenLabsAvailable(): boolean {
  return Boolean(config.elevenLabsApiKey);
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  // "premade" — базовый набор, доступен и на бесплатном тарифе;
  // библиотечные и клонированные голоса требуют платной подписки.
  category: string;
}

/**
 * Спрашивает у ElevenLabs список голосов, доступных этому ключу. Нужен,
 * потому что состав голосов зависит от тарифа: на бесплатном библиотечные
 * голоса через API закрыты, и угадывать ID бессмысленно.
 */
export async function listVoices(): Promise<ElevenLabsVoice[]> {
  if (!config.elevenLabsApiKey) {
    throw new Error("Нет ELEVENLABS_API_KEY в .env");
  }

  const response = await fetch(VOICES_URL, {
    headers: { "xi-api-key": config.elevenLabsApiKey },
  });
  if (!response.ok) {
    const body = await response.text();
    if (body.includes("voices_read")) {
      throw new Error(
        "У ключа ElevenLabs нет права voices_read, поэтому список голосов " +
          "через API недоступен.\n\n" +
          "Либо добавьте это право (elevenlabs.io → Settings → API Keys → " +
          "ваш ключ → включить Voices Read), либо возьмите ID голоса вручную: " +
          "elevenlabs.io → Voices / My Voices → выбрать голос → там же " +
          "показан Voice ID. Права для этого не нужны.\n\n" +
          "Затем: /voice <id>",
      );
    }
    throw new Error(
      `ElevenLabs (список голосов) вернул ошибку ${response.status}: ${body}`,
    );
  }

  const data = (await response.json()) as {
    voices?: { voice_id?: string; name?: string; category?: string }[];
  };
  return (data.voices ?? [])
    .filter((voice) => voice.voice_id)
    .map((voice) => ({
      voiceId: voice.voice_id as string,
      name: voice.name ?? "без имени",
      category: voice.category ?? "неизвестно",
    }));
}

export async function synthesizeSpeechDirect(
  text: string,
  outFile: string,
  voiceOverride?: string,
): Promise<void> {
  if (!config.elevenLabsApiKey) {
    throw new Error(
      "Резервная озвучка через ElevenLabs недоступна: в .env нет " +
        "ELEVENLABS_API_KEY. Добавьте ключ с elevenlabs.io и перезапустите бота.",
    );
  }

  const voiceId = resolveVoiceId(voiceOverride ?? config.kieTtsVoice);
  const response = await fetch(`${API_BASE}/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenLabsApiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: config.elevenLabsModelId,
      // use_speaker_boost работает только здесь, у прямого API: он заметно
      // добавляет сходства с оригинальным тембром клона.
      voice_settings: {
        stability: config.ttsStability,
        similarity_boost: config.ttsSimilarityBoost,
        style: config.ttsStyle,
        use_speaker_boost: config.ttsSpeakerBoost,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // Частые отказы ElevenLabs объясняем по-человечески: из сырого JSON
    // непонятно, что делать дальше.
    if (body.includes("missing the permission")) {
      throw new Error(
        "У ключа ElevenLabs нет права text_to_speech. Откройте " +
          "elevenlabs.io → Settings → API Keys, включите разрешение " +
          "Text to Speech (или создайте ключ с этим правом).",
      );
    }
    if (body.includes("library voices") || body.includes("paid_plan_required")) {
      throw new Error(
        `Голос ${voiceId} недоступен на вашем тарифе ElevenLabs: через API ` +
          "бесплатным аккаунтам разрешены только базовые (premade) голоса. " +
          "Посмотрите доступные командой /voices и выберите из раздела " +
          "«Базовые», либо оформите подписку.",
      );
    }
    if (body.includes("quota_exceeded")) {
      throw new Error(
        "Закончился лимит символов ElevenLabs на этот период. Проверьте " +
          "остаток в кабинете или переключитесь обратно: /tts kie",
      );
    }
    throw new Error(
      `ElevenLabs (голос ${voiceId}) вернул ошибку ${response.status}: ${body}`,
    );
  }

  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}
