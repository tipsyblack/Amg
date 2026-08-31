// Гайды по боту: слайды человека вместо придуманного сценария.
//
// Устройство обратное новостному ролику: там модель придумывает и текст, и
// картинку, здесь текст пишет человек, а картинка берётся из его скриншота.
// Отсюда и главное отличие в промпте — надписи в кадре не запрещены, а
// наоборот обязаны переноситься дословно: без названий кнопок инструкция
// перестаёт быть инструкцией.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  buildGuidePrompt,
  guideProblems,
  guideScript,
  slideCaption,
  GUIDE_STYLE_PROMPT,
  MAX_SLIDE_WORDS,
  MIN_SLIDE_WORDS,
} = await import("../src/pipeline/guide.ts");
const { NO_TEXT_RULE, STYLE_PROMPT } = await import("../src/pipeline/generateImage.ts");

console.log("=== промпт перерисовки экрана ===");
const prompt = buildGuidePrompt("Жмёшь «Собрать видео» — и бот уходит считать.");
check("стиль канала тот же", prompt.includes("flat-cartoon"));
check("сказано, что это перерисовка, а не новая картинка", /ПЕРЕРИСОВКА ЭКРАНА/.test(prompt));
check("расположение сохраняется", /РАСПОЛОЖЕНИЕ КАК В ОРИГИНАЛЕ/.test(prompt));
// Главное: в новостных роликах текст в кадре запрещён, здесь — обязателен.
check("надписи требуют переносить дословно", /ДОСЛОВНО/.test(prompt));
check("запрета надписей тут нет", !prompt.includes(NO_TEXT_RULE), "запрет из новостного промпта просочился");
check("лишнее просят убрать", /строку состояния/.test(prompt));
check("реплика слайда попала в промпт", prompt.includes("Собрать видео"));
check("пропорции карточки заданы", /3:4/.test(prompt));

const withNote = buildGuidePrompt("Реплика", "выдели кнопку внизу справа");
check("указание «что выделить» уходит отдельно", /Отдельно: выдели кнопку/.test(withNote));
check("без указания лишней строки нет", !/Отдельно:/.test(prompt));
const withStyle = buildGuidePrompt("Реплика", undefined, "в референсе тонкий контур");
check("заметки о стиле подхватываются", /тонкий контур/.test(withStyle));
check("общий стиль лежит в основе", GUIDE_STYLE_PROMPT.startsWith(STYLE_PROMPT));

console.log("\n=== проверки слайдов до трат ===");
const slide = (text) => ({ file: "/tmp/s.png", text });
check("нормальные слайды проходят", guideProblems([slide("Открываешь бота и жмёшь старт, дальше он спросит тему")]).length === 0);
check(
  "пустая реплика поймана",
  /нет реплики/.test(guideProblems([slide("   ")])[0]?.message ?? ""),
  JSON.stringify(guideProblems([slide("   ")])),
);
check(
  `короче ${MIN_SLIDE_WORDS} слов — кадр мелькнёт`,
  /мелькнёт/.test(guideProblems([slide("Жми")])[0]?.message ?? ""),
);
const longText = Array.from({ length: MAX_SLIDE_WORDS + 5 }, () => "слово").join(" ");
check(
  "слишком длинная реплика — предложено разбить",
  /Разбейте на два слайда/.test(guideProblems([slide(longText)])[0]?.message ?? ""),
);
check(
  "номер слайда назван",
  guideProblems([slide("Нормальная реплика из нескольких слов"), slide("")])[0]?.slide === 2,
);
check("пустой список ничего не ломает", guideProblems([]).length === 0);

console.log("\n=== сценарий из слайдов ===");
const script = guideScript("Как собрать первый ролик", [
  slide("Открываешь бота и жмёшь слэш нью."),
  slide("Он спрашивает тему — пишешь своими словами."),
]);
check("название стало заголовком", script.title === "Как собрать первый ролик");
check("реплики стали озвучкой слово в слово", script.scenes[0].voiceoverText === "Открываешь бота и жмёшь слэш нью.");
check("сцен столько же, сколько слайдов", script.scenes.length === 2);
// Описание кадра придумывать нечего: картинка уже есть.
check("visual не выдумывается", script.scenes[0].visual === undefined);
check(
  "подпись короткая",
  slideCaption("Открываешь бота и жмёшь слэш нью, потом ждёшь") === "Открываешь бота и жмёшь слэш нью,…",
  slideCaption("Открываешь бота и жмёшь слэш нью, потом ждёшь"),
);
check("длину подписи можно задать", slideCaption("раз два три четыре пять", 3) === "раз два три…");
check("короткий текст не обрезается", slideCaption("Жми старт") === "Жми старт");

console.log("\n=== загрузка скриншота во временное хранилище ===");
// Kie.ai принимает картинки только по ссылке, а чужие экраны с перепиской в
// публичный репозиторий класть нельзя — отсюда временное хранилище.
const { fileUrlFrom, mimeOf, MAX_UPLOAD_BYTES } = await import("../src/pipeline/kieUpload.ts");
check("mime по расширению", mimeOf("a.png") === "image/png" && mimeOf("b.JPG") === "image/jpeg");
check("незнакомое расширение — png", mimeOf("c.bin") === "image/png");
check(
  "ссылка достаётся из ответа",
  fileUrlFrom(JSON.stringify({ success: true, data: { fileUrl: "https://kieai/files/a.png" } })) ===
    "https://kieai/files/a.png",
);
// Живым ключом отсюда сходить некуда, поэтому разбор терпимый: если fileUrl
// не пришёл, берём downloadUrl, и только потом ругаемся.
check(
  "запасное поле тоже годится",
  fileUrlFrom(JSON.stringify({ data: { downloadUrl: "https://kieai/download/x" } })) ===
    "https://kieai/download/x",
);
let error = "";
try {
  fileUrlFrom(JSON.stringify({ success: false, msg: "quota exceeded", data: {} }));
} catch (e) {
  error = e.message;
}
check("без ссылки — понятный отказ", /не вернул ссылку/.test(error) && /quota exceeded/.test(error), error);
try {
  fileUrlFrom("<html>502</html>");
  error = "";
} catch (e) {
  error = e.message;
}
check("ответ не по формату тоже объяснён", /не по формату/.test(error), error);
check("предел на исходник задан", MAX_UPLOAD_BYTES >= 1024 * 1024);

console.log("\n=== команды не перехватывают друг друга ===");
// /guide рядом с /g… ничем не занят, но проверяем на настоящем grammY: на
// таких парах команды у нас уже ломались.
const { Bot } = await import("grammy");
const bot = new Bot("123:FAKE", {
  botInfo: {
    id: 123, is_bot: true, first_name: "T", username: "testbot",
    can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business_account: false,
    has_main_web_app: false,
  },
});
const hits = [];
bot.command("guide", (ctx) => hits.push(["guide", ctx.match]));
bot.command("done", (ctx) => hits.push(["done", ctx.match]));
bot.command("new", (ctx) => hits.push(["new", ctx.match]));
const cmd = (text) => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: {
    message_id: 1, date: 0, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false, first_name: "U" },
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
  },
});
await bot.handleUpdate(cmd("/guide"));
check("/guide доходит до своего обработчика", hits.at(-1)?.[0] === "guide");
await bot.handleUpdate(cmd("/done"));
check("/done не перехвачен", hits.at(-1)?.[0] === "done");

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
