import { writeFile } from "node:fs/promises";
import { config } from "./config";
import { resolveVoiceId } from "./voices";

// Прямой ElevenLabs — резервный путь на случай, когда прокси Kie.ai для
// моделей ElevenLabs не работает. Синхронный: сразу отдаёт mp3, без задач и
// опроса статуса.
const API_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

export function isElevenLabsAvailable(): boolean {
  return Boolean(config.elevenLabsApiKey);
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
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `ElevenLabs (голос ${voiceId}) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }

  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}
