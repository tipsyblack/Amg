// Проверка скачивания с Google Drive на локальном моке: прямой файл,
// страница подтверждения «не удалось проверить на вирусы» (в том числе с
// относительным адресом формы) и страница входа для закрытого файла.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const PORT = 45799;
let scenario = "direct";
let requestedPaths = [];

const server = createServer((req, res) => {
  requestedPaths.push(req.url);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/uc") {
    if (scenario === "direct") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(Buffer.from("ВИДЕО-ДАННЫЕ"));
      return;
    }
    if (scenario === "signin") {
      // Google отдаёт HTML со ссылкой на вход.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><body><form action="/v3/signin/identifier?continue=x">Sign in</form></body></html>');
      return;
    }
    if (scenario === "confirm-relative") {
      // Адрес формы относительный — именно на этом падал старый код.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        '<html><form action="/download-confirmed">' +
          '<input name="id" value="FILEID"><input name="confirm" value="t">' +
          "</form></html>",
      );
      return;
    }
    if (scenario === "confirm-absolute") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><form action="http://127.0.0.1:${PORT}/download-confirmed">` +
          '<input name="id" value="FILEID"><input name="confirm" value="t">' +
          "</form></html>",
      );
      return;
    }
    if (scenario === "html-forever") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>какая-то страница без формы</html>");
      return;
    }
  }

  if (url.pathname === "/download-confirmed") {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.end(Buffer.from("ПОДТВЕРЖДЁННОЕ-ВИДЕО"));
    return;
  }

  if (url.pathname === "/download") {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.end(Buffer.from("ВИДЕО-ЧЕРЕЗ-USERCONTENT"));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<html>404</html>");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const drive = await import("../src/bot/drive.ts");
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) =>
  realFetch(
    String(u)
      .replace("https://drive.google.com", `http://127.0.0.1:${PORT}`)
      .replace("https://drive.usercontent.google.com", `http://127.0.0.1:${PORT}`),
    init,
  );

const workDir = mkdtempSync(path.join(tmpdir(), "amg-drive-"));
const LINK = "https://drive.google.com/file/d/1r2N3sH7sXFNfMWW8fv/view?usp=drivesdk";

console.log("=== разбор ссылки ===");
check("id из /d/...", drive.extractDriveFileId(LINK) === "1r2N3sH7sXFNfMWW8fv");
check("id из ?id=...", drive.extractDriveFileId("https://x/?id=ABCDEFGHIJ12") === "ABCDEFGHIJ12");
check("мусор отвергается", drive.extractDriveFileId("https://example.com/файл") === undefined);

console.log("\n=== прямая отдача файла ===");
scenario = "direct";
const f1 = path.join(workDir, "1.mp4");
await drive.downloadDriveFile(LINK, f1);
check("файл сохранён", readFileSync(f1, "utf8") === "ВИДЕО-ДАННЫЕ");

console.log("\n=== страница подтверждения, относительный адрес формы ===");
scenario = "confirm-relative";
requestedPaths = [];
const f2 = path.join(workDir, "2.mp4");
await drive.downloadDriveFile(LINK, f2);
check("прошли подтверждение", readFileSync(f2, "utf8") === "ПОДТВЕРЖДЁННОЕ-ВИДЕО");
check("адрес разрешён относительно страницы", requestedPaths.some((p) => p.startsWith("/download-confirmed")), requestedPaths.join(" "));
check("скрытые поля формы переданы", requestedPaths.some((p) => p.includes("confirm=t")));

console.log("\n=== страница подтверждения, абсолютный адрес ===");
scenario = "confirm-absolute";
const f3 = path.join(workDir, "3.mp4");
await drive.downloadDriveFile(LINK, f3);
check("тоже работает", readFileSync(f3, "utf8") === "ПОДТВЕРЖДЁННОЕ-ВИДЕО");

console.log("\n=== закрытый файл: страница входа ===");
scenario = "signin";
try {
  await drive.downloadDriveFile(LINK, path.join(workDir, "nope.mp4"));
  check("должно было упасть", false);
} catch (e) {
  check("объяснено про доступ, а не сырой URL", e.message.includes("открыт не для всех"), e.message.split("\n")[0]);
  check("подсказан путь через настройки доступа", e.message.includes("Все, у кого есть ссылка"));
  check("предложена отправка файлом", e.message.includes("прямо в чат"));
  check("нет утечки технического мусора", !e.message.includes("Failed to parse URL"));
}

console.log("\n=== HTML без формы: уходим на резервный адрес usercontent ===");
scenario = "html-forever";
const f4 = path.join(workDir, "4.mp4");
await drive.downloadDriveFile(LINK, f4);
check(
  "файл получен через usercontent",
  readFileSync(f4, "utf8") === "ВИДЕО-ЧЕРЕЗ-USERCONTENT",
  readFileSync(f4, "utf8"),
);

console.log("\n=== ссылка без id ===");
try {
  await drive.downloadDriveFile("https://example.com/папка", path.join(workDir, "nope.mp4"));
  check("должно было упасть", false);
} catch (e) {
  check("объяснено про формат ссылки", e.message.includes("ID файла"), e.message.split("\n")[0]);
}

server.close();
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
