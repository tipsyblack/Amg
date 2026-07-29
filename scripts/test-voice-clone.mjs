// Проверка клонирования голоса: извлечение и склейка дорожек делаются
// настоящим ffmpeg, вызовы ElevenLabs — на локальном моке.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const PORT = 45797;
let isolationRequest = null;
let cloneRequest = null;
let editRequest = null;
let sampleDownloads = [];
let isolationCalls = [];
let scenario = "ok";
/** Настоящие mp3-байты, которыми мок отвечает на очистку длинного материала. */
let realMp3 = Buffer.alloc(0);
// Состав голоса меняется после успешного edit — по нему бот и проверяет, что
// материал действительно добавился.
let voiceSamples = [
  { sample_id: "s1", file_name: "old-1.mp3", duration_secs: 40 },
  { sample_id: "s2", file_name: "old-2.mp3", duration_secs: 44 },
];

// Предел ElevenLabs на один загружаемый файл — его мок и проверяет. Берём
// строгое чтение «11MB»: десятичные мегабайты.
const MAX_UPLOAD_BYTES = 11_000_000;
const TOO_BIG_BODY =
  '{"detail":{"type":"invalid_request","code":"bad_request","message":"A ' +
  'uploaded file is too large, please upload files with a maximum of 11MB.",' +
  '"status":"upload_file_size_exceeded","param":"file"}}';

/**
 * Размеры файловых частей multipart — по ним мок и решает, отвергать ли запрос.
 * Настоящий ElevenLabs считает каждый файл отдельно, поэтому проверять суммарный
 * объём тела нельзя: три куска по 9 МБ он принимает, а один на 16 МБ — нет.
 */
function filePartSizes(req, buffer) {
  const match = /boundary=([^;]+)/.exec(req.headers["content-type"] ?? "");
  if (!match) return [];
  const boundary = Buffer.from(`--${match[1]}`);
  const sizes = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buffer.subarray(start + boundary.length, next);
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd !== -1) {
      const head = part.subarray(0, headEnd).toString("latin1");
      // -4 на разделитель заголовков, -2 на \r\n перед следующей границей.
      if (/filename=/.test(head)) sizes.push(part.length - headEnd - 6);
    }
    start = next;
  }
  return sizes;
}

// Читаем multipart грубо, но достаточно, чтобы проверить состав полей.
// latin1 — чтобы искать имена полей и не портить двоичные части; utf8 нужен
// отдельно, иначе кириллица внутри полей превращается в мусор.
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  return {
    latin1: buffer.toString("latin1"),
    utf8: buffer.toString("utf8"),
    fileSizes: filePartSizes(req, buffer),
  };
}

function tooBig(request) {
  return request.fileSizes.some((size) => size > MAX_UPLOAD_BYTES);
}

function rejectTooBig(res) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(TOO_BIG_BODY);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/v1/audio-isolation") {
    isolationRequest = { key: req.headers["xi-api-key"], ...(await readBody(req)) };
    isolationCalls.push(isolationRequest.fileSizes[0] ?? 0);
    if (tooBig(isolationRequest)) {
      rejectTooBig(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    // По умолчанию отдаём заглушку-строку: так проще проверить, что результат
    // дошёл до диска байт в байт. Для длинного материала нужен настоящий mp3 —
    // его придётся склеивать из частей.
    res.end(scenario === "isolate-real" ? realMp3 : Buffer.from("ОЧИЩЕННОЕ-АУДИО"));
    return;
  }

  if (url.pathname === "/v1/voices/add") {
    cloneRequest = { key: req.headers["xi-api-key"], ...(await readBody(req)) };
    if (tooBig(cloneRequest)) {
      rejectTooBig(res);
      return;
    }
    if (scenario === "no-plan") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"detail":{"status":"can_not_use_instant_voice_cloning"}}');
      return;
    }
    if (scenario === "limit") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"detail":{"status":"voice_limit_reached"}}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"voice_id":"cloned123456789012345"}');
    return;
  }

  // Состав голоса.
  const details = url.pathname.match(/^\/v1\/voices\/([^/]+)$/);
  if (details && req.method === "GET") {
    if (scenario === "no-voice") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"detail":"not found"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "Шамиль2", samples: voiceSamples }));
    return;
  }

  // Скачивание уже загруженного сэмпла.
  const sample = url.pathname.match(/^\/v1\/voices\/([^/]+)\/samples\/([^/]+)\/audio$/);
  if (sample) {
    if (scenario === "sample-gone") {
      res.writeHead(500);
      res.end();
      return;
    }
    sampleDownloads.push(sample[2]);
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from(`СТАРЫЙ-СЭМПЛ-${sample[2]}`));
    return;
  }

  // Добавление материала в существующий голос.
  const edit = url.pathname.match(/^\/v1\/voices\/([^/]+)\/edit$/);
  if (edit) {
    editRequest = { voiceId: edit[1], key: req.headers["xi-api-key"], ...(await readBody(req)) };
    if (tooBig(editRequest)) {
      rejectTooBig(res);
      return;
    }
    if (scenario === "not-editable") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"detail":{"status":"voice_not_editable"}}');
      return;
    }
    if (scenario === "edit-404") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"detail":"no such voice"}');
      return;
    }
    // Успех: в голосе стало на один сэмпл больше.
    voiceSamples = [
      ...voiceSamples,
      { sample_id: "s3", file_name: "new.mp3", duration_secs: 60 },
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }

  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const workDir = mkdtempSync(path.join(tmpdir(), "amg-clone-test-"));
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";
process.env.ELEVENLABS_API_KEY = "el-key";

const clone = await import("/home/user/Amg/src/pipeline/voiceClone.ts");
const audio = await import("/home/user/Amg/src/bot/extractAudio.ts");

const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) =>
  realFetch(String(u).replace("https://api.elevenlabs.io", `http://127.0.0.1:${PORT}`), init);

console.log("=== извлечение дорожки из видео (реальный ffmpeg) ===");
// Делаем два «видео» с тоном разной длины
const v1 = path.join(workDir, "v1.mp4");
const v2 = path.join(workDir, "v2.mp4");
await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=3",
  "-f", "lavfi", "-i", "sine=frequency=400:duration=3", "-shortest", v1, "-loglevel", "error"]);
await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
  "-f", "lavfi", "-i", "sine=frequency=600:duration=2", "-shortest", v2, "-loglevel", "error"]);

const a1 = path.join(workDir, "a1.mp3");
const a2 = path.join(workDir, "a2.mp3");
await audio.extractAudio(v1, a1);
await audio.extractAudio(v2, a2);
const d1 = await audio.audioDurationSeconds(a1);
const d2 = await audio.audioDurationSeconds(a2);
check("дорожка из первого видео извлечена", d1 > 2.5 && d1 < 3.6, `${d1.toFixed(2)} с`);
check("дорожка из второго видео извлечена", d2 > 1.5 && d2 < 2.6, `${d2.toFixed(2)} с`);

console.log("\n=== склейка дорожек ===");
const merged = path.join(workDir, "merged.mp3");
await audio.concatAudio([a1, a2], merged);
const dm = await audio.audioDurationSeconds(merged);
check("длительность сложилась", dm > d1 + d2 - 0.5 && dm < d1 + d2 + 0.5, `${dm.toFixed(2)} с ≈ ${(d1 + d2).toFixed(2)}`);

const single = path.join(workDir, "single.mp3");
await audio.concatAudio([a1], single);
check("склейка одного файла работает", (await audio.audioDurationSeconds(single)) > 2.5);

console.log("\n=== очистка от музыки ===");
const cleaned = path.join(workDir, "cleaned.mp3");
await clone.isolateVoice(merged, cleaned);
check("результат сохранён", readFileSync(cleaned, "utf8") === "ОЧИЩЕННОЕ-АУДИО");
check("ключ передан", isolationRequest.key === "el-key");
check("файл отправлен полем audio", /name="audio"/.test(isolationRequest.latin1), "поля: " + (isolationRequest.latin1.match(/name="[^"]+"/g) || []).join(","));

console.log("\n=== создание клона ===");
const { voiceId } = await clone.createInstantVoiceClone({ name: "Шамиль", files: [cleaned] });
check("voice_id вернулся", voiceId === "cloned123456789012345", voiceId);
check("имя передано", /name="name"/.test(cloneRequest.latin1));
check("файлы переданы полем files", /name="files"/.test(cloneRequest.latin1));
check("шумоподавление включено", /name="remove_background_noise"[\s\S]{0,40}true/.test(cloneRequest.latin1));

console.log("\n=== понятные ошибки ===");
scenario = "no-plan";
try {
  await clone.createInstantVoiceClone({ name: "x", files: [cleaned] });
  check("должно было упасть", false);
} catch (e) {
  check("про тариф объяснено", e.message.includes("не разрешает клонирование"), e.message.slice(0, 60));
}
scenario = "limit";
try {
  await clone.createInstantVoiceClone({ name: "x", files: [cleaned] });
  check("должно было упасть", false);
} catch (e) {
  check("про лимит голосов объяснено", e.message.includes("лимит голосов"), e.message.slice(0, 60));
}

console.log("\n=== состав уже созданного клона ===");
scenario = "ok";
const before = await clone.getVoiceSamples("voice-shamil-2");
check("имя голоса прочитано", before.name === "Шамиль2", before.name);
check("сэмплы перечислены", before.samples.length === 2, String(before.samples.length));
check("длительности прочитаны", before.samples[0].durationSeconds === 40);
check(
  "id сэмплов на месте",
  before.samples.map((s) => s.sampleId).join(",") === "s1,s2",
);
scenario = "no-voice";
try {
  await clone.getVoiceSamples("нет");
  check("должно было упасть", false);
} catch (e) {
  check("отсутствие голоса объяснено", e.message.includes("404"), e.message.slice(0, 50));
}
scenario = "ok";

console.log("\n=== скачивание прежних сэмплов ===");
const oldSample = path.join(workDir, "old.mp3");
await clone.downloadVoiceSample("voice-shamil-2", "s1", oldSample);
check("сэмпл сохранён на диск", readFileSync(oldSample, "utf8") === "СТАРЫЙ-СЭМПЛ-s1");

console.log("\n=== добавление материала в существующий голос ===");
sampleDownloads = [];
// Так это делает бот: старые сэмплы скачиваются и уходят обратно вместе с новым.
const oldFiles = [];
for (const s of before.samples) {
  const file = path.join(workDir, `old-${s.sampleId}.mp3`);
  await clone.downloadVoiceSample("voice-shamil-2", s.sampleId, file);
  oldFiles.push(file);
}
await clone.editInstantVoiceClone({
  voiceId: "voice-shamil-2",
  name: before.name,
  files: [...oldFiles, cleaned],
});
check("запрос ушёл на нужный голос", editRequest.voiceId === "voice-shamil-2", editRequest.voiceId);
check("ключ передан", editRequest.key === "el-key");
check("имя сохранено", /name="name"[\s\S]{0,60}Шамиль2/.test(editRequest.utf8));
check("шумоподавление включено", /name="remove_background_noise"[\s\S]{0,40}true/.test(editRequest.latin1));
const fileFields = (editRequest.latin1.match(/name="files"/g) ?? []).length;
check("отправлены и старые сэмплы, и новый", fileFields === 3, `полей files: ${fileFields}`);
check("старый материал внутри запроса", editRequest.utf8.includes("СТАРЫЙ-СЭМПЛ-s1"));
check("новый материал внутри запроса", editRequest.utf8.includes("ОЧИЩЕННОЕ-АУДИО"));
check("скачаны оба прежних сэмпла", sampleDownloads.join(",").includes("s1") && sampleDownloads.join(",").includes("s2"));

const after = await clone.getVoiceSamples("voice-shamil-2");
check("сэмплов стало больше", after.samples.length === before.samples.length + 1, `${before.samples.length} → ${after.samples.length}`);
const secondsAfter = after.samples.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
check("материала стало больше", secondsAfter === 144, `${secondsAfter} с`);

console.log("\n=== ошибки при добавлении ===");
scenario = "not-editable";
try {
  await clone.editInstantVoiceClone({ voiceId: "v", name: "n", files: [cleaned] });
  check("должно было упасть", false);
} catch (e) {
  check("про неизменяемый голос объяснено", e.message.includes("не мгновенный клон"), e.message.slice(0, 60));
  check("предложен путь создать новый", e.message.includes("/clone"));
}
scenario = "edit-404";
try {
  await clone.editInstantVoiceClone({ voiceId: "v", name: "n", files: [cleaned] });
  check("должно было упасть", false);
} catch (e) {
  check("удалённый голос объяснён", e.message.includes("не найден в аккаунте"), e.message.slice(0, 60));
}
scenario = "sample-gone";
try {
  await clone.downloadVoiceSample("v", "s1", path.join(workDir, "x.mp3"));
  check("должно было упасть", false);
} catch (e) {
  check("недоступный сэмпл — понятная ошибка", e.message.includes("сэмпл s1"), e.message.slice(0, 50));
}
scenario = "ok";

// ——— Предел ElevenLabs на размер загружаемого файла ———
// Наступали на него так: пять роликов, 434 секунды речи, после очистки от
// музыки — 16,5 МБ одним файлом, и voices/*/edit отвечал
// 400 upload_file_size_exceeded. Материал терялся целиком.
console.log("\n=== предел 11 МБ на файл ===");
const samples = await import("/home/user/Amg/src/pipeline/voiceSamples.ts");
check("предел в коде совпадает с тем, что говорит ElevenLabs", samples.MAX_UPLOAD_BYTES === MAX_UPLOAD_BYTES);

const fat = path.join(workDir, "fat.mp3");
await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i",
  "sine=frequency=220:duration=434", "-ac", "1", "-b:a", "320k", fat, "-loglevel", "error"]);
const fatSize = statSync(fat).size;
check("исходник действительно больше лимита", fatSize > MAX_UPLOAD_BYTES, `${(fatSize / 1e6).toFixed(1)} МБ`);

const fitted = await samples.prepareUploadFiles([fat], path.join(workDir, "fit-fat"));
check("уложился одним файлом, без нарезки", fitted.length === 1, `файлов: ${fitted.length}`);
check(
  "файл влез в лимит",
  statSync(fitted[0]).size <= MAX_UPLOAD_BYTES,
  `${(statSync(fitted[0]).size / 1e6).toFixed(1)} МБ`,
);
const fittedSeconds = await samples.audioDurationSeconds(fitted[0]);
check("материал не обрезан", Math.abs(fittedSeconds - 434) < 2, `${fittedSeconds.toFixed(1)} с из 434`);

// Файлы в пределах лимита не пережимаем: это материал, из которого считается
// отпечаток голоса, и портить его лишним перекодированием незачем.
const untouched = await samples.prepareUploadFiles([a1, a2], path.join(workDir, "fit-small"));
check("маленькие файлы остались теми же", untouched[0] === a1 && untouched[1] === a2, untouched.join(","));

// Пятнадцать минут моно на 192 кбит/с — 21 МБ, пережимать уже некуда: режем.
const huge = path.join(workDir, "huge.mp3");
await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i",
  "sine=frequency=180:duration=900", "-ac", "1", "-b:a", "192k", huge, "-loglevel", "error"]);
const hugeParts = await samples.prepareUploadFiles([huge], path.join(workDir, "fit-huge"));
check("нарезано на части", hugeParts.length >= 2, `частей: ${hugeParts.length}`);
check("частей не больше, чем принимает набор сэмплов", hugeParts.length <= samples.MAX_UPLOAD_FILES);
const partSizes = hugeParts.map((f) => statSync(f).size);
check(
  "каждая часть влезает в лимит",
  partSizes.every((size) => size <= MAX_UPLOAD_BYTES),
  partSizes.map((s) => `${(s / 1e6).toFixed(1)}`).join(" + ") + " МБ",
);
let partsSeconds = 0;
for (const part of hugeParts) partsSeconds += await samples.audioDurationSeconds(part);
check("в сумме материал сохранён", Math.abs(partsSeconds - 900) < 3, `${partsSeconds.toFixed(1)} с из 900`);
// Огрызков быть не должно: сэмпл на две секунды голосу ничего не даёт.
const shortest = Math.min(...(await Promise.all(hugeParts.map((f) => samples.audioDurationSeconds(f)))));
check("части соразмерны, огрызков нет", shortest > 60, `самая короткая ${shortest.toFixed(1)} с`);

console.log("\n=== большой материал доходит до ElevenLabs ===");
const fatClone = await clone.createInstantVoiceClone({ name: "Толстый", files: [fat] });
check("клон создан на 17-мегабайтном исходнике", fatClone.voiceId === "cloned123456789012345", fatClone.voiceId);
check(
  "мок принял запрос: файл в пределах лимита",
  cloneRequest.fileSizes.every((size) => size <= MAX_UPLOAD_BYTES),
  cloneRequest.fileSizes.map((s) => (s / 1e6).toFixed(1)).join(",") + " МБ",
);

await clone.editInstantVoiceClone({ voiceId: "voice-shamil-2", name: "Шамиль2", files: [huge] });
check("15 минут ушли несколькими файлами", editRequest.fileSizes.length >= 2, `файлов: ${editRequest.fileSizes.length}`);
check(
  "каждый файл в пределах лимита",
  editRequest.fileSizes.every((size) => size <= MAX_UPLOAD_BYTES),
  editRequest.fileSizes.map((s) => (s / 1e6).toFixed(1)).join(" + ") + " МБ",
);

console.log("\n=== очистка от музыки тоже уложена в лимит ===");
// Тот же предел действует на audio-isolation, а материал на клон собирается из
// нескольких роликов и перерастает 11 МБ ещё до очистки.
const shortMp3File = path.join(workDir, "short.mp3");
await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i",
  "sine=frequency=440:duration=5", "-ac", "1", "-b:a", "192k", shortMp3File, "-loglevel", "error"]);
realMp3 = readFileSync(shortMp3File);
scenario = "isolate-real";

isolationCalls = [];
const cleanedFat = path.join(workDir, "cleaned-fat.mp3");
await clone.isolateVoice(fat, cleanedFat);
check("файл, влезающий после пережатия, чистится одним запросом", isolationCalls.length === 1, `запросов: ${isolationCalls.length}`);

isolationCalls = [];
const cleanedHuge = path.join(workDir, "cleaned-huge.mp3");
await clone.isolateVoice(huge, cleanedHuge);
check("длинная дорожка почищена по частям", isolationCalls.length === hugeParts.length, `запросов: ${isolationCalls.length}, частей: ${hugeParts.length}`);
check(
  "ни один запрос не пробил лимит",
  isolationCalls.every((size) => size <= MAX_UPLOAD_BYTES),
  isolationCalls.map((s) => (s / 1e6).toFixed(1)).join(",") + " МБ",
);
const cleanedSeconds = await samples.audioDurationSeconds(cleanedHuge);
check(
  "ответы склеены обратно в одну дорожку",
  Math.abs(cleanedSeconds - 5 * hugeParts.length) < 1.5,
  `${cleanedSeconds.toFixed(1)} с ≈ ${5 * hugeParts.length}`,
);
scenario = "ok";

server.close();
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
