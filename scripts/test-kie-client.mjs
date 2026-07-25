// Проверка клиента Kie.ai на локальном моке: реальные запросы к api.kie.ai
// не делаются, деньги не тратятся. Запуск: node scripts/test-kie-client.mjs
import { createServer } from "node:http";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 45789;

// Сценарий мока: задача сначала "в очереди", потом "генерируется", потом
// готова — как ведёт себя настоящий асинхронный API.
const scenarios = {
  "task-ok": ["queuing", "generating", "success"],
  "task-fail": ["generating", "fail"],
  "task-empty": ["success-empty"],
};
const pollCounts = {};
const requests = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/createTask") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: parsed,
    });
    const taskId = parsed.input.__scenario ?? "task-ok";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 200, msg: "success", data: { taskId } }));
    return;
  }

  if (url.pathname === "/recordInfo") {
    const taskId = url.searchParams.get("taskId");
    const states = scenarios[taskId] ?? scenarios["task-ok"];
    const i = pollCounts[taskId] ?? 0;
    pollCounts[taskId] = i + 1;
    const state = states[Math.min(i, states.length - 1)];

    res.writeHead(200, { "Content-Type": "application/json" });
    if (state === "success") {
      res.end(
        JSON.stringify({
          code: 200,
          msg: "success",
          data: {
            state: "success",
            // Именно строка, как в документации Kie.ai.
            resultJson: JSON.stringify({
              resultUrls: [`http://127.0.0.1:${PORT}/file.bin`],
            }),
          },
        }),
      );
    } else if (state === "success-empty") {
      res.end(
        JSON.stringify({
          code: 200,
          msg: "success",
          data: { state: "success", resultJson: JSON.stringify({ resultUrls: [] }) },
        }),
      );
    } else if (state === "fail") {
      res.end(
        JSON.stringify({
          code: 200,
          msg: "success",
          data: { state: "fail", failCode: "422", failMsg: "нет кредитов" },
        }),
      );
    } else {
      res.end(
        JSON.stringify({ code: 200, msg: "success", data: { state, progress: 50 } }),
      );
    }
    return;
  }

  if (url.pathname === "/file.bin") {
    res.writeHead(200);
    res.end(Buffer.from("СОДЕРЖИМОЕ-РЕЗУЛЬТАТА"));
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

process.env.KIE_API_BASE = `http://127.0.0.1:${PORT}`;
process.env.KIE_API_KEY = "test-key";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_POLL_INTERVAL_SECONDS = "0.05";
process.env.KIE_TIMEOUT_SECONDS = "5";

const { runKieTask } = await import("../src/pipeline/kie.ts");

const workDir = await mkdtemp(path.join(tmpdir(), "kie-test-"));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("\n1) успешная задача с опросом статуса");
const outFile = path.join(workDir, "result.bin");
const resultUrl = await runKieTask({
  model: "elevenlabs/text-to-speech-multilingual-v2",
  input: { text: "привет", voice: "Rachel" },
  outFile,
  label: "тест",
});
check("файл скачан", (await readFile(outFile, "utf8")) === "СОДЕРЖИМОЕ-РЕЗУЛЬТАТА");
check("вернулась ссылка на результат", resultUrl === `http://127.0.0.1:${PORT}/file.bin`);
check(
  "дождался success через промежуточные статусы",
  pollCounts["task-ok"] === 3,
  `опросов: ${pollCounts["task-ok"]}`,
);

console.log("\n2) формат запроса createTask");
const first = requests[0];
check("Bearer-токен передан", first.auth === "Bearer test-key");
check("Content-Type json", first.contentType === "application/json");
check("model на верхнем уровне", first.body.model === "elevenlabs/text-to-speech-multilingual-v2");
check("input вложен", first.body.input?.text === "привет");

console.log("\n3) задача завершилась ошибкой");
try {
  await runKieTask({
    model: "m",
    input: { __scenario: "task-fail" },
    outFile: path.join(workDir, "nope.bin"),
    label: "тест-ошибка",
  });
  check("должно было упасть", false);
} catch (error) {
  check("сообщение содержит причину от сервиса", error.message.includes("нет кредитов"), error.message);
}

console.log("\n4) success без результата");
try {
  await runKieTask({
    model: "m",
    input: { __scenario: "task-empty" },
    outFile: path.join(workDir, "nope2.bin"),
    label: "тест-пусто",
  });
  check("должно было упасть", false);
} catch (error) {
  check("понятная ошибка про пустой resultUrls", error.message.includes("без результата"), error.message);
}

console.log("\n5) таймаут ожидания");
scenarios["task-hang"] = ["generating"];
const started = Date.now();
try {
  await runKieTask({
    model: "m",
    input: { __scenario: "task-hang" },
    outFile: path.join(workDir, "nope3.bin"),
    label: "тест-таймаут",
  });
  check("должно было упасть", false);
} catch (error) {
  check("сообщение про таймаут", error.message.includes("не ответил за"), error.message);
  check("уложился примерно в лимит", Date.now() - started < 8000, `${Date.now() - started} мс`);
}

await rm(workDir, { recursive: true, force: true });
server.close();

console.log(failures === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено проверок: ${failures}\n`);
process.exit(failures === 0 ? 0 : 1);
