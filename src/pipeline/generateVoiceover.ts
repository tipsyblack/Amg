import { config } from "./config";
import { runKieTask } from "./kie";

// Озвучка идёт через Kie.ai, который проксирует модели ElevenLabs —
// отдельный аккаунт и ключ ElevenLabs не нужны.
//
// Набор параметров повторяет пример из документации Kie.ai целиком: модель
// капризна к неполным запросам, поэтому отправляем все поля явно.
export async function synthesizeSpeech(
  text: string,
  outFile: string,
  voiceOverride?: string,
): Promise<void> {
  await runKieTask({
    model: config.kieTtsModel,
    input: {
      text,
      voice: voiceOverride ?? config.kieTtsVoice,
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      speed: config.kieTtsSpeed,
      timestamps: false,
      previous_text: "",
      next_text: "",
      language_code: config.kieTtsLanguageCode,
    },
    outFile,
    label: "озвучка",
  });
}
