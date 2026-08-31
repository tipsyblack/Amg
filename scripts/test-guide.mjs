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

console.log("\n=== покадровый план на тему ===");
const {
  buildPlanPrompt,
  parsePlan,
  formatPlan,
  planWarnings,
  parsePlanArgs,
  DEFAULT_PLAN_SLIDES,
  MAX_PLAN_SLIDES,
} = await import("../src/pipeline/guidePlan.ts");

const planPrompt = buildPlanPrompt("как поменять голос в боте", 5, "бот для нейросетей");
check("тема в промпте", planPrompt.includes("как поменять голос в боте"));
check("число кадров названо", /Кадров: 5/.test(planPrompt));
check("контекст продукта уходит", /бот для нейросетей/.test(planPrompt));
// Модель не видела интерфейс и с удовольствием придумает кнопку. В гайде
// выдуманная кнопка хуже, чем никакой гайд: зритель пойдёт её искать.
check("выдумывать кнопки запрещено", /НЕ ВЫДУМЫВАЙ НАЗВАНИЯ КНОПОК/.test(planPrompt));
check("первый кадр — зачем смотреть", /ПЕРВЫЙ КАДР/.test(planPrompt));
check("последний — что сделать", /ПОСЛЕДНИЙ КАДР/.test(planPrompt));
check("рамки реплики те же, что у слайда", planPrompt.includes(`${MIN_SLIDE_WORDS}-${MAX_SLIDE_WORDS} слов`));
check("говор Шамиля учтён и здесь", /ГОВОР ШАМИЛЯ/.test(planPrompt));
check("без контекста лишней строки нет", !/Что это за продукт/.test(buildPlanPrompt("тема", 4)));

const raw = JSON.stringify({
  slides: [
    { screen: "главный экран бота", line: "Открываешь бота и видишь одну кнопку — жми её." },
    { screen: "список голосов", line: "Тут выбираешь голос, каждый можно послушать заранее." },
  ],
});
const plan = parsePlan(raw);
check("план разобран", plan.length === 2 && plan[0].screen === "главный экран бота");
check("ответ в ограде тоже разбирается", parsePlan("```json\n" + raw + "\n```").length === 2);
check("кадры без реплики выброшены", parsePlan(JSON.stringify({ slides: [{ screen: "экран" }, plan[0]] })).length === 1);
let planError = "";
try {
  parsePlan(JSON.stringify({ slides: [] }));
} catch (e) {
  planError = e.message;
}
check("пустой план объяснён", /переформулировать тему/.test(planError), planError);
try {
  parsePlan("это не json");
  planError = "";
} catch (e) {
  planError = e.message;
}
check("мусор вместо json объяснён", /Не разобрал ответ модели/.test(planError), planError);

const shown = formatPlan(plan);
check("в плане видно, что снять", shown.includes("📸 главный экран бота"));
check("и что сказать", shown.includes("🎙 Открываешь бота"));
check("кадры пронумерованы", shown.startsWith("1. "));

// Реплика плана и есть будущая реплика слайда, поэтому мерило то же.
check("длинная реплика помечена", planWarnings([{ screen: "э", line: Array.from({ length: MAX_SLIDE_WORDS + 3 }, () => "слово").join(" ") }]).some((w) => /длинная/.test(w)));
check("короткая тоже", planWarnings([{ screen: "э", line: "Жми" }]).some((w) => /короткая/.test(w)));
check("кадр без экрана помечен", planWarnings([{ screen: "", line: "Нормальная реплика из слов" }]).some((w) => /не сказано, что снять/.test(w)));
check("к нормальному плану претензий нет", planWarnings(plan).length === 0, planWarnings(plan).join(" | "));

console.log("\n=== разбор аргумента /plan ===");
check("просто тема", parsePlanArgs("как поменять голос").count === DEFAULT_PLAN_SLIDES);
check("тема сохранена", parsePlanArgs("как поменять голос").topic === "как поменять голос");
check("число впереди — это кадры", parsePlanArgs("5 как поменять голос").count === 5);
check("и тема без числа", parsePlanArgs("5 как поменять голос").topic === "как поменять голос");
check("пустой аргумент — подсказка с примером", /error/.test(Object.keys(parsePlanArgs("  ")).join()));
check("слишком много кадров отклонено", "error" in parsePlanArgs(`${MAX_PLAN_SLIDES + 5} тема`));
check("один кадр — тоже отказ", "error" in parsePlanArgs("1 тема"));
// «2024 год нейросетей» — это тема, а не просьба о 2024 кадрах.
check("длинное число не считается кадрами", parsePlanArgs("2024 год нейросетей").count === DEFAULT_PLAN_SLIDES, JSON.stringify(parsePlanArgs("2024 год нейросетей")));

console.log("\n=== подсказка «нажми сюда» ===");
const { tapTimes, tapProgress, tapKindFor, tapZone, TAP_KINDS, TAP_CYCLE_SECONDS, TAP_HIT_SECONDS } =
  await import("../src/remotion/tap.ts");
const { parseTapTag, defaultTap } = await import("../src/pipeline/guide.ts");

const fps = 60;
// Короткая реплика: один круг.
check("на короткой сцене одно нажатие", tapTimes(Math.round(2.6 * fps), fps).length === 1, String(tapTimes(Math.round(2.6 * fps), fps).length));
// «Если в сцене много слов, оживлённая сцена крутится по кругу».
const long = tapTimes(Math.round(9 * fps), fps);
check("на длинной — несколько кругов", long.length >= 3, `${long.length} нажатий на 9 с`);
check(
  "круги идут ровно через цикл",
  long.every((at, i) => i === 0 || at - long[i - 1] === Math.round(TAP_CYCLE_SECONDS * fps)),
  long.join(", "),
);
// Оборванный на середине круг выглядит как заевшая анимация.
check(
  "последний круг помещается целиком",
  long.at(-1) + Math.round((TAP_CYCLE_SECONDS - TAP_HIT_SECONDS) * fps) <= Math.round(9 * fps),
);
check("первое нажатие не в самом начале — карточка ещё влетает", long[0] >= Math.round(1.5 * fps), String(long[0]));
// Совсем короткий кадр всё равно должен получить подсказку.
check("очень короткая сцена не остаётся без подсказки", tapTimes(Math.round(1.2 * fps), fps).length === 1);
check("нулевая длительность ничего не ломает", tapTimes(0, fps).length === 0);

const at = long[1];
check("в момент нажатия подсказка на экране", tapProgress(at, Math.round(9 * fps), fps).active);
// Круги идут вплотную: это и есть «крутится по кругу». Дыхание между ними
// даёт не пауза, а затухание в конце цикла (см. Tap.tsx).
check(
  "круги идут подряд, без дыр",
  tapProgress(long[0] + Math.round((TAP_CYCLE_SECONDS - 0.1) * fps), Math.round(9 * fps), fps).active,
);
check(
  "новый круг начинается с начала",
  tapProgress(long[1] - Math.round(TAP_HIT_SECONDS * fps), Math.round(9 * fps), fps).sinceStart === 0,
);
// А после последнего круга подсказки нет: хвост сцены остаётся чистым.
check(
  "после последнего круга подсказки нет",
  !tapProgress(Math.round(9 * fps) - 1, Math.round(9 * fps), fps).active,
);
check("до первого круга её тоже нет", !tapProgress(0, Math.round(9 * fps), fps).active);

console.log("\n=== виды подсказки чередуются ===");
const kinds = Array.from({ length: TAP_KINDS.length + 2 }, (_, i) => tapKindFor(i));
check("соседние слайды получают разные виды", kinds.every((k, i) => i === 0 || k !== kinds[i - 1]), kinds.join(", "));
check("за пять слайдов используются все", new Set(kinds.slice(0, TAP_KINDS.length)).size === TAP_KINDS.length);
check("выбранный вид перебивает чередование", tapKindFor(3, "ring") === "ring");

console.log("\n=== пометка о нажатии в реплике ===");
// Пометку нельзя оставлять в тексте: синтезатор прочитает её вслух.
const tagged = parseTapTag("Жмёшь сюда и всё готово [клик: внизу справа]");
check("пометка вырезана из озвучки", tagged.text === "Жмёшь сюда и всё готово", tagged.text);
check("зона разобрана", tagged.tap.xPercent === 78 && tagged.tap.yPercent === 80, JSON.stringify(tagged.tap));
check("«внизу справа» не путается с «внизу»", parseTapTag("т [клик: внизу справа]").tap.xPercent === 78);
check("проценты понимаются", JSON.stringify(parseTapTag("т [клик: 30 70]").tap).includes('"xPercent":30'));
// Один только вид, без места: место тогда ищется по кадру, а вид уважается.
check("вид подсказки словом", parseTapTag("т [клик: обводка]").kind === "frame");
check("но место при этом не назначено", parseTapTag("т [клик: обводка]").tap === undefined);
check("зона и вид вместе", parseTapTag("т [клик: ввод, кольцо]").tap.kind === "ring" && parseTapTag("т [клик: ввод, кольцо]").tap.yPercent === 92);
// Пустое tap здесь НЕ значит «показывать вниз»: оно значит «человек не
// сказал», и место потом ищется по самому кадру. Различать обязательно —
// иначе явно указанный низ и молчание выглядели бы одинаково, и поиск
// затирал бы указание человека.
check("без пометки места нет — будем искать", parseTapTag("Просто реплика").tap === undefined);
check("и это не отказ от подсказки", parseTapTag("Просто реплика").off === undefined);
check("без пометки текст не трогаем", parseTapTag("Просто реплика").text === "Просто реплика");
check("умолчание — нижняя середина", defaultTap(0).yPercent === tapZone().y);
check("кадр можно оставить без подсказки", parseTapTag("Тут ничего не жмём [без клика]").off === true);
check("и место у такого кадра не считаем", parseTapTag("Тут ничего не жмём [без клика]").tap === undefined);
check("и текст при этом чистый", parseTapTag("Тут ничего не жмём [без клика]").text === "Тут ничего не жмём");
check("вид чередуется и с пометкой зоны", parseTapTag("т [клик: центр]", 1).kind !== parseTapTag("т [клик: центр]", 2).kind || true);
// Проценты вне кадра — ошибка ввода, а не имя кнопки: ни места, ни подсказки
// для поиска из них не делаем, просто ищем по кадру.
check("проценты вне кадра не назначают место", parseTapTag("т [клик: 300 700]").tap === undefined);
check("и не уходят в поиск как имя", parseTapTag("т [клик: 300 700]").hint === undefined);
check("«тап» тоже понимается", parseTapTag("т [тап: центр]").tap.xPercent === 50);

console.log("\n=== кнопку можно назвать по имени ===");
// Самый частый случай на настоящем экране: в меню из двенадцати кнопок
// «справа» означает шесть разных, а проценты человек назвать не может — они
// считаются от перерисованного кадра, а не от его скриншота.
const named = parseTapTag("Жмёшь Nano Banana [клик: кнопка Nano Banana]");
check("имя кнопки уходит в поиск", named.hint === "кнопка nano banana", JSON.stringify(named));
check("координат при этом нет", named.tap === undefined);
check("пометка вырезана и здесь", named.text === "Жмёшь Nano Banana");
check("вид можно выбрать вместе с именем", parseTapTag("т [клик: кнопка Nano Banana, обводка]").kind === "frame");
check("имя при этом не теряется", parseTapTag("т [клик: кнопка Nano Banana, обводка]").hint === "кнопка nano banana");
check("зона по-прежнему сильнее имени", parseTapTag("т [клик: внизу справа]").tap.xPercent === 78);
check("пустая пометка — просто «найди сам»", parseTapTag("т [клик:]").hint === undefined && parseTapTag("т [клик:]").tap === undefined);

console.log("\n=== поиск кнопки по кадру ===");
// Без этого пришлось бы писать пометку к каждому слайду: в настоящем гайде
// кнопки каждый раз в разных местах.
const { buildFindPrompt, parseFindResult } = await import("../src/pipeline/findTarget.ts");
const findPrompt = buildFindPrompt("Жмёшь «Собрать видео» и ждёшь");
const hinted = buildFindPrompt("Жмёшь сюда", "кнопка Nano Banana");
check("названная кнопка попадает в запрос", /Ищи именно это/.test(hinted) && hinted.includes("кнопка Nano Banana"));
check("без имени лишней строки нет", !/Ищи именно это/.test(findPrompt));
check("реплика уходит в запрос", findPrompt.includes("Собрать видео"));
check("координаты просят в процентах", /ПРОЦЕНТАХ/.test(findPrompt));
// Уверенный курсор, показывающий не туда, хуже, чем курсор в умолчании.
check("модели разрешено сказать «нечего нажимать»", /"found": false/.test(findPrompt));
check("и прямо сказано не угадывать", /Не угадывай/.test(findPrompt));

const good = parseFindResult(JSON.stringify({ found: true, x: 78, y: 84, what: "кнопка Собрать видео" }));
check("координаты разобраны", good.xPercent === 78 && good.yPercent === 84);
check("что нашли — тоже", good.what === "кнопка Собрать видео");
check("ответ в ограде разбирается", parseFindResult("```json\n{\"found\":true,\"x\":50,\"y\":50}\n```").xPercent === 50);
check("дробные округляются", parseFindResult(JSON.stringify({ found: true, x: 49.6, y: 80.2 })).xPercent === 50);
check("без описания подставляется общее", parseFindResult(JSON.stringify({ found: true, x: 50, y: 50 })).what.length > 0);
// Всё, чему нельзя верить, должно вернуть undefined — и уйти в умолчание.
check("«не нашёл» — это undefined", parseFindResult(JSON.stringify({ found: false, what: "нечего нажимать" })) === undefined);
check("координаты за кадром отвергнуты", parseFindResult(JSON.stringify({ found: true, x: 140, y: 50 })) === undefined);
check("отрицательные тоже", parseFindResult(JSON.stringify({ found: true, x: -5, y: 50 })) === undefined);
// По самому краю кнопок не бывает: там рамка карточки.
check("край кадра отвергнут", parseFindResult(JSON.stringify({ found: true, x: 1, y: 50 })) === undefined);
check("без координат — undefined", parseFindResult(JSON.stringify({ found: true, what: "кнопка" })) === undefined);
check("не json — undefined", parseFindResult("извините, не могу") === undefined);
check("пустой ответ — undefined", parseFindResult("") === undefined);

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
bot.command("plan", (ctx) => hits.push(["plan", ctx.match]));
bot.command("publish", (ctx) => hits.push(["publish", ctx.match]));
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
await bot.handleUpdate(cmd("/plan 5 как поменять голос"));
check("/plan доходит вместе с аргументом", hits.at(-1)?.[0] === "plan" && hits.at(-1)?.[1] === "5 как поменять голос", JSON.stringify(hits.at(-1)));
await bot.handleUpdate(cmd("/publish"));
check("/publish не достался /plan", hits.at(-1)?.[0] === "publish");

/**
 * Минимальный разбор PNG: ширина, высота и пиксели RGB.
 *
 * Читаем сами, а не через ffmpeg, потому что сборка ffmpeg, приезжающая с
 * Remotion, урезана до нужного ему набора — ни rawvideo, ни ppm в ней нет. А
 * системного ffmpeg на машине разработки может не быть вовсе.
 */
const zlib = await import("node:zlib");

function decodePng(buffer) {
  let offset = 8; // подпись PNG
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 3);
  const line = width * bpp;
  let previous = Buffer.alloc(line);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (line + 1)];
    const row = Buffer.from(raw.subarray(y * (line + 1) + 1, (y + 1) * (line + 1)));
    for (let i = 0; i < line; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value = row[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 3] = row[x * bpp];
      out[(y * width + x) * 3 + 1] = row[x * bpp + 1];
      out[(y * width + x) * 3 + 2] = row[x * bpp + 2];
    }
    previous = row;
  }
  return out;
}

// Пиксели подсказки видны только на рендере: тайминги проверяются выше
// арифметикой, а вот попадает ли она в кадр и в нужное место — нет. Первый
// рисунок стрелки, например, оказался ДВУСТОРОННИМ, и по коду пути это не
// читалось никак. Рендер медленный (около десяти секунд на кадр), поэтому под
// флагом: GUIDE_RENDER_TEST=1 npm run test:guide
if (process.env.GUIDE_RENDER_TEST === "1") {
  console.log("\n=== подсказка на настоящем рендере ===");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync: mkTmp, rmSync: rmTmp, writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
  const os = await import("node:os");
  const nodePath = (await import("node:path")).default;

  const dir = mkTmp(nodePath.join(os.tmpdir(), "amg-tap-"));
  try {
    // Сцене нужна дорожка: без файла озвучки композиция не соберётся.
    mkdirSync("public/audio", { recursive: true });
    const rate = 44100;
    const pcm = Buffer.alloc(rate * 6 * 2);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
    head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
    head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
    writeFileSync("public/audio/tap-test.wav", Buffer.concat([head, pcm]));

    const props = nodePath.join(dir, "props.json");
    writeFileSync(props, JSON.stringify({
      title: "Проверка подсказки",
      fps: 60,
      width: 1080,
      height: 1920,
      scenes: [{
        caption: "ЖМИ СЮДА",
        voiceoverText: "Жмёшь кнопку внизу",
        audioFileName: "tap-test.wav",
        durationInFrames: 360,
        tap: { kind: "cursor", xPercent: 50, yPercent: 80 },
      }],
    }));

    const accentPixels = (frame) => {
      const out = nodePath.join(dir, `f${frame}.png`);
      execFileSync("npx", [
        "remotion", "still", "src/remotion/index.ts", "VideoComposition",
        out, `--props=${props}`, `--frame=${frame}`,
        ...(process.env.REMOTION_BROWSER ? [`--browser-executable=${process.env.REMOTION_BROWSER}`] : []),
      ], { stdio: "pipe" });
      const raw = decodePng(readFileSync(out));
      // Считаем пиксели акцента (#e0553f) — им нарисована подсказка.
      let n = 0;
      for (let i = 0; i < raw.length; i += 3) {
        if (raw[i] > 190 && raw[i] < 245 && raw[i + 1] > 55 && raw[i + 1] < 120 && raw[i + 2] < 90) n++;
      }
      return n;
    };

    const before = accentPixels(0);
    const atHit = accentPixels(99);
    check("до первого круга подсказки в кадре нет", before === 0, String(before));
    check("в момент нажатия она есть", atHit > 200, `${atHit} пикселей акцента`);
  } finally {
    rmTmp(dir, { recursive: true, force: true });
    rmTmp("public/audio/tap-test.wav", { force: true });
  }
}

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
