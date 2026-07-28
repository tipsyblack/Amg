// Проверка качества сценария: обязательный хук, реклама только в финале и
// автоматические правки через generateCheckedScript. Сеть не нужна —
// OpenRouter подменяется заглушкой, которая по очереди отдаёт готовые ответы.
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

process.env.OPENROUTER_API_KEY ??= "test-key";
process.env.KIE_API_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const {
  hookProblem,
  promoProblem,
  toolListProblem,
  fillerProblem,
  scriptProblems,
  stripSources,
  generateCheckedScript,
} = await import("../src/pipeline/generateScript.ts");

console.log("=== валидатор хука ===");
const good = { caption: "ХВАТИТ ПЛАТИТЬ ЗА ПОДПИСКИ", voiceoverText: "Ты платишь за пять нейросетей отдельно. Зря." };
check("нормальный хук проходит", hookProblem(good) === undefined, String(hookProblem(good)));

for (const opening of [
  "Привет, друзья!",
  "Здравствуйте, меня зовут Шамиль.",
  "Ассаламу алейкум!",
  "Добрый день, коллеги.",
  "В этом видео расскажу про нейросети.",
  "Сегодня поговорим о нейросетях.",
  "Итак, начнём.",
  "Hi there, let's start.",
]) {
  const problem = hookProblem({ caption: "ТЕСТ", voiceoverText: opening });
  check(`отклонено приветствие: «${opening}»`, problem?.includes("приветствия") === true, String(problem));
}

const long = {
  caption: "ТЕСТ",
  voiceoverText:
    "Сегодняшний ролик мы посвятим тому как именно можно использовать " +
    "современные нейросетевые модели в повседневных рабочих задачах, " +
    "а начнём мы с самого простого примера из практики",
};
check("слишком длинный хук отклонён", hookProblem(long)?.includes("слов") === true, String(hookProblem(long)));
// Новостной хук с фразой-зацепкой — 19 слов, это норма для жанра.
const newsHook = {
  caption: "ДАТА-ЦЕНТРЫ В КОСМОСЕ",
  voiceoverText:
    "Илон Маск строит дата-центры для своего ИИ в космосе, ему чё, мало места, " +
    "что ли? Сейчас всё расскажу, смотри.",
};
check("новостной хук на 19 слов проходит", hookProblem(newsHook) === undefined, String(hookProblem(newsHook)));

const wordyCaption = {
  caption: "ОЧЕНЬ ДЛИННАЯ ПОДПИСЬ КОТОРАЯ НИКАК НЕ ВЛЕЗАЕТ В КАДР",
  voiceoverText: "Ты теряешь час каждый день.",
};
check("длинная подпись отклонена", hookProblem(wordyCaption)?.includes("подпись") === true, String(hookProblem(wordyCaption)));

// «Приветливое» слово не в начале — не повод браковать хук.
const midGreeting = { caption: "ЗАБУДЬ ПРО ЭТО", voiceoverText: "Забудь про «привет, чем помочь» — отвечай сразу." };
check("приветствие не в начале допустимо", hookProblem(midGreeting) === undefined, String(hookProblem(midGreeting)));

console.log("\n=== реклама только в финале ===");
const usefulBody = [
  { caption: "ТРИ ТОНА СРАЗУ", voiceoverText: "Попроси переписать текст в трёх тонах и выбери лучший." },
  { caption: "ПРОВЕРЬ ЦИФРЫ", voiceoverText: "Модель уверенно врёт в числах — сверяй с источником." },
];
const cta = { caption: "ЖМИ ССЫЛКУ", voiceoverText: "Переходи по ссылке в описании." };
const cleanScript = {
  title: "Приёмы работы с текстом",
  scenes: [
    { caption: "ПЛАТИШЬ ПЯТЬ РАЗ", voiceoverText: "Ты платишь пяти сервисам за одно и то же." },
    ...usefulBody,
    cta,
  ],
};
check("полезная середина проходит", promoProblem(cleanScript) === undefined, String(promoProblem(cleanScript)));
check("призыв в последней сцене допустим", promoProblem({ title: "t", scenes: [usefulBody[0], cta] }) === undefined);

for (const [what, scene] of [
  ["наш бот", { caption: "ВСЁ УМЕЕТ", voiceoverText: "Наш бот умеет всё это сразу." }],
  ["нашего сервиса (со склонением)", { caption: "ТУТ", voiceoverText: "В нашем сервисе это уже готово." }],
  ["подписка", { caption: "ДЁШЕВО", voiceoverText: "Одна подписка вместо пяти." }],
  ["тариф", { caption: "ТАРИФЫ", voiceoverText: "Тариф начинается со ста рублей." }],
  ["ссылка в описании", { caption: "ТАМ", voiceoverText: "Всё это по ссылке в описании." }],
  ["призыв", { caption: "ДАВАЙ", voiceoverText: "Жми старт и пробуй сам." }],
  ["у нас есть", { caption: "ГОТОВО", voiceoverText: "У нас есть все эти модели." }],
  ["промокод", { caption: "СКИДКА", voiceoverText: "Промокод даёт первый месяц дешевле." }],
]) {
  const withPromo = { title: "t", scenes: [cleanScript.scenes[0], scene, cta] };
  check(`реклама в середине поймана: ${what}`, promoProblem(withPromo) !== undefined, String(promoProblem(withPromo)));
}
const promoCase = { title: "t", scenes: [cleanScript.scenes[0], { caption: "П", voiceoverText: "Наш бот умеет всё." }, cta] };
check("в причине указан номер сцены", promoProblem(promoCase)?.includes("сцена 2") === true, promoProblem(promoCase));

console.log("\n=== перечисление инструментов вместо пользы ===");
// Это ровно тот сценарий, который забраковал заказчик: каждая сцена — название
// сервиса плюс восторг, применить нечего.
const toolList = {
  title: "Видео нейросетями",
  scenes: [
    { caption: "Тратишь часы на видео?", voiceoverText: "Хватит монтировать часами." },
    { caption: "GPT-5.4: сценарий за 15 минут", voiceoverText: "Потом GPT-5.4 или Claude сценарий напишут." },
    { caption: "Midjourney: кадры-референсы", voiceoverText: "Midjourney или Imagen 4 сделают раскадровку." },
    { caption: "ElevenLabs: озвучка", voiceoverText: "ElevenLabs озвучит любым голосом." },
    { caption: "Suno AI: музыка", voiceoverText: "Музыку напишет Suno." },
    cta,
  ],
};
check("список сервисов поймали", toolListProblem(toolList) !== undefined, String(toolListProblem(toolList)));
check("в причине названо, сколько сцен", /4 из 4/.test(String(toolListProblem(toolList))), String(toolListProblem(toolList)));
check("полезная середина не считается списком", toolListProblem(cleanScript) === undefined);
// Одно-два названия вместе с приёмом — нормально, это не список.
const twoNames = {
  title: "t",
  scenes: [
    cleanScript.scenes[0],
    { caption: "ОДНОЙ ФРАЗОЙ", voiceoverText: "Опиши кадр одной фразой и добавь стиль — так кадры не разъедутся." },
    { caption: "Midjourney: три варианта", voiceoverText: "Проси сразу четыре кадра и выбирай, первый обычно скучный." },
    { caption: "ПРОВЕРЬ ЛИЦА", voiceoverText: "Смотри на руки и лица — там ошибки заметнее всего." },
    cta,
  ],
};
check("одно название среди приёмов допустимо", toolListProblem(twoNames) === undefined, String(toolListProblem(twoNames)));
// Короткий ролик из трёх сцен проверять нечем — не придираемся.
check("на коротком ролике проверка молчит", toolListProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "Suno AI", voiceoverText: "x" }, cta] }) === undefined);

console.log("\n=== вода и выдуманные цифры ===");
for (const [what, scene] of [
  ["пустой восторг", { caption: "КРАСОТА", voiceoverText: "Сделает раскадровку. Красота!" }],
  ["чистый кайф", { caption: "МУЗЫКА", voiceoverText: "Музыку напишет за секунды. Чистый кайф!" }],
  ["штамп", { caption: "ЛЕГКО", voiceoverText: "Всё легко и просто, без навыков." }],
  ["меняет дело", { caption: "НОВОЕ", voiceoverText: "Нейросети меняют дело." }],
  ["связка ни о чём", { caption: "ИДЕЯ", voiceoverText: "Сначала мы идею в текст заносим, да?" }],
  ["как говорится", { caption: "СТАРТ", voiceoverText: "Как говорится, начинаем работу." }],
  ["процент", { caption: "ЭКОНОМИЯ", voiceoverText: "Экономия бюджета до 90%." }],
  ["в N раз", { caption: "БЫСТРЕЕ", voiceoverText: "Получается в пять раз быстрее." }],
  ["за N минут", { caption: "БЫСТРО", voiceoverText: "Сценарий готов за 15 минут." }],
]) {
  const script = { title: "t", scenes: [cleanScript.scenes[0], scene, cta] };
  check(`поймано: ${what}`, fillerProblem(script) !== undefined, String(fillerProblem(script)));
}
check("полезные сцены проходят", fillerProblem(cleanScript) === undefined, String(fillerProblem(cleanScript)));
// Цифры-указания («три тона», «четыре кадра») — это польза, а не статистика.
check(
  "числа словами не считаются статистикой",
  fillerProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "ТРИ ТОНА", voiceoverText: "Проси три варианта и выбирай." }, cta] }) === undefined,
);

console.log("\n=== ссылки из веб-поиска не попадают в озвучку ===");
// Именно это модель дописывала к фразам при включённом поиске, и синтезатор
// читал адрес вслух.
const cited = "Потом GPT-5.4 напишет сценарий. [mashagpt.ru](https://mashagpt.ru/blog/kak-sdelat-rolik)";
check("ссылка-сноска убрана", stripSources(cited) === "Потом GPT-5.4 напишет сценарий.", stripSources(cited));
check("голый адрес убран", stripSources("Смотри https://example.com/blog там всё есть") === "Смотри там всё есть", stripSources("Смотри https://example.com/blog там всё есть"));
check("домен без схемы убран", stripSources("Подробнее на mashagpt.ru") === "Подробнее на", stripSources("Подробнее на mashagpt.ru"));
check("сноска [1] убрана", stripSources("Это факт [1] проверенный") === "Это факт проверенный");
check("двойная точка не остаётся", !stripSources("Готово. (https://a.ru)").includes(".."), stripSources("Готово. (https://a.ru)"));
check("обычный текст не портится", stripSources("Проси три тона: строгий, дружеский, короткий.") === "Проси три тона: строгий, дружеский, короткий.");
check("название модели с точкой цело", stripSources("GPT-5.4 и Sora 2 умеют это") === "GPT-5.4 и Sora 2 умеют это", stripSources("GPT-5.4 и Sora 2 умеют это"));

console.log("\n=== проверки на присланном сценарии находят обе беды ===");
const realProblems = scriptProblems(toolList);
check("названо и про список, и про воду", realProblems.length >= 1 && realProblems.some((p) => p.includes("названия инструментов")), realProblems.join(" | "));

console.log("\n=== автоматические правки ===");
const weakScript = {
  title: "Про нейросети",
  scenes: [
    { caption: "ПРИВЕТ!", voiceoverText: "Привет, друзья! Сегодня расскажу про нейросети." },
    { caption: "ВСЁ В ОДНОМ БОТЕ", voiceoverText: "Наш бот умеет всё это сразу." },
    cta,
  ],
};

let requests = [];
const queue = [];
let httpStatus = 200;
globalThis.fetch = async (url, init) => {
  requests.push(JSON.parse(init.body));
  // Отказ имитируем только на запросах с плагином веб-поиска.
  if (httpStatus !== 200 && JSON.parse(init.body).plugins) {
    return new Response('{"error":"web plugin not available"}', { status: httpStatus });
  }
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(queue.shift()) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

queue.push(weakScript, cleanScript);
requests = [];
const fixed = await generateCheckedScript("Продукт: нейросети в Телеграм.");
check("сделано два запроса", requests.length === 2, String(requests.length));
check("хук заменён", fixed.script.scenes[0].caption === "ПЛАТИШЬ ПЯТЬ РАЗ", fixed.script.scenes[0].caption);
check("реклама из середины убрана", promoProblem(fixed.script) === undefined);
check("названы обе причины", fixed.fixes.length === 2, fixed.fixes.join(" | "));
const feedback = requests[1].messages.at(-1).content;
check("в правку попало про хук", feedback.includes("первую сцену"), feedback.slice(0, 80));
check("в правку попало про рекламу", feedback.includes("кроме последней"));
check("остальное просят не трогать", feedback.includes("оставь как есть"));

queue.length = 0;
queue.push(cleanScript);
requests = [];
const asIs = await generateCheckedScript("Продукт: нейросети в Телеграм.");
check("хороший сценарий не переписывается", requests.length === 1, String(requests.length));
check("правок нет", asIs.fixes.length === 0, asIs.fixes.join(" | "));

// Даже если модель со второй попытки снова принесла слабый сценарий, отдаём
// то, что есть: пустой результат хуже несовершенного.
queue.length = 0;
queue.push(weakScript, weakScript);
requests = [];
const stillWeak = await generateCheckedScript("Продукт: нейросети в Телеграм.");
check("после двух попыток сценарий всё равно есть", stillWeak.script.scenes.length === 3);
check("вторая попытка не зациклилась", requests.length === 2, String(requests.length));

console.log("\n=== веб-поиск для актуальных тем ===");
queue.length = 0;
queue.push(cleanScript);
requests = [];
await generateCheckedScript("Тема: тренды нейросетей.");
check("к первому запросу подключён веб-поиск", requests[0].plugins?.[0]?.id === "web", JSON.stringify(requests[0].plugins));
check("число результатов задано", typeof requests[0].plugins[0].max_results === "number");

// При правках свежие материалы не нужны — тема уже выбрана.
queue.length = 0;
queue.push(cleanScript);
requests = [];
await generateCheckedScript("Тема: тренды.", { previousScript: cleanScript, feedback: "короче" });
check("на правках поиск не тратится", requests[0].plugins === undefined);

// Если плагин недоступен, запрос повторяется без него, а не падает.
httpStatus = 404;
queue.length = 0;
queue.push(cleanScript);
requests = [];
const noWeb = await generateCheckedScript("Тема: тренды.");
check("сценарий всё равно получен", noWeb.script.scenes.length === 4, String(noWeb.script.scenes.length));
check("повтор ушёл без плагина", requests.length === 2 && requests[1].plugins === undefined, String(requests.length));
check("про недоступность поиска сказано наружу", noWeb.webSearchUnavailable === true);
httpStatus = 200;

console.log("\n=== промпт задаёт структуру ===");
const prompt = requests[0].messages[0].content;
check("в промпте есть блок про хук", prompt.includes("ПЕРВАЯ СЦЕНА — ХУК"));
check("приветствия запрещены прямо в промпте", prompt.includes("НИКАКИХ приветствий"));
check("лимит слов хука назван", /не больше 20 слов/i.test(prompt), prompt.match(/не больше 20 слов.{0,24}/i)?.[0]);
check("бюджет слов на ролик назван", /не больше 144 слов озвучки/i.test(prompt), prompt.match(/не больше \d+ слов озвучки.{0,20}/i)?.[0]);
check("жанр задан как рассказ, а не инструкция", prompt.includes("рассказываю интересное"));
check("телеграф запрещён", prompt.includes("НЕ пиши телеграфом"));
check("разрешён живой разговорный тон", prompt.includes("Сленг уместен"));
check("цифры из физики разрешены", prompt.includes("Цифры из физики"));
check("в промпте есть эталонный пример", prompt.includes("Дата-центры в космосе") && prompt.includes("палка о двух концах"));
check("сказано, что ролик не рекламный", prompt.includes("не реклама и не инструкция"));
check("продукт разрешён только в финале", prompt.includes("кроме последней"));
check("перечисление сервисов запрещено", prompt.includes("перечисление сервисов"));
check("запрещён пустой восторг", prompt.includes("Пустой восторг"));
check("запрещены проценты и «за N минут»", prompt.includes("«за N минут»"));
check("запрещено вставлять ссылки в текст", prompt.includes("Ссылки, адреса сайтов"));
check("рекомендовано 5-7 сцен", prompt.includes("оптимально 5-7"));

console.log("\n=== ответ модели разбирается, даже если это не чистый JSON ===");
// Так это и может сломаться при смене модели: response_format — параметр из
// мира OpenAI, и если OpenRouter его для модели не переводит, JSON приходит
// обёрнутым в ```-блок или с фразой перед ним.
const { extractJson } = await import("../src/pipeline/generateScript.ts");
const obj = { title: "Тест", scenes: [{ caption: "А", voiceoverText: "б" }] };
const raw = JSON.stringify(obj);
const same = (s) => JSON.stringify(JSON.parse(extractJson(s))) === raw;
check("чистый JSON проходит как есть", same(raw));
check("```json-блок снимается", same("```json\n" + raw + "\n```"));
check("```-блок без языка тоже", same("```\n" + raw + "\n```"));
check("фраза перед JSON отбрасывается", same("Вот сценарий:\n" + raw));
check("фраза после JSON отбрасывается", same(raw + "\n\nГотово!"));
check("отступы и перевод строки не мешают", same("\n  " + raw + "  \n"));
// Берём текст до ПОСЛЕДНЕЙ }, а не до первой: иначе вложенный overlay обрезал
// бы весь сценарий.
const nested = JSON.stringify({
  title: "Тест",
  scenes: [{ caption: "А", voiceoverText: "б", overlay: { object: "кот" } }],
});
check(
  "вложенные объекты не обрезаются",
  JSON.parse(extractJson("Вот:\n```json\n" + nested + "\n```")).scenes[0].overlay
    .object === "кот",
);
check("текст без JSON возвращается как есть — падение будет осмысленным", extractJson("Не могу") === "Не могу");

console.log("\n=== визуальный акцент на первой сцене ===");
const { sceneMotion, MOTION_CYCLE_LENGTH } = await import("../src/remotion/transitions.ts");
check("у хука своё движение", sceneMotion(0).emphasis === true);
check("хук наезжает, а не проявляется", sceneMotion(0).entry === "punch", sceneMotion(0).entry);
check("у остальных сцен акцента нет", [1, 2, 3, 4, 5, 6, 7].every((i) => !sceneMotion(i).emphasis));
check("движение по-прежнему детерминировано", sceneMotion(1).entry === sceneMotion(1 + MOTION_CYCLE_LENGTH).entry);

const { existsSync, statSync } = await import("node:fs");
check("звук хука в репозитории", existsSync("public/sfx/hook.wav"));
check("звук хука не пустой", existsSync("public/sfx/hook.wav") && statSync("public/sfx/hook.wav").size > 1000);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
