// Правка .env из чата: разбор команды, запись без потери файла, маскировка.
//
// Проверяется на настоящем файле во временной папке — запись в .env это ровно
// то место, где ошибка стоит дорого: снесённый файл означает бота без ключей
// и поездку по ssh, ради отказа от которой всё и делалось.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const dir = mkdtempSync(path.join(tmpdir(), "amg-env-"));
process.chdir(dir);

const { parseSetKey, maskSecret, setEnvValue, getEnvValue, EDITABLE_KEYS, isEditableKey } =
  await import("/home/user/Amg/src/bot/envFile.ts");

console.log("=== разбор команды ===");
const ok = parseSetKey("ZERNIO_API_KEY zk_abc123");
check("имя и значение разобраны", ok.name === "ZERNIO_API_KEY" && ok.value === "zk_abc123", JSON.stringify(ok));
check("имя приводится к верхнему регистру", parseSetKey("zernio_api_key v").name === "ZERNIO_API_KEY");
check(
  "кавычки из буфера снимаются",
  parseSetKey('ZERNIO_API_KEY "zk_abc"').value === "zk_abc",
);
check(
  "пробелы по краям убираются",
  parseSetKey("ZERNIO_API_KEY    zk_abc   ").value === "zk_abc",
);
check("пустая команда объясняет формат", /Формат/.test(parseSetKey("").error));
check("имя без значения — ошибка", /Не вижу значения/.test(parseSetKey("ZERNIO_API_KEY").error));
check("undefined не роняет", typeof parseSetKey(undefined).error === "string");

console.log("\n=== что менять нельзя ===");
// Без белого списка команда стала бы способом переписать в .env что угодно.
check(
  "токен бота из чата не поменять",
  /менять из чата нельзя/.test(parseSetKey("TELEGRAM_BOT_TOKEN 123:abc").error),
);
check("и chat id тоже", /менять из чата нельзя/.test(parseSetKey("TELEGRAM_ALLOWED_CHAT_ID 1").error));
check("и произвольную переменную", /менять из чата нельзя/.test(parseSetKey("PATH /evil").error));
check("в ошибке перечислено, что можно", /ZERNIO_API_KEY/.test(parseSetKey("PATH /evil").error));
check("ключи Zernio разрешены", isEditableKey("ZERNIO_API_KEY") && isEditableKey("ZERNIO_PROFILE_ID"));
check("токена бота нет в списке", !EDITABLE_KEYS.includes("TELEGRAM_BOT_TOKEN"));

console.log("\n=== маскировка ===");
check("показан только хвост", maskSecret("zk_verysecret1234") === "…1234 (17 знаков)", maskSecret("zk_verysecret1234"));
check("сам ключ не виден", !maskSecret("zk_verysecret1234").includes("verysecret"));
check("пустое значение названо явно", maskSecret("") === "не задан");
check("короткое значение не раскрывается", !maskSecret("ab").includes("ab"), maskSecret("ab"));

console.log("\n=== запись в файл ===");
writeFileSync(
  path.join(dir, ".env"),
  "# Комментарий\nOPENROUTER_API_KEY=or_old\nKIE_API_KEY=kie_1\n\n# Ещё блок\nVIDEO_WIDTH=1080\n",
);
setEnvValue("OPENROUTER_API_KEY", "or_new");
let text = readFileSync(path.join(dir, ".env"), "utf-8");
check("значение заменено", /OPENROUTER_API_KEY=or_new/.test(text));
check("старого значения не осталось", !text.includes("or_old"));
check("другие ключи целы", /KIE_API_KEY=kie_1/.test(text) && /VIDEO_WIDTH=1080/.test(text));
check("комментарии целы", /# Комментарий/.test(text) && /# Ещё блок/.test(text));

setEnvValue("ZERNIO_API_KEY", "zk_new");
text = readFileSync(path.join(dir, ".env"), "utf-8");
check("новая переменная дописана", /ZERNIO_API_KEY=zk_new/.test(text));
check("и не склеилась с предыдущей строкой", !/1080ZERNIO/.test(text), text.split("\n").slice(-4).join("|"));
check("прочитать обратно можно", getEnvValue("ZERNIO_API_KEY") === "zk_new");
check("несуществующая переменная — пусто", getEnvValue("НЕТ_ТАКОЙ") === "");

console.log("\n=== права на файл ===");
const mode = statSync(path.join(dir, ".env")).mode & 0o777;
check("только владельцу (600)", mode === 0o600, "0" + mode.toString(8));

console.log("\n=== файла ещё нет ===");
rmSync(path.join(dir, ".env"));
setEnvValue("KIE_API_KEY", "kie_fresh");
check("файл создан", getEnvValue("KIE_API_KEY") === "kie_fresh");
check("и сразу с правами 600", (statSync(path.join(dir, ".env")).mode & 0o777) === 0o600);

console.log("\n=== файл без перевода строки в конце ===");
writeFileSync(path.join(dir, ".env"), "KIE_API_KEY=kie_1");
setEnvValue("ZERNIO_PROFILE_ID", "p1");
check(
  "переменные не слиплись",
  getEnvValue("KIE_API_KEY") === "kie_1" && getEnvValue("ZERNIO_PROFILE_ID") === "p1",
  readFileSync(path.join(dir, ".env"), "utf-8").replace(/\n/g, "|"),
);

console.log("\n=== export и пробелы в исходном файле ===");
writeFileSync(path.join(dir, ".env"), "export ZERNIO_API_KEY=old\n  KIE_API_KEY = kie_2\n");
setEnvValue("ZERNIO_API_KEY", "new");
text = readFileSync(path.join(dir, ".env"), "utf-8");
check("строка с export заменена, а не продублирована", (text.match(/ZERNIO_API_KEY/g) ?? []).length === 1, text.replace(/\n/g, "|"));
check("значение новое", getEnvValue("ZERNIO_API_KEY") === "new");

process.chdir("/home/user/Amg");
rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
