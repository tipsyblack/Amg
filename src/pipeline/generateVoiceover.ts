import { config } from "./config";
import { runKieTask } from "./kie";

// Озвучка идёт через Kie.ai, который проксирует модели ElevenLabs —
// отдельный аккаунт и ключ ElevenLabs не нужны.
export async function synthesizeSpeech(
  text: string,
  outFile: string,
): Promise<void> {
  await runKieTask({
    model: config.kieTtsModel,
    input: {
      text,
      voice: config.kieTtsVoice,
      speed: config.kieTtsSpeed,
    },
    outFile,
    label: "озвучка",
  });
}
