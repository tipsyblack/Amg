import { execFile } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dbToLinear, measureLoudness } from "./loudness";
import type { Loudness } from "./loudness";

const execFileAsync = promisify(execFile);

/**
 * Громкость, к которой приводятся все треки библиотеки.
 *
 * Само число не так важно, как то, что оно ОДНО для всех треков. Раньше
 * громкость подложки зависела от того, каким мастерингом её отдал генератор:
 * Suno отдаёт около −8 LUFS, а трек, положенный руками, может быть и −20. При
 * фиксированном множителе в миксе (MIX.music) это значит, что один трек слышно
 * как фон, а другой — как помеху или как ничто.
 *
 * −16 LUFS — обычный мастеринг музыки; при MIX.music подложка садится на 18-20
 * дБ ниже речи, как принято в говорящих роликах. В присланном референсе музыки
 * нет вовсе, поэтому сверить это число с ним нельзя — оно из практики, а не из
 * обмера, и это стоит держать в голове.
 */
export const MUSIC_LUFS = -16;

/** Потолок по пику: подложка не должна упираться в ноль до сведения. */
const MUSIC_PEAK_DB = -3;

/**
 * Ниже этого в подложке ничего полезного нет, а мешает много: там живут удары
 * стыков (у них низ в районе 95-130 Гц) и общий гул, который на телефонном
 * динамике превращается в кашу.
 */
const HIGHPASS_HZ = 60;

/**
 * Провал в полосе разборчивости речи. Согласные и внятность живут в 2-4 кГц;
 * широкий провал на 3 дБ там освобождает место голосу, оставаясь незаметным на
 * самой музыке.
 */
const SPEECH_DIP_HZ = 3000;
const SPEECH_DIP_DB = -3;
const SPEECH_DIP_WIDTH = 1.4;

/**
 * Длина склейки для бесшовной петли. Две секунды — компромисс: короче слышно
 * стык, длиннее заметно, что музыка «сама себя перебивает».
 */
const LOOP_CROSSFADE_SECONDS = 2;

/** Короче этого зацикливать нечего — склейка съест весь трек. */
const MIN_LOOPABLE_SECONDS = 8;

export interface PreparedMusic {
  before: Loudness;
  after: Loudness;
  secondsBefore: number;
  secondsAfter: number;
  looped: boolean;
}

async function durationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number(stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Готовит трек к работе фоном: ровная громкость, освобождённое место под голос
 * и бесшовная петля.
 *
 * Про петлю: Remotion повторяет файл целиком (`<Audio loop>`), поэтому на стыке
 * конца с началом слышен щелчок — там разрыв волны. Лечится переносом хвоста в
 * начало: результат длиной D−X, где первые X секунд — это начало трека,
 * смешанное с его затухающим хвостом. Тогда на стыке R(0) = orig(D−X), а перед
 * стыком звучит orig(D−X−ε) — то есть волна продолжается без разрыва, а не
 * прыгает.
 */
export async function prepareMusicTrack(
  inFile: string,
  outFile: string,
): Promise<PreparedMusic> {
  const before = await measureLoudness(inFile);
  const secondsBefore = await durationSeconds(inFile);

  // Промежуточные файлы — wav: mp3 добавляет на каждом проходе тишину
  // выравнивания кадра, и на склейке петли она бы как раз и слышалась.
  const toned = `${outFile}.tone.wav`;
  const leveled = `${outFile}.level.wav`;
  const mainPart = `${outFile}.main.wav`;
  const tailPart = `${outFile}.tail.wav`;
  const loop = `${outFile}.loop.wav`;
  const cleanup = [toned, leveled, mainPart, tailPart, loop];
  let wasLooped = false;

  try {
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inFile,
      "-af",
      `highpass=f=${HIGHPASS_HZ},` +
        `equalizer=f=${SPEECH_DIP_HZ}:t=q:w=${SPEECH_DIP_WIDTH}:g=${SPEECH_DIP_DB}`,
      "-ac", "2", "-ar", "44100",
      toned,
    ], { timeout: 5 * 60 * 1000 });

    // Громкость выставляем ДО склейки петли, а не после. У alimiter есть
    // предпросмотр, и первые миллисекунды файла он отдаёт тишиной — то есть
    // ровно ломает непрерывность на стыке, которую склейка и создаёт (замерено:
    // начало обработанного файла 7 против 3965 в середине). После склейки
    // остаётся только статическое усиление: нарушить непрерывность оно не может.
    //
    // Потолок здесь ниже итогового: в зоне склейки два сигнала складываются, и
    // сумма бывает громче каждого до 3 дБ. Запас снимает вопрос.
    const tonedLoudness = await measureLoudness(toned);
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", toned,
      "-af",
      `volume=${(MUSIC_LUFS - tonedLoudness.lufs).toFixed(2)}dB,` +
        `alimiter=limit=${dbToLinear(MUSIC_PEAK_DB - 3).toFixed(4)}:level=disabled`,
      "-ar", "44100",
      leveled,
    ], { timeout: 5 * 60 * 1000 });

    // Длину берём у промежуточного wav, а не у исходника: у mp3 в длительности
    // сидит тишина выравнивания, и склейка по чужой длине уезжает на десятки
    // миллисекунд — а на стыке это уже слышно.
    const seconds = await durationSeconds(leveled);
    const crossfade = Math.min(LOOP_CROSSFADE_SECONDS, Math.max(seconds / 4, 0));
    const looped = seconds >= MIN_LOOPABLE_SECONDS && crossfade > 0.2;

    wasLooped = looped;
    let staged = leveled;
    if (looped) {
      const keep = seconds - crossfade;
      // Две части — отдельными файлами, а не ветвями одного графа. Через
      // asplit+amix ffmpeg отдаёт результат длиной КОРОТКОЙ ветви (проверено:
      // 8-секундный трек превращался в 2 секунды), и duration=longest на это не
      // влияет. Смешивание двух готовых файлов длину считает верно.
      await execFileAsync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", leveled,
        "-af", `atrim=0:${keep.toFixed(3)},asetpts=N/SR/TB,afade=t=in:st=0:d=${crossfade.toFixed(3)}`,
        mainPart,
      ], { timeout: 5 * 60 * 1000 });
      await execFileAsync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", leveled,
        "-af", `atrim=${keep.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=0:d=${crossfade.toFixed(3)}`,
        tailPart,
      ], { timeout: 5 * 60 * 1000 });
      await execFileAsync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", mainPart, "-i", tailPart,
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[o]",
        "-map", "[o]",
        loop,
      ], { timeout: 5 * 60 * 1000 });
      staged = loop;
    }

    // Добор громкости — только статическим усилением, без лимитера: склейка
    // немного меняет громкость (в зоне перекрытия звучат две части сразу), а
    // трогать края файла на этом шаге уже нельзя.
    const mid = await measureLoudness(staged);
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", staged,
      "-af", `volume=${(MUSIC_LUFS - mid.lufs).toFixed(2)}dB`,
      "-ar", "44100",
      // Результат — wav. Не потому, что mp3 «ломает петлю»: я так сначала и
      // написал, а потом замерил — ffmpeg честно снимает задержку кодера и
      // добивку по тегам LAME, длительность остаётся ровной, провала на стыке
      // нет. Но зависит это от того, УЧИТЫВАЕТ ли декодер эти теги, а Remotion
      // декодирует в Chromium, и его поведение отсюда проверить не удалось.
      // wav снимает вопрос целиком, а библиотека всё равно лежит только на
      // сервере — платим размером файла, которого никто не увидит.
      "-c:a", "pcm_s16le",
      outFile,
    ], { timeout: 5 * 60 * 1000 });
  } finally {
    for (const file of cleanup) await rm(file, { force: true });
  }

  return {
    before,
    after: await measureLoudness(outFile),
    secondsBefore,
    secondsAfter: await durationSeconds(outFile),
    looped: wasLooped,
  };
}

/**
 * Готовит трек на месте — так библиотека приводится к порядку без перекладывания
 * файлов. Расширение меняется на .wav: петля работает без щелчка только так
 * (см. комментарий выше).
 */
export async function prepareMusicTrackInPlace(
  file: string,
): Promise<{ file: string; result: PreparedMusic }> {
  const target = path.join(
    path.dirname(file),
    `${path.basename(file, path.extname(file))}.wav`,
  );
  const temporary = `${target}.prepared.wav`;
  const result = await prepareMusicTrack(file, temporary);
  await rm(file, { force: true });
  await rename(temporary, target);
  return { file: target, result };
}
