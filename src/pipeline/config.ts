import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Отсутствует переменная окружения ${name}. Заполните .env (см. .env.example).`,
    );
  }
  return value;
}

export const config = {
  openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  openRouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",
  openRouterImageModel:
    process.env.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image-preview",
  elevenLabsApiKey: requireEnv("ELEVENLABS_API_KEY"),
  elevenLabsVoiceId: requireEnv("ELEVENLABS_VOICE_ID"),
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
  fps: 30,
  width: Number(process.env.VIDEO_WIDTH ?? 1080),
  height: Number(process.env.VIDEO_HEIGHT ?? 1920),
};
