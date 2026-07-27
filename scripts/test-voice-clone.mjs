// Проверка клонирования голоса: извлечение и склейка дорожек делаются
// настоящим ffmpeg, вызовы ElevenLabs — на локальном моке.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
let scenario = "ok";
// Состав голоса меняется после успешного edit — по нему бот и проверяет, что
// материал действительно добавился.
let voiceSamples = [
  { sample_id: "s1", file_name: "old-1.mp3", duration_secs: 40 },
  { sample_id: "s2", file_name: "old-2.mp3", duration_secs: 44 },
];

// Читаем multipart грубо, но достаточно, чтобы проверить состав полей.
// latin1 — чтобы искать имена полей и не портить двоичные части; utf8 нужен
// отдельно, иначе кириллица внутри полей превращается в мусор.
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  return { latin1: buffer.toString("latin1"), utf8: buffer.toString("utf8") };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/v1/audio-isolation") {
    isolationRequest = { key: req.headers["xi-api-key"], ...(await readBody(req)) };
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from("ОЧИЩЕННОЕ-АУДИО"));
    return;
  }

  if (url.pathname === "/v1/voices/add") {
    cloneRequest = { key: req.headers["xi-api-key"], ...(await readBody(req)) };
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

server.close();
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
