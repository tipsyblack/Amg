import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Замер материала для клонирования голоса.
 *
 * Зачем: «клон не совсем похож» — ощущение, и спорить о нём бесполезно. Похож
 * клон ровно настолько, насколько чист и однороден исходник, а это измеримо:
 * шум между словами, перегруз, частота дискретизации, доля тишины.
 *
 * И один вывод, который замер уже дал по нашему же коду. Мы прогоняли дорожку
 * через Voice Isolator, а потом отправляли её в клонирование с
 * `remove_background_noise=true` — то есть чистили ДВАЖДЫ. В официальном SDK
 * ElevenLabs про этот флаг сказано прямо: «If the samples do not include
 * background noise, it can make the quality worse». Уже очищенная дорожка
 * background noise и не содержит — второй проход только съедал призвуки,
 * из которых и складывается узнаваемость голоса.
 */

/** Окно замера. 100 мс — короче слога, но длиннее одного периода голоса. */
const FRAME_MS = 100;
const RATE = 16_000;
const FRAME = (RATE * FRAME_MS) / 1000;

export interface VoiceSampleStats {
  seconds: number;
  sampleRate: number;
  channels: number;
  /** Уровень в паузах между словами: 10-й процентиль окон. */
  noiseFloorDb: number;
  /** Уровень самой речи: 90-й процентиль окон. */
  speechDb: number;
  /** Насколько речь выше шума. Главное число: ниже 20 дБ — шумный материал. */
  snrDb: number;
  peakDb: number;
  /** Доля отсчётов, упёршихся в потолок. Перегруз клонируется как хрип. */
  clippingShare: number;
  /** Доля окон тише -50 дБ: длинные паузы место в сэмпле занимают, а голоса не несут. */
  silenceShare: number;
}

async function probe(file: string): Promise<{ sampleRate: number; channels: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels",
    "-of", "csv=p=0", file,
  ]);
  const [rate, channels] = stdout.trim().split(",");
  return { sampleRate: Number(rate) || 0, channels: Number(channels) || 0 };
}

const db = (value: number) => (value <= 0 ? -120 : 20 * Math.log10(value));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -120;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[index];
}

export async function measureVoiceSample(file: string): Promise<VoiceSampleStats> {
  const { sampleRate, channels } = await probe(file);
  // Считаем по моно 16 кГц: нас интересуют уровни, а не тембр, и так замер
  // одинаково работает и на mp3 из мессенджера, и на wav со студии.
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", file,
      "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-",
    ],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );

  const samples = new Int16Array(
    stdout.buffer,
    stdout.byteOffset,
    Math.floor(stdout.byteLength / 2),
  );

  let peak = 0;
  let clipped = 0;
  const frames: number[] = [];
  for (let start = 0; start < samples.length; start += FRAME) {
    let sum = 0;
    let count = 0;
    for (let i = start; i < Math.min(start + FRAME, samples.length); i++) {
      const value = Math.abs(samples[i]) / 32768;
      if (value > peak) peak = value;
      // 32700 из 32768 — уже полка: живая речь туда не доходит без перегруза.
      if (Math.abs(samples[i]) >= 32700) clipped++;
      sum += value * value;
      count++;
    }
    if (count > 0) frames.push(db(Math.sqrt(sum / count)));
  }

  const sorted = [...frames].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, 0.1);
  const speechDb = percentile(sorted, 0.9);
  return {
    seconds: samples.length / RATE,
    sampleRate,
    channels,
    noiseFloorDb,
    speechDb,
    snrDb: speechDb - noiseFloorDb,
    peakDb: db(peak),
    clippingShare: samples.length ? clipped / samples.length : 0,
    silenceShare: frames.length
      ? frames.filter((f) => f < -50).length / frames.length
      : 0,
  };
}

// Пороги. Ниже 20 дБ разницы между речью и паузой шум уже слышен в клоне;
// 30 дБ и выше — материал студийного порядка.
export const SNR_NOISY_DB = 20;
// Мгновенному клону хватает одной-двух минут. Больше материала его НЕ
// улучшает: качество важнее количества, а лишние минуты добавляют разнобой.
export const IVC_MIN_SECONDS = 60;
export const IVC_ENOUGH_SECONDS = 180;
// Профессиональный клон — другой разговор: там нужны десятки минут.
export const PVC_MIN_SECONDS = 30 * 60;

/** Нужна ли чистка от музыки и шума. Чистая дорожка от неё только портится. */
export function needsCleanup(stats: VoiceSampleStats): boolean {
  return stats.snrDb < SNR_NOISY_DB;
}

/**
 * Что не так с материалом, человеческим языком. Пустой список — материал
 * годный, и если клон всё равно не похож, дело уже не в записи.
 */
export function qualityNotes(stats: VoiceSampleStats): string[] {
  const notes: string[] = [];

  if (stats.seconds < IVC_MIN_SECONDS) {
    notes.push(
      `Материала ${Math.round(stats.seconds)} с — мало. Минута-две чистой ` +
        "речи одного человека даёт заметно более похожий клон.",
    );
  } else if (stats.seconds > IVC_ENOUGH_SECONDS) {
    notes.push(
      `Материала ${Math.round(stats.seconds / 60)} мин — для мгновенного ` +
        "клона это уже лишнее: он не становится точнее, а разнобой в записи " +
        "и настроении копится. Оставьте лучшие полторы-две минуты.",
    );
  }

  if (stats.snrDb < SNR_NOISY_DB) {
    notes.push(
      `Речь выше фона всего на ${stats.snrDb.toFixed(0)} дБ — материал шумный ` +
        `(норма от ${SNR_NOISY_DB}). Клон повторит и шум, и «комнату».`,
    );
  }

  if (stats.clippingShare > 0.001) {
    notes.push(
      `Перегруз: ${(stats.clippingShare * 100).toFixed(1)}% отсчётов упёрлись ` +
        "в потолок. Это хрип, и он клонируется вместе с голосом — перезапишите " +
        "тише или возьмите другой дубль.",
    );
  }

  if (stats.sampleRate > 0 && stats.sampleRate < 32_000) {
    notes.push(
      `Частота дискретизации ${stats.sampleRate} Гц — верх голоса срезан ещё ` +
        "до нас, и в клоне его не будет. Нужен исходник от 44.1 кГц, а не " +
        "перегнанный через мессенджер.",
    );
  }

  if (stats.silenceShare > 0.35) {
    notes.push(
      `Тишина занимает ${(stats.silenceShare * 100).toFixed(0)}% дорожки. ` +
        "Вырежьте длинные паузы: в сэмпле должна быть речь, а не ожидание.",
    );
  }

  if (stats.peakDb < -12) {
    notes.push(
      `Запись тихая (пик ${stats.peakDb.toFixed(0)} дБ). Сама по себе тихая ` +
        "запись не беда, но вместе с шумом она означает, что шума в клоне " +
        "будет больше, чем кажется.",
    );
  }

  return notes;
}

/** Короткая сводка замера для чата. */
export function statsLine(stats: VoiceSampleStats): string {
  return (
    `${Math.round(stats.seconds)} с · ${stats.sampleRate} Гц · ` +
    `речь ${stats.speechDb.toFixed(0)} дБ, фон ${stats.noiseFloorDb.toFixed(0)} дБ ` +
    `(разница ${stats.snrDb.toFixed(0)} дБ) · тишины ${(stats.silenceShare * 100).toFixed(0)}%`
  );
}
