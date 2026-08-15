import type { Caption } from "@remotion/captions";
import { config } from "./config";
import { speechSpeed } from "./speech";
import {
  isElevenLabsAvailable,
  listVoices,
  synthesizeSpeechDirect,
} from "./elevenlabs";
import { runKieTask } from "./kie";
import { resolveVoiceId } from "./voices";

export type TtsProvider = "kie" | "elevenlabs";

// Кандидаты моделей TTS для диагностики (/diag в боте): у Kie.ai слаги
// моделей меняются, и какая доступна на вашем аккаунте — выясняется опытом.
export const TTS_MODEL_CANDIDATES = [
  "elevenlabs/text-to-speech-multilingual-v2",
  "elevenlabs/text-to-speech-turbo-2-5",
  "elevenlabs/text-to-dialogue-v3",
];

/**
 * Набор параметров повторяет пример из документации Kie.ai, но пустые
 * необязательные поля не отправляются вовсе: на пустой language_code Kie.ai
 * отвечает "This language_code is not within the range of allowed options".
 */
export function buildTtsInput(
  text: string,
  voice: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text,
    voice: resolveVoiceId(voice),
    stability: config.ttsStability,
    similarity_boost: config.ttsSimilarityBoost,
    style: config.ttsStyle,
    speed: speechSpeed(config.ttsSpeed),
    timestamps: false,
  };
  if (config.kieTtsLanguageCode) {
    input.language_code = config.kieTtsLanguageCode;
  }
  return input;
}

/**
 * Предупреждение о сочетании «клонированный голос + прокси Kie.ai».
 *
 * Клон живёт в вашем аккаунте ElevenLabs, а Kie.ai обращается к ElevenLabs со
 * своего — значит вашего клона он, скорее всего, не видит, и озвучка выйдет
 * другим голосом. Проверить это со стороны кода нельзя (Kie.ai не сообщает,
 * какой голос он в итоге взял), поэтому просто предупреждаем: голос из вашего
 * аккаунта не из набора premade + провайдер kie — повод переключиться.
 *
 * Возвращает текст предупреждения или undefined, если сочетание безопасное
 * либо проверить нечем (нет ключа ElevenLabs, список голосов не отдался).
 */
export async function cloneViaProxyWarning(
  voice: string,
  provider?: TtsProvider,
): Promise<string | undefined> {
  if ((provider ?? config.ttsProvider) !== "kie") return undefined;
  if (!isElevenLabsAvailable()) return undefined;

  const voiceId = resolveVoiceId(voice);
  try {
    const found = (await listVoices()).find((v) => v.voiceId === voiceId);
    if (!found || found.category === "premade") return undefined;
    return (
      `Голос «${found.name}» — не базовый (${found.category}), он живёт в вашем ` +
      "аккаунте ElevenLabs. Сейчас озвучка идёт через прокси Kie.ai, который " +
      "обращается к ElevenLabs со своего аккаунта, поэтому ваш голос ему, " +
      "скорее всего, недоступен — и ролик озвучит кто-то другой.\n\n" +
      "Чтобы гарантированно звучал ваш голос: /tts elevenlabs"
    );
  } catch {
    return undefined;
  }
}

/**
 * Озвучка. По умолчанию через Kie.ai (проксирует модели ElevenLabs, отдельный
 * ключ не нужен). Провайдер "elevenlabs" — резервный путь напрямую, на случай
 * сбоев прокси Kie.ai; требует ELEVENLABS_API_KEY в .env.
 */
export async function synthesizeSpeech(
  text: string,
  outFile: string,
  voiceOverride?: string,
  modelOverride?: string,
  providerOverride?: TtsProvider,
): Promise<{ words?: Caption[] }> {
  const provider = providerOverride ?? config.ttsProvider;
  const voice = resolveVoiceId(voiceOverride ?? config.kieTtsVoice);

  if (provider === "elevenlabs") {
    // Прямой путь умеет отдавать тайминги символов — из них получаются
    // субтитры по словам без всякого распознавания.
    return synthesizeSpeechDirect(text, outFile, voice, config.wordSubtitles);
  }

  // У прокси Kie.ai таймингов нет: поле timestamps в их схеме есть, но что
  // именно возвращается — не документировано, а ломать рабочую озвучку
  // экспериментом не стоит. Слова для этого пути считаются приблизительно.
  const model = modelOverride ?? config.kieTtsModel;
  await runKieTask({
    model,
    input: buildTtsInput(text, voice),
    outFile,
    label: `озвучка, модель ${model}, голос ${voice}`,
  });
  return {};
}
