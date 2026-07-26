import { config } from "./config";
import { synthesizeSpeechDirect } from "./elevenlabs";
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
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    speed: config.kieTtsSpeed,
    timestamps: false,
  };
  if (config.kieTtsLanguageCode) {
    input.language_code = config.kieTtsLanguageCode;
  }
  return input;
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
): Promise<void> {
  const provider = providerOverride ?? config.ttsProvider;
  const voice = resolveVoiceId(voiceOverride ?? config.kieTtsVoice);

  if (provider === "elevenlabs") {
    await synthesizeSpeechDirect(text, outFile, voice);
    return;
  }

  const model = modelOverride ?? config.kieTtsModel;
  await runKieTask({
    model,
    input: buildTtsInput(text, voice),
    outFile,
    label: `озвучка, модель ${model}, голос ${voice}`,
  });
}
