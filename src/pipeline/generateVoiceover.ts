import { writeFile } from "node:fs/promises";
import { config } from "./config";

export async function synthesizeSpeech(
  text: string,
  outFile: string,
): Promise<void> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsApiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: config.elevenLabsModelId,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `ElevenLabs вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outFile, buffer);
}
