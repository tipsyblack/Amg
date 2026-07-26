// Kie.ai принимает голос только как voice_id: имя вроде "Rachel" проходит
// валидацию (это же строка), а потом генерация падает с "internal error".
// Здесь — классические голоса ElevenLabs, чтобы имя в .env не ломало озвучку.
const VOICE_IDS_BY_NAME: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  bella: "EXAVITQu4vr4xnSDxMaL",
  antoni: "ErXwobaYiN019PkySvjV",
  josh: "TxGEqnHWrfWFTfGW9XjX",
  adam: "pNInz6obpgDQGcFmaJgB",
};

// ID у ElevenLabs — 20 символов латиницы и цифр.
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

/**
 * Приводит значение голоса к ID: известные имена подменяет, всё остальное
 * пропускает как есть (это либо уже ID, либо голос из вашей библиотеки).
 */
export function resolveVoiceId(voice: string): string {
  const trimmed = voice.trim();
  if (VOICE_ID_PATTERN.test(trimmed)) return trimmed;
  return VOICE_IDS_BY_NAME[trimmed.toLowerCase()] ?? trimmed;
}

export function looksLikeVoiceId(voice: string): boolean {
  return VOICE_ID_PATTERN.test(voice.trim());
}

export const KNOWN_VOICE_NAMES = Object.keys(VOICE_IDS_BY_NAME);
