import { writeFile } from "node:fs/promises";
import type { Caption } from "@remotion/captions";
import { config } from "./config";
import { speechSpeed } from "./speech";
import { directModelId } from "./ttsModels";
import { resolveVoiceId } from "./voices";
import { charactersToWords, type AlignmentPayload } from "./wordTimings";

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
 * Каким способом сделан голос, по-русски.
 *
 * Нужно, чтобы на вопрос «у нас мгновенный клон или профессиональный» можно
 * было ответить из чата, а не по памяти о том, где голос создавали. Наш /clone
 * умеет только мгновенный, но голос могли завести и в кабинете ElevenLabs — там
 * доступны оба, и разница в похожести между ними принципиальная.
 *
 * Названия категорий — из официального SDK (VoiceCategory): generated, cloned,
 * premade, professional, famous, high_quality.
 */
export function voiceKind(category: string): string {
  switch (category) {
    case "cloned":
      return "мгновенный клон (IVC)";
    case "professional":
      return "профессиональный клон (PVC)";
    case "premade":
      return "базовый голос ElevenLabs";
    case "generated":
      return "сгенерированный голос";
    case "famous":
    case "high_quality":
      return "голос из библиотеки";
    default:
      return category;
  }
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
  modelOverride?: string,
  // Запросить выравнивание по символам вместе с аудио — из него собираются
  // тайминги слов для субтитров. Отдельный эндпоинт, зато не нужно ничего
  // распознавать: модель сама знает, когда произносит каждый символ.
  withTimestamps = false,
): Promise<{ words?: Caption[] }> {
  if (!config.elevenLabsApiKey) {
    throw new Error(
      "Резервная озвучка через ElevenLabs недоступна: в .env нет " +
        "ELEVENLABS_API_KEY. Добавьте ключ с elevenlabs.io и перезапустите бота.",
    );
  }

  const voiceId = resolveVoiceId(voiceOverride ?? config.kieTtsVoice);
  const url = withTimestamps
    ? `${API_BASE}/${voiceId}/with-timestamps`
    : `${API_BASE}/${voiceId}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenLabsApiKey,
      "Content-Type": "application/json",
      // Эндпоинт с таймингами отвечает JSON, обычный — сразу mp3.
      Accept: withTimestamps ? "application/json" : "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: directModelId(modelOverride),
      // use_speaker_boost работает только здесь, у прямого API: он заметно
      // добавляет сходства с оригинальным тембром клона.
      voice_settings: {
        stability: config.ttsStability,
        similarity_boost: config.ttsSimilarityBoost,
        style: config.ttsStyle,
        use_speaker_boost: config.ttsSpeakerBoost,
        // Скорость речи. Раньше её тут не было вовсе: настройка уходила
        // только через прокси Kie.ai, а единая озвучка идёт прямым путём —
        // и говорила всегда с обычной скоростью, что бы ни стояло в .env.
        //
        // Важно, что ускоряет САМ синтезатор, а не мы постфактум: тайминги
        // слов приходят уже пересчитанными, и субтитры остаются на месте.
        // Ускорение через ffmpeg этого не даёт — там пришлось бы
        // пересчитывать выравнивание руками и надеяться, что не разъедется.
        speed: speechSpeed(config.ttsSpeed),
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

  if (!withTimestamps) {
    await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
    return {};
  }

  // Формат ответа с таймингами не проверен на живом API из этой песочницы
  // (доступа наружу нет), поэтому читаем защитно: если структура другая —
  // сохраняем звук, а слова посчитаются приблизительно выше по стеку.
  const data = (await response.json()) as {
    audio_base64?: string;
    alignment?: AlignmentPayload;
    normalized_alignment?: AlignmentPayload;
  };
  if (!data.audio_base64) {
    throw new Error(
      "ElevenLabs вернул ответ с таймингами без звука — попробуйте ещё раз " +
        "или отключите субтитры по словам.",
    );
  }
  await writeFile(outFile, Buffer.from(data.audio_base64, "base64"));

  const alignment = data.alignment ?? data.normalized_alignment;
  const words = alignment ? charactersToWords(alignment) : [];
  return { words: words.length > 0 ? words : undefined };
}
