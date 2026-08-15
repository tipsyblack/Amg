// Публикация ролика через Zernio: форматы, расписание, разбор ошибок.
//
// Сеть подменяется целиком: проверять надо не сервис, а нас — какое тело
// запроса уходит, как понимается «18:00», что показывается человеку при
// отказе площадки. Контракт взят из openapi.yaml официального SDK, сам сервис
// из среды разработки закрыт сетевой политикой.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";
process.env.ZERNIO_API_KEY = "zk-test";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  platformOptions, trimTitle, buildPostBody, uploadVideo, createPost, getPost,
  retryPost, validatePost, parseWhen, zonedTimeToUtc, explainPostError,
  isSettled, postStateLines, publishableTargets, postErrorText,
} = await import("../src/pipeline/zernioPost.ts");
const { platformTitle } = await import("../src/pipeline/zernio.ts");

const VIDEO = { file: "/tmp/out/video-loud.mp4", title: "Почему нейросеть рисует шесть пальцев", description: "Разбираем, почему модели путают пальцы. #нейросети" };

console.log("=== форматы под площадки ===");
const yt = platformOptions("youtube", VIDEO);
check("YouTube получает заголовок", yt.title === VIDEO.title, yt.title);
check("и он не длиннее 100 символов", yt.title.length <= 100);
check("ролик помечен как синтетический", yt.containsSyntheticMedia === true);
check("COPPA выставлена явно", yt.madeForKids === false);
check("видимость задана", yt.visibility === "public");

const ig = platformOptions("instagram", VIDEO);
check("Instagram помечает ИИ-контент", ig.isAiGenerated === true);
check("Reels уходит и в ленту", ig.shareToFeed === true);
check("TikTok получает уровень приватности", platformOptions("tiktok", VIDEO).privacyLevel === "PUBLIC_TO_EVERYONE");
check("для прочих площадок настроек нет", platformOptions("telegram", VIDEO) === undefined);

console.log("\n--- длинный заголовок ---");
const long = "Нейросети научились рисовать руки с правильным числом пальцев, и вот что изменилось в свежих моделях за последний год";
const trimmed = trimTitle(long, 100);
check("обрезан до предела", trimmed.length <= 100, `${trimmed.length}`);
check("не посреди слова", !long.slice(trimmed.length, trimmed.length + 1).match(/\w/) || long[trimmed.length] === " " || trimmed.endsWith(long.slice(0, trimmed.length).trim().split(" ").at(-1)), trimmed);
check("короткий не трогаем", trimTitle("Коротко", 100) === "Коротко");
check("заголовок YouTube тоже обрезается", platformOptions("youtube", { ...VIDEO, title: long }).title.length <= 100);

console.log("\n=== тело запроса ===");
const targets = [{ platform: "instagram", accountId: "a1" }, { platform: "youtube", accountId: "a2" }];
const body = buildPostBody(VIDEO, "https://cdn/x.mp4", targets, { publishNow: true });
check("текст поста — описание", body.content === VIDEO.description);
check("видео приложено ссылкой", body.mediaItems[0].url === "https://cdn/x.mp4" && body.mediaItems[0].type === "video");
check("площадки перечислены", body.platforms.map((p) => p.platform).join(",") === "instagram,youtube");
check("у каждой свои настройки", body.platforms[1].platformSpecificData.containsSyntheticMedia === true);
check("публикуем сразу", body.publishNow === true);
const scheduled = buildPostBody(VIDEO, "u", targets, { scheduledFor: "2026-08-15T15:00:00.000Z", timezone: "Europe/Moscow" });
check("в отложенном есть время и пояс", scheduled.scheduledFor === "2026-08-15T15:00:00.000Z" && scheduled.timezone === "Europe/Moscow");
check("и нет publishNow", scheduled.publishNow === undefined);

console.log("\n=== расписание понимается по поясу канала ===");
// Сервер живёт по UTC, канал — по Москве. Без пояса «в шесть вечера» уехало бы
// на три часа, и заметили бы это только по охватам.
const now = new Date("2026-08-15T09:00:00Z"); // 12:00 МСК
const at18 = parseWhen("18:00", "Europe/Moscow", now);
check("18:00 МСК = 15:00 UTC", at18.scheduledFor === "2026-08-15T15:00:00.000Z", at18.scheduledFor);
check("пояс передаётся вместе со временем", at18.timezone === "Europe/Moscow");
const past = parseWhen("09:00", "Europe/Moscow", now);
check("прошедшее время — это завтра", past.scheduledFor === "2026-08-16T06:00:00.000Z", past.scheduledFor);
const tom = parseWhen("завтра 09:30", "Europe/Moscow", now);
check("«завтра» понимается", tom.scheduledFor === "2026-08-16T06:30:00.000Z", tom.scheduledFor);
check("точка вместо двоеточия тоже", parseWhen("18.00", "Europe/Moscow", now).scheduledFor === at18.scheduledFor);
check("25:00 отклонено", /не бывает/.test(parseWhen("25:00", "Europe/Moscow", now).error));
check("«вечером» отклонено с подсказкой", /Формат/.test(parseWhen("вечером", "Europe/Moscow", now).error));
check("пустое отклонено", typeof parseWhen("", "Europe/Moscow", now).error === "string");

// Переход на летнее время: смещение в одном и том же поясе разное.
const winter = zonedTimeToUtc({ year: 2026, month: 1, day: 1, hours: 18, minutes: 0 }, "Europe/Berlin");
const summer = zonedTimeToUtc({ year: 2026, month: 7, day: 1, hours: 18, minutes: 0 }, "Europe/Berlin");
check("зимой Берлин +1", winter.toISOString() === "2026-01-01T17:00:00.000Z", winter.toISOString());
check("летом Берлин +2 — переход учтён", summer.toISOString() === "2026-07-01T16:00:00.000Z", summer.toISOString());

console.log("\n=== заливка файла ===");
const dir = mkdtempSync(path.join(tmpdir(), "amg-pub-"));
const file = path.join(dir, "video-loud.mp4");
writeFileSync(file, Buffer.alloc(2048, 7));

let calls = [];
let presign = { uploadUrl: "https://storage/put?sig=1", publicUrl: "https://cdn/video.mp4" };
let putStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
  if (u.includes("/v1/media/presign")) return new Response(JSON.stringify(presign), { status: 200, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://storage/")) return new Response("", { status: putStatus });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const url = await uploadVideo(file);
check("вернулась публичная ссылка", url === "https://cdn/video.mp4", url);
check("presign запрошен с типом и размером", JSON.parse(calls[0].body).contentType === "video/mp4" && JSON.parse(calls[0].body).size === 2048);
check("файл ушёл PUT-ом в хранилище", calls[1].method === "PUT" && calls[1].url.startsWith("https://storage/"));
// Ключ отправлять в чужое хранилище незачем: ссылка уже подписана.
check("ключ в хранилище не уходит", !JSON.stringify(calls[1].headers).includes("zk-test"), JSON.stringify(calls[1].headers));

putStatus = 403;
let uploadFailed = false;
try { await uploadVideo(file); } catch (e) { uploadFailed = /не залился/.test(e.message); }
check("отказ хранилища объяснён", uploadFailed);
putStatus = 200;

console.log("\n=== создание поста ===");
let postReply = { post: { _id: "p1", status: "published", platforms: [
  { platform: "instagram", status: "published", platformPostUrl: "https://instagram.com/reel/1" },
  { platform: "youtube", status: "published", platformPostUrl: "https://youtu.be/2" },
] } };
calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
  return new Response(JSON.stringify(postReply), { status: 200, headers: { "content-type": "application/json" } });
};
const state = await createPost(VIDEO, "https://cdn/v.mp4", targets, { publishNow: true });
check("пост создан", state.id === "p1" && state.status === "published");
check("ссылки площадок разобраны", state.platforms[0].url === "https://instagram.com/reel/1");
// Без x-request-id повтор запроса после обрыва связи создал бы ВТОРОЙ пост.
check("уходит x-request-id для защиты от дубля", typeof calls[0].headers["x-request-id"] === "string" && calls[0].headers["x-request-id"].length > 10, String(calls[0].headers["x-request-id"]));
check("ключ уходит Bearer-заголовком", calls[0].headers.Authorization === "Bearer zk-test");

console.log("\n=== разбор ошибок площадок ===");
const failedState = {
  id: "p2", status: "partial", platforms: [
    { platform: "instagram", status: "published", url: "https://instagram.com/reel/9" },
    { platform: "youtube", status: "failed", errorCategory: "auth_expired", errorMessage: "Token revoked" },
    { platform: "tiktok", status: "failed", errorCategory: "platform_rejected", errorMessage: "Community guidelines" },
  ],
};
const lines = postStateLines(failedState, platformTitle);
check("успешная площадка со ссылкой", lines[0].includes("✅") && lines[0].includes("instagram.com/reel/9"));
check("протухший доступ ведёт к /link", /\/link/.test(lines[1]), lines[1]);
check("отказ по правилам объяснён словами", /нарушением/.test(lines[2]), lines[2]);
check("текст ошибки площадки показан", /Token revoked/.test(lines[1]));
for (const [cat, expect] of [
  ["user_abuse", /частоту/], ["platform_error", /сбой на стороне площадки/],
  ["system_error", /Zernio/], ["user_content", /формат или длина/],
  ["account_issue", /настройках аккаунта/],
]) {
  check(`${cat} объяснено`, expect.test(explainPostError({ platform: "x", status: "failed", errorCategory: cat })), explainPostError({ platform: "x", status: "failed", errorCategory: cat }));
}
check("неизвестная категория не роняет", typeof explainPostError({ platform: "x", status: "failed" }) === "string");

console.log("\n=== когда ждать, а когда всё ===");
check("всё опубликовано — ждать нечего", isSettled({ id: "p", status: "published", platforms: [{ platform: "a", status: "published" }] }) === true);
check("есть pending — ещё ждём", isSettled({ id: "p", status: "publishing", platforms: [{ platform: "a", status: "pending" }] }) === false);
check("упавшее тоже финал", isSettled({ id: "p", status: "failed", platforms: [{ platform: "a", status: "failed" }] }) === true);

console.log("\n=== куда публикуем ===");
const accounts = [
  { id: "a1", platform: "instagram", isActive: true, needsReconnection: false },
  { id: "a2", platform: "youtube", isActive: true, needsReconnection: true },
  { id: "a3", platform: "tiktok", isActive: false, needsReconnection: false },
];
const live = publishableTargets(accounts);
check("сломанные и выключенные пропущены", live.length === 1 && live[0].accountId === "a1", JSON.stringify(live));
check("пустой список аккаунтов не роняет", publishableTargets([]).length === 0);

console.log("\n=== повтор и состояние ===");
postReply = { post: { _id: "p1", status: "published", platforms: [{ platform: "youtube", status: "published", platformPostUrl: "https://youtu.be/3" }] } };
calls = [];
check("состояние читается", (await getPost("p1")).platforms[0].url === "https://youtu.be/3");
check("метод GET", calls[0].method === "GET" && calls[0].url.endsWith("/v1/posts/p1"), calls[0].url);
calls = [];
await retryPost("p1");
check("повтор — POST на /retry", calls[0].method === "POST" && calls[0].url.endsWith("/v1/posts/p1/retry"), calls[0].url);

console.log("\n=== проверка форматов до публикации ===");
postReply = { errors: [{ platform: "youtube", message: "Title too long" }], warnings: ["Близко к пределу"] };
const validation = await validatePost(buildPostBody(VIDEO, "u", targets, { publishNow: true }));
check("ошибки разобраны", validation.errors[0].message === "Title too long" && validation.errors[0].platform === "youtube");
check("строковое замечание тоже", validation.warnings[0].message === "Близко к пределу");

console.log("\n=== понятные коды ответов ===");
check("409 объяснён как защита от дубля", /двойной публикации/.test(postErrorText(409, "")));
check("и подсказано, что делать", /Поменяйте текст/.test(postErrorText(409, "")));
check("413 про размер файла", /5 ГБ/.test(postErrorText(413, "")));
check("401 ведёт к ключу", /ZERNIO_API_KEY/.test(postErrorText(401, "")));
check("ключ не попадает в текст ошибки", !postErrorText(409, "").includes("zk-test"));

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
