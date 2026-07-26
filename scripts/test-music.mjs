// Проверка генерации музыки (Suno через Kie.ai) на локальном моке и работы
// библиотеки треков. Реальные запросы не уходят, кредиты не тратятся.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const PORT = 45795;
let scenario = "ok";
let pollCount = 0;
let createBody = null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/api/v1/generate") {
    let body = "";
    for await (const chunk of req) body += chunk;
    createBody = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 200, msg: "success", data: { taskId: "t1" } }));
    return;
  }

  if (url.pathname === "/api/v1/generate/record-info") {
    pollCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (scenario === "fail") {
      res.end(JSON.stringify({ code: 200, data: { status: "CREATE_TASK_FAILED", errorMessage: "нет кредитов" } }));
      return;
    }
    if (scenario === "hang") {
      res.end(JSON.stringify({ code: 200, data: { status: "PENDING" } }));
      return;
    }
    // Первый опрос — ещё не готово, второй — готово.
    if (pollCount < 2) {
      res.end(JSON.stringify({ code: 200, data: { status: "PROCESSING" } }));
      return;
    }
    res.end(
      JSON.stringify({
        code: 200,
        data: {
          status: "SUCCESS",
          response: {
            sunoData: [
              { audioUrl: `http://127.0.0.1:${PORT}/track.mp3`, title: "Тестовый трек", duration: 42 },
            ],
          },
        },
      }),
    );
    return;
  }

  if (url.pathname === "/track.mp3") {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from("MP3-ТРЕК"));
    return;
  }

  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const workDir = mkdtempSync(path.join(tmpdir(), "amg-music-"));
mkdirSync(path.join(workDir, "assets/music"), { recursive: true });
process.chdir(workDir);

process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "kie-key";
process.env.KIE_POLL_INTERVAL_SECONDS = "0.05";
process.env.KIE_MUSIC_TIMEOUT_SECONDS = "1";

const music = await import("/home/user/Amg/src/pipeline/generateMusic.ts");
const assets = await import("/home/user/Amg/src/pipeline/assets.ts");

const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) =>
  realFetch(String(u).replace("https://api.kie.ai", `http://127.0.0.1:${PORT}`), init);

console.log("=== пресеты ===");
check("пресетов 5-7", music.MUSIC_PRESETS.length >= 5 && music.MUSIC_PRESETS.length <= 7, String(music.MUSIC_PRESETS.length));
check("все без вокала", music.MUSIC_PRESETS.every((p) => /no vocals/i.test(p.prompt)));
check("ключи уникальны", new Set(music.MUSIC_PRESETS.map((p) => p.key)).size === music.MUSIC_PRESETS.length);

console.log("\n=== генерация трека ===");
const out = path.join(workDir, "assets/music/test.mp3");
const info = await music.generateMusicTrack(music.MUSIC_PRESETS[0].prompt, out);
check("файл скачан", readFileSync(out, "utf8") === "MP3-ТРЕК");
check("название вернулось", info.title === "Тестовый трек", String(info.title));
check("длительность вернулась", info.durationSeconds === 42);
check("дождался готовности через опрос", pollCount >= 2, `опросов: ${pollCount}`);

console.log("\n=== формат запроса ===");
check("instrumental=true (фон без вокала)", createBody.instrumental === true);
check("customMode=false (простой режим)", createBody.customMode === false);
check("промпт передан", createBody.prompt.includes("Upbeat"));
check("модель передана", typeof createBody.model === "string" && createBody.model.length > 0, createBody.model);

console.log("\n=== ошибки ===");
scenario = "fail";
pollCount = 0;
try {
  await music.generateMusicTrack("p", path.join(workDir, "nope.mp3"));
  check("должно было упасть", false);
} catch (e) {
  check("причина от сервиса в ошибке", e.message.includes("нет кредитов"), e.message.slice(0, 70));
}

scenario = "hang";
pollCount = 0;
const started = Date.now();
try {
  await music.generateMusicTrack("p", path.join(workDir, "nope2.mp3"));
  check("должно было упасть", false);
} catch (e) {
  check("таймаут сработал", e.message.includes("не готова"), e.message.slice(0, 60));
  check("уложился в лимит", Date.now() - started < 4000, `${Date.now() - started} мс`);
}

console.log("\n=== библиотека треков ===");
scenario = "ok";
writeFileSync(path.join(workDir, "assets/music/a.mp3"), "a");
writeFileSync(path.join(workDir, "assets/music/b.wav"), "b");
writeFileSync(path.join(workDir, "assets/music/README.md"), "не трек");
const list = await assets.listMusicTracks();
check("считаны только аудиофайлы", list.length === 3 && !list.includes("README.md"), list.join(", "));
check("удаление работает", (await assets.deleteMusicTrack("a.mp3")) === true);
check("после удаления на один меньше", (await assets.listMusicTracks()).length === 2);
check("удаление несуществующего не падает", (await assets.deleteMusicTrack("нет.mp3")) === false);
// Имя приходит из чата — важно, чтобы нельзя было удалить файл вне библиотеки.
writeFileSync(path.join(workDir, "секрет.txt"), "важное");
await assets.deleteMusicTrack("../секрет.txt");
check("выход из папки библиотеки невозможен", readFileSync(path.join(workDir, "секрет.txt"), "utf8") === "важное");

server.close();
process.chdir(tmpdir());
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
