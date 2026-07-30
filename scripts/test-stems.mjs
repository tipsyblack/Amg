// Разделение дорожки на стемы: разбор zip своими руками (без зависимостей и без
// системного unzip) и запрос к ElevenLabs на локальном моке.
//
// Контракт запроса сверен с официальным SDK @elevenlabs/elevenlabs-js:
// POST v1/music/stem-separation, файл полем file, режим — stem_variation_id,
// формат — query-параметром output_format, ответ — zip. Живым ключом проверить
// нельзя: api.elevenlabs.io из песочницы недоступен, поэтому мок повторяет
// контракт буквально и придирается к каждому полю.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const workDir = mkdtempSync(path.join(tmpdir(), "amg-stems-test-"));
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";
process.env.ELEVENLABS_API_KEY = "el-key";

/** Собирает zip питоновским zipfile — он умеет и deflate, и хранение без сжатия. */
async function makeZip(file, entries, compress = true) {
  const spec = JSON.stringify(entries);
  await execFileAsync("python3", [
    "-c",
    [
      "import json,sys,zipfile",
      "out,spec,comp=sys.argv[1],json.loads(sys.argv[2]),sys.argv[3]=='1'",
      "mode=zipfile.ZIP_DEFLATED if comp else zipfile.ZIP_STORED",
      "z=zipfile.ZipFile(out,'w',mode)",
      "[z.writestr(k,v) for k,v in spec.items()]",
      "z.close()",
    ].join("\n"),
    file,
    spec,
    compress ? "1" : "0",
  ]);
}

const { unzip } = await import("/home/user/Amg/src/pipeline/unzip.ts");

console.log("=== разбор zip ===");
const zipDeflated = path.join(workDir, "d.zip");
// Длинная повторяющаяся строка — чтобы deflate действительно что-то сжал, иначе
// zipfile сохранит её без сжатия и ветка инфляции осталась бы непройденной.
const long = "МУЗЫКА-".repeat(500);
await makeZip(zipDeflated, { "vocals.mp3": long, "other.mp3": "МИНУС" });
const deflated = unzip(readFileSync(zipDeflated));
check("записи найдены", deflated.length === 2, `${deflated.length}`);
check(
  "имена прочитаны",
  deflated.map((e) => e.name).sort().join(",") === "other.mp3,vocals.mp3",
  deflated.map((e) => e.name).join(","),
);
check(
  "сжатое содержимое распаковано верно",
  deflated.find((e) => e.name === "vocals.mp3").data.toString("utf-8") === long,
);
check(
  "второй файл на месте",
  deflated.find((e) => e.name === "other.mp3").data.toString("utf-8") === "МИНУС",
);

const zipStored = path.join(workDir, "s.zip");
await makeZip(zipStored, { "bass.mp3": "БАС" }, false);
const stored = unzip(readFileSync(zipStored));
check(
  "архив без сжатия тоже читается",
  stored[0].data.toString("utf-8") === "БАС",
  stored[0].name,
);

const zipDirs = path.join(workDir, "dirs.zip");
await makeZip(zipDirs, { "stems/vocals.mp3": "ГОЛОС", "stems/other.mp3": "ФОН" });
check("файлы внутри папок читаются", unzip(readFileSync(zipDirs)).length === 2);

try {
  unzip(Buffer.from("это не архив"));
  check("должно было упасть на не-архиве", false);
} catch (e) {
  check("не-архив отвергнут понятно", e.message.includes("не zip"), e.message.slice(0, 40));
}

// ——— мок ElevenLabs ———
const PORT = 45813;
let request = null;
let scenario = "ok";
let responseZip = Buffer.alloc(0);

function fileFieldNames(buffer, contentType) {
  const match = /boundary=([^;]+)/.exec(contentType ?? "");
  if (!match) return { names: [], values: {} };
  const parts = buffer.toString("latin1").split(`--${match[1]}`);
  const names = [];
  const values = {};
  for (const part of parts) {
    const name = /name="([^"]+)"/.exec(part);
    if (!name) continue;
    names.push(name[1]);
    const body = part.split("\r\n\r\n")[1];
    if (body !== undefined && !/filename=/.test(part)) {
      values[name[1]] = Buffer.from(body.slice(0, body.lastIndexOf("\r\n")), "latin1").toString("utf-8");
    }
  }
  return { names, values };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/v1/music/stem-separation") {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  request = {
    method: req.method,
    key: req.headers["xi-api-key"],
    outputFormat: url.searchParams.get("output_format"),
    ...fileFieldNames(buffer, req.headers["content-type"]),
  };

  if (scenario === "no-plan") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end('{"detail":{"status":"missing_permissions"}}');
    return;
  }
  if (scenario === "too-big") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end('{"detail":{"status":"upload_file_size_exceeded"}}');
    return;
  }
  if (scenario === "empty") {
    res.writeHead(200, { "Content-Type": "application/zip" });
    res.end(readFileSync(path.join(workDir, "empty.zip")));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/zip" });
  res.end(responseZip);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) =>
  realFetch(String(u).replace("https://api.elevenlabs.io", `http://127.0.0.1:${PORT}`), init);

const clone = await import("/home/user/Amg/src/pipeline/voiceClone.ts");

// Стемы отдаём настоящими mp3: их потом мерят ffmpeg-ом, и текстовая заглушка
// прошла бы разбор архива, но развалилась бы на замере громкости.
const vocalsMp3 = path.join(workDir, "v.mp3");
const otherMp3 = path.join(workDir, "o.mp3");
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
  "sine=frequency=300:duration=2", "-ac", "1", "-b:a", "128k", vocalsMp3]);
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
  "sine=frequency=80:duration=2", "-ac", "1", "-b:a", "128k", otherMp3]);
const stemsZip = path.join(workDir, "stems.zip");
await execFileAsync("python3", [
  "-c",
  [
    "import sys,zipfile",
    "z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_STORED)",
    "z.write(sys.argv[2],'vocals.mp3')",
    "z.write(sys.argv[3],'other.mp3')",
    "z.close()",
  ].join("\n"),
  stemsZip, vocalsMp3, otherMp3,
]);
responseZip = readFileSync(stemsZip);
await makeZip(path.join(workDir, "empty.zip"), {});

console.log("\n=== запрос к ElevenLabs ===");
const outDir = path.join(workDir, "out");
const stems = await clone.separateStems({ inFile: vocalsMp3, outDir });
check("метод POST", request.method === "POST", request.method);
check("ключ передан", request.key === "el-key");
check("файл полем file", request.names.includes("file"), request.names.join(","));
check(
  "режим полем stem_variation_id",
  request.values.stem_variation_id === "two_stems_v1",
  request.values.stem_variation_id,
);
check(
  "формат ушёл query-параметром",
  request.outputFormat === "mp3_44100_192",
  String(request.outputFormat),
);
check("стемы записаны на диск", stems.length === 2, `${stems.length}`);
check(
  "имена стемов сохранены",
  stems.map((s) => s.name).sort().join(",") === "other.mp3,vocals.mp3",
  stems.map((s) => s.name).join(","),
);
check(
  "файлы стемов читаемы ffmpeg-ом",
  await (async () => {
    for (const s of stems) {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error",
        "-show_entries", "format=duration", "-of", "csv=p=0", s.file]);
      if (!(Number(stdout.trim()) > 1.5)) return false;
    }
    return true;
  })(),
);

console.log("\n=== шесть стемов ===");
const six = await clone.separateStems({
  inFile: vocalsMp3,
  outDir: path.join(workDir, "out6"),
  variation: "six_stems_v1",
});
check("режим передан", request.values.stem_variation_id === "six_stems_v1");
check("стемы вернулись", six.length === 2);

console.log("\n=== имена из архива не уводят из папки ===");
// Сервис называет файлы сам; «../» в имени не должен писать мимо папки.
const evilZip = path.join(workDir, "evil.zip");
await makeZip(evilZip, { "../evil.mp3": "НЕЛЬЗЯ" });
responseZip = readFileSync(evilZip);
const safeDir = path.join(workDir, "safe");
const safe = await clone.separateStems({ inFile: vocalsMp3, outDir: safeDir });
check(
  "путь обрезан до имени файла",
  path.dirname(path.resolve(safe[0].file)) === path.resolve(safeDir),
  safe[0].file,
);
responseZip = readFileSync(stemsZip);

console.log("\n=== понятные ошибки ===");
scenario = "no-plan";
try {
  await clone.separateStems({ inFile: vocalsMp3, outDir });
  check("должно было упасть", false);
} catch (e) {
  check("про доступ к Music объяснено", e.message.includes("не разрешает разделение"), e.message.slice(0, 60));
}
scenario = "too-big";
try {
  await clone.separateStems({ inFile: vocalsMp3, outDir });
  check("должно было упасть", false);
} catch (e) {
  check("про предел 11 МБ объяснено", e.message.includes("11 МБ"), e.message.slice(0, 60));
}
scenario = "empty";
try {
  await clone.separateStems({ inFile: vocalsMp3, outDir });
  check("должно было упасть", false);
} catch (e) {
  check("пустой архив объяснён", e.message.includes("пустой архив"), e.message.slice(0, 60));
}
scenario = "ok";

server.close();
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
