// Замер материала для клонирования голоса — на настоящих файлах, настоящим
// ffmpeg. Считать уровни «в уме» тут нельзя: ошибка в окне или в порядке
// каналов не видна никак, а на ней держится решение чистить дорожку или нет.
//
// Решение это важное. Мы прогоняли материал через Voice Isolator и ТУТ ЖЕ
// отправляли в клонирование с remove_background_noise=true — чистили дважды.
// В официальном SDK ElevenLabs про этот флаг сказано прямо: «If the samples do
// not include background noise, it can make the quality worse».
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "el-test";

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  measureVoiceSample,
  needsCleanup,
  qualityNotes,
  statsLine,
  SNR_NOISY_DB,
  IVC_MIN_SECONDS,
  IVC_ENOUGH_SECONDS,
} = await import("../src/pipeline/voiceQuality.ts");

const dir = mkdtempSync(path.join(tmpdir(), "amg-voice-"));
const file = (name) => path.join(dir, name);

// «Речь» — тон, прерываемый настоящими паузами: без пауз замерить фон нельзя,
// а в живой записи паузы между словами и есть то место, где слышен шум.
//
// Генератор sine у ffmpeg выдаёт всего -18 дБ (проверено volumedetect), а нам
// нужен уровень живой записи — отсюда постоянные +12 дБ.
const speech = (out, seconds, gainDb = 12) =>
  run("ffmpeg", [
    "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=180:duration=${seconds}`,
    "-af", `volume='if(lt(mod(t,1),0.6),1,0)':eval=frame,volume=${gainDb}dB`,
    "-ar", "44100", out,
  ]);

console.log("=== чистая запись ===");
await speech(file("clean.wav"), 90);
const clean = await measureVoiceSample(file("clean.wav"));
console.log(`      ${statsLine(clean)}`);
check("длительность измерена", Math.abs(clean.seconds - 90) < 0.5, String(clean.seconds));
check("частота прочитана", clean.sampleRate === 44100);
check("речь заметно выше фона", clean.snrDb > 40, `${clean.snrDb.toFixed(0)} дБ`);
check("чистить не надо", needsCleanup(clean) === false);
check("замечаний нет", qualityNotes(clean).length === 0, qualityNotes(clean).join(" | "));

console.log("\n=== шумная запись ===");
await run("ffmpeg", [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-i", file("clean.wav"),
  "-f", "lavfi", "-i", "anoisesrc=d=90:c=pink:a=0.35",
  "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:weights=1 1,volume=2",
  "-ar", "44100", file("noisy.wav"),
]);
const noisy = await measureVoiceSample(file("noisy.wav"));
console.log(`      ${statsLine(noisy)}`);
check("разница речь/фон упала", noisy.snrDb < SNR_NOISY_DB, `${noisy.snrDb.toFixed(0)} дБ`);
check("чистка нужна", needsCleanup(noisy) === true);
check("про шум сказано", qualityNotes(noisy).some((n) => /шумный/.test(n)), qualityNotes(noisy).join(" | "));

console.log("\n=== перегруз ===");
await speech(file("loud.wav"), 90, 30);
const loud = await measureVoiceSample(file("loud.wav"));
check("пик у потолка", loud.peakDb > -0.5, `${loud.peakDb.toFixed(1)} дБ`);
check("перегруз найден", loud.clippingShare > 0.001, `${(loud.clippingShare * 100).toFixed(1)}%`);
check("про хрип сказано", qualityNotes(loud).some((n) => /Перегруз/.test(n)));

console.log("\n=== низкая частота дискретизации ===");
await run("ffmpeg", [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-i", file("clean.wav"), "-ar", "8000", file("narrow.wav"),
]);
const narrow = await measureVoiceSample(file("narrow.wav"));
check("частота прочитана", narrow.sampleRate === 8000);
check("про срезанный верх сказано", qualityNotes(narrow).some((n) => /дискретизации/.test(n)));

console.log("\n=== длина материала ===");
await speech(file("short.wav"), 20);
const short = await measureVoiceSample(file("short.wav"));
check(
  `короче ${IVC_MIN_SECONDS} с — предупреждение`,
  qualityNotes(short).some((n) => /мало/.test(n)),
  qualityNotes(short).join(" | "),
);
// Больше материала мгновенный клон НЕ улучшает: качество важнее количества.
const longOne = { ...clean, seconds: IVC_ENOUGH_SECONDS + 120 };
check(
  "слишком много материала — тоже замечание",
  qualityNotes(longOne).some((n) => /лишнее/.test(n)),
  qualityNotes(longOne).join(" | "),
);

console.log("\n=== тишина ===");
// Половина дорожки — пауза: в сэмпле должна быть речь, а не ожидание.
await run("ffmpeg", [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=180:duration=90",
  "-af", "volume='if(lt(mod(t,4),1),0.5,0)':eval=frame",
  "-ar", "44100", file("gappy.wav"),
]);
const gappy = await measureVoiceSample(file("gappy.wav"));
check("тишина посчитана", gappy.silenceShare > 0.35, `${(gappy.silenceShare * 100).toFixed(0)}%`);
check("про паузы сказано", qualityNotes(gappy).some((n) => /Тишина/.test(n)));

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
