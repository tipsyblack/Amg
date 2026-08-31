// Проверка текста описания под пост: требования к длине и содержанию,
// повторная попытка при проблеме, запасной вариант из сценария и обложка для
// файла. OpenRouter подменяется заглушкой — сеть не нужна.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  generateDescription,
  descriptionProblem,
  fallbackDescription,
  DESCRIPTION_MIN_CHARS,
  DESCRIPTION_MAX_CHARS,
} = await import("../src/pipeline/generateDescription.ts");

const script = {
  title: "Дата-центры в космосе",
  scenes: [
    { caption: "ДАТА-ЦЕНТРЫ В КОСМОСЕ", voiceoverText: "Илон Маск строит дата-центры для своего ИИ в космосе." },
    { caption: "ПАЛКА О ДВУХ КОНЦАХ", voiceoverText: "На Земле выходит палка о двух концах: либо дорогая земля, либо дорогая вода." },
    { caption: "МИНУС 270", voiceoverText: "В вакууме тепло уносить нечем, поэтому нужен радиатор размером с полспутника." },
    { caption: "ЖМИ ССЫЛКУ", voiceoverText: "Ещё больше такого про ИИ — в профиле, подпишись." },
  ],
};

const good =
  "🛰 Дата-центры для ИИ теперь строят на орбите — зачем?\n\n" +
  "💡 На Земле упираются в дорогую землю и дорогую воду для охлаждения. " +
  "В космосе воды нет вообще, зато вакуум не уносит тепло — поэтому серверам " +
  "нужен радиатор размером с полспутника, который сбрасывает тепло излучением.\n\n" +
  "☀️ Энергии там хоть отбавляй: солнце светит всегда, атмосфера его не ослабляет.\n\n" +
  "👉 Ещё больше разборов про ИИ — в профиле, подпишись!\n\n" +
  "#нейросети #ии #космос #технологии #маск";

console.log("=== требования к описанию ===");
check("нормальное описание проходит", descriptionProblem(good) === undefined, String(descriptionProblem(good)));
check("длина в рабочем диапазоне", good.length >= DESCRIPTION_MIN_CHARS && good.length <= DESCRIPTION_MAX_CHARS, `${good.length} символов`);
check("короткое отклонено", descriptionProblem("🔥 Коротко и всё #ии")?.includes("короткое") === true);
check(
  "длинное отклонено",
  descriptionProblem(`🔥 ${"очень длинное описание ".repeat(40)} #ии`)?.includes("длинное") === true,
);
check("без эмодзи отклонено", descriptionProblem(good.replace(/[🛰💡☀️👉]/gu, ""))?.includes("эмодзи") === true);
check("без хештегов отклонено", descriptionProblem(good.replace(/#\S+/g, "тег"))?.includes("хештег") === true);
check(
  "ссылка отклонена",
  descriptionProblem(good.replace("в профиле", "на https://example.com"))?.includes("ссылка") === true,
);
check(
  "markdown отклонён",
  descriptionProblem(good.replace("Дата-центры", "**Дата-центры**"))?.includes("markdown") === true,
);

console.log("\n=== запасной вариант из сценария ===");
const fb = fallbackDescription(script);
check("что-то содержательное получилось", fb.length > 80, `${fb.length} символов`);
check("не длиннее лимита", fb.length <= DESCRIPTION_MAX_CHARS, String(fb.length));
check("есть эмодзи и хештеги", /[🔥💡👉]/u.test(fb) && fb.includes("#"));
check("взята первая реплика", fb.includes("Илон Маск строит"));
check("взят призыв из финала", fb.includes("подпишись"));
// Очень длинный сценарий не должен рвать слово посередине.
const longScript = {
  title: "т",
  scenes: [
    { caption: "к", voiceoverText: "начало ".repeat(80) },
    { caption: "к", voiceoverText: "середина ".repeat(80) },
    { caption: "к", voiceoverText: "финал" },
  ],
};
const cut = fallbackDescription(longScript);
check("длинный сценарий обрезан", cut.length <= DESCRIPTION_MAX_CHARS, `${cut.length} символов`);
check("хештеги сохранены при обрезке", cut.trimEnd().endsWith("#автоматизация"), cut.slice(-40));
check("тело обрезано по границе слова", /\S…/u.test(cut) && !/\s…/u.test(cut), cut.slice(0, 80));

console.log("\n=== предел 500 символов гарантирован на выходе ===");
// Это и есть правило: 500 — не пожелание модели, а то, что уходит в чат.
// Промпт может быть проигнорирован дважды, сеть может отвалиться — предел
// держится всё равно.
const { enforceLimit, targetLength } = await import("../src/pipeline/generateDescription.ts");
check("предел равен 500", DESCRIPTION_MAX_CHARS === 500, String(DESCRIPTION_MAX_CHARS));
check("короткий текст не трогаем", enforceLimit(good) === good);
const tags = "#нейросети #ии #космос";
const huge = `🔥 ${"слово ".repeat(300)}\n\n${tags}`;
const limited = enforceLimit(huge);
check("длинный текст урезан до предела", limited.length <= DESCRIPTION_MAX_CHARS, `${limited.length} символов`);
check("хештеги на месте", limited.endsWith(tags), limited.slice(-30));
check("обрыв помечен многоточием", limited.includes("…"));
// Источник — «слово » много раз, поэтому обрыв по границе слова обязан дать
// целое «слово…», а не «сло…».
check("слово не разорвано", limited.includes("слово…"), limited.slice(-60));
// Текст без хештегов — резать нечего, кроме самого текста.
const noTags = enforceLimit(`🔥 ${"слово ".repeat(300)}`);
check("без хештегов тоже в пределе", noTags.length <= DESCRIPTION_MAX_CHARS, `${noTags.length} символов`);
// Патологический случай: хештеги сами длиннее предела. Строка из одних решёток
// бесполезна, поэтому режем всё подряд.
const tagWall = enforceLimit(`🔥 текст\n\n${"#длинныйхештег ".repeat(60)}`);
check("стена хештегов тоже в пределе", tagWall.length <= DESCRIPTION_MAX_CHARS, `${tagWall.length} символов`);
check("осмысленное начало сохранено", tagWall.startsWith("🔥 текст"), tagWall.slice(0, 30));

console.log("\n=== цель для промпта ниже предела ===");
check("цель не равна пределу", targetLength(500) < DESCRIPTION_MAX_CHARS, String(targetLength(500)));
check("слишком большое значение из .env прижато", targetLength(5000) < DESCRIPTION_MAX_CHARS);
check("слишком маленькое поднято до минимума", targetLength(10) >= DESCRIPTION_MIN_CHARS, String(targetLength(10)));
check("рабочее значение проходит", targetLength(450) === 450);

console.log("\n=== генерация с подменой OpenRouter ===");
let requests = [];
const queue = [];
globalThis.fetch = async (url, init) => {
  requests.push(JSON.parse(init.body));
  const next = queue.shift();
  if (next === "error") return new Response("boom", { status: 500 });
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ description: next }) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

queue.push(good);
requests = [];
const first = await generateDescription(script);
check("описание отдано как есть", first.description === good);
check("правок не потребовалось", first.fixed === undefined);
check("один запрос", requests.length === 1, String(requests.length));
check("в запрос ушёл сценарий целиком", requests[0].messages[1].content.includes("радиатор"));
const prompt = requests[0].messages[0].content;
check("в промпте названа цель", prompt.includes("450"));
check("в промпте назван жёсткий предел", prompt.includes("не больше 500"));
check("требуются эмодзи", prompt.includes("Эмодзи обязательны"));
check("требуются хештеги", prompt.includes("хештег"));
check("ссылки запрещены", prompt.includes("Никаких ссылок"));
check("markdown запрещён", prompt.includes("Без markdown"));

// Слишком короткий ответ должен вызвать одну переписку.
queue.length = 0;
queue.push("🔥 Мало текста #ии", good);
requests = [];
const fixed = await generateDescription(script);
check("после правки описание нормальное", fixed.description === good);
check("причина названа", fixed.fixed?.includes("короткое") === true, String(fixed.fixed));
check("сделано два запроса", requests.length === 2, String(requests.length));
check(
  "в правку ушла причина",
  requests[1].messages.at(-1).content.includes("Перепиши описание"),
  requests[1].messages.at(-1).content.slice(0, 60),
);

// Модель проигнорировала предел дважды — обрезка обязана сработать, и бот
// должен об этом сказать (флаг trimmed).
queue.length = 0;
const tooLong = `🔥 ${"длинное описание ".repeat(60)}\n\n#ии #нейросети`;
queue.push(tooLong, tooLong);
requests = [];
const over = await generateDescription(script);
check("в чат уходит не больше предела", over.description.length <= DESCRIPTION_MAX_CHARS, `${over.description.length} символов`);
check("обрезка отмечена флагом", over.trimmed === true);
check("причина переписки названа", over.fixed?.includes("длинное") === true, String(over.fixed));
check("хештеги выжили", over.description.endsWith("#ии #нейросети"), over.description.slice(-20));

// Модель недоступна — берём запасной вариант, а не падаем.
queue.length = 0;
queue.push("error");
requests = [];
const failed = await generateDescription(script);
check("при ошибке есть описание", failed.description.length > 80);
check("помечено как запасное", failed.fromFallback === true);

// Абзацы описания не должны склеиться в одну строку: именно этим ломался
// первый вариант — общая чистка ссылок схлопывала переводы строк.
queue.length = 0;
queue.push(good);
requests = [];
const paragraphs = await generateDescription(script);
check(
  "абзацы сохранены",
  paragraphs.description.split("\n\n").length >= 4,
  `абзацев: ${paragraphs.description.split("\n\n").length}`,
);

// Ссылки-сноски веб-поиска не должны попасть в описание.
queue.length = 0;
queue.push(`${good}\n[mashagpt.ru](https://mashagpt.ru/blog/x)`);
requests = [];
const cited = await generateDescription(script);
check("сноска вычищена", !cited.description.includes("mashagpt"), cited.description.slice(-40));

console.log("\n=== обложка для файла ===");
const { makeThumbnail } = await import("../src/bot/videoSize.ts");
const dir = mkdtempSync(path.join(tmpdir(), "amg-thumb-"));
const video = path.join(dir, "v.mp4");
execFileSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x3fa0c0:s=1080x1920:d=2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", video,
]);
const thumb = path.join(dir, "t.jpg");
await makeThumbnail(video, thumb);
// Читаем по именам полей: в csv ffprobe печатает их в своём порядке, и разбор
// по позиции даёт кодек вместо ширины.
const probe = execFileSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height,codec_name",
  "-of", "default=noprint_wrappers=1", thumb,
]).toString();
const field = (name) => probe.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1] ?? "";
const w = field("width"), h = field("height"), codec = field("codec_name");
const size = `${codec} ${w}x${h}`;
check("обложка — jpeg", codec.includes("jpeg") || codec.includes("mjpeg"), codec);
check("высота 320 px, как требует Telegram", Number(h) === 320, size);
check("пропорции вертикальные сохранены", Number(w) < Number(h), size);
check("вес меньше 200 КБ", statSync(thumb).size < 200 * 1024, `${(statSync(thumb).size / 1024).toFixed(0)} КБ`);
rmSync(dir, { recursive: true, force: true });

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
