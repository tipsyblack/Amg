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
let scenario = "ok";

// Читаем multipart грубо, но достаточно, чтобы проверить состав полей.
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("latin1");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/v1/audio-isolation") {
    isolationRequest = { key: req.headers["xi-api-key"], body: await readBody(req) };
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from("ОЧИЩЕННОЕ-АУДИО"));
    return;
  }

  if (url.pathname === "/v1/voices/add") {
    cloneRequest = { key: req.headers["xi-api-key"], body: await readBody(req) };
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
check("файл отправлен полем audio", /name="audio"/.test(isolationRequest.body), "поля: " + (isolationRequest.body.match(/name="[^"]+"/g) || []).join(","));

console.log("\n=== создание клона ===");
const { voiceId } = await clone.createInstantVoiceClone({ name: "Шамиль", files: [cleaned] });
check("voice_id вернулся", voiceId === "cloned123456789012345", voiceId);
check("имя передано", /name="name"/.test(cloneRequest.body));
check("файлы переданы полем files", /name="files"/.test(cloneRequest.body));
check("шумоподавление включено", /name="remove_background_noise"[\s\S]{0,40}true/.test(cloneRequest.body));

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

server.close();
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
