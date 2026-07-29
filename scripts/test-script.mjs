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
// Призыв в фикстуре тоже обязан быть хорошим: он подставляется почти во все
// проверки, и слабый ловился бы новым ctaProblem, зашумляя остальные тесты.
const cta = {
  caption: "ЖМИ ССЫЛКУ",
  voiceoverText: "По ссылке в шапке затестишь любую нейросеть бесплатно.",
};
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
check("бюджет слов на ролик назван", /не больше 126 слов озвучки/i.test(prompt), prompt.match(/не больше \d+ слов озвучки.{0,20}/i)?.[0]);
check("жанр задан как рассказ, а не инструкция", prompt.includes("рассказываю интересное"));
// «Не телеграфом» переформулировано: раньше это было про длину и толкало
// модель к сценам на 25-45 слов, то есть к кадру, висящему по 15 секунд.
// Теперь это правило про содержание.
check("телеграф запрещён по содержанию, а не по длине", prompt.includes("это про содержание, а не про длину"));
check("сказано, что сцена — это кадр", prompt.includes("СЦЕНА — ЭТО КАДР"));
check("разрешено рвать фразу через склейку", prompt.includes("закончиться в следующей"));
check("разрешён живой разговорный тон", prompt.includes("Сленг уместен"));
check("цифры из физики разрешены", prompt.includes("Цифры из физики"));
check("в промпте есть эталонный пример", prompt.includes("Дата-центры в космосе") && prompt.includes("палка о двух концах"));
check("сказано, что ролик не рекламный", prompt.includes("не реклама и не инструкция"));
check("продукт разрешён только в финале", prompt.includes("кроме последней"));
check("перечисление сервисов запрещено", prompt.includes("перечисление сервисов"));
check("запрещён пустой восторг", prompt.includes("Пустой восторг"));
check("запрещены проценты и «за N минут»", prompt.includes("«за N минут»"));
check("запрещено вставлять ссылки в текст", prompt.includes("Ссылки, адреса сайтов"));
check("названа норма слов на кадр", /8-14 слов озвучки/.test(prompt), prompt.match(/В каждой сцене .{0,24}/)?.[0]);
check("названа нижняя граница числа сцен", /От 9 до 15 сцен/.test(prompt), prompt.match(/От \d+ до \d+ сцен/)?.[0]);

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

console.log("\n=== выбор модели сценария (/model) ===");
const models = await import("../src/pipeline/scriptModels.ts");
const { config } = await import("../src/pipeline/config.ts");
check("список непустой", models.SCRIPT_MODELS.length >= 2);
check("ключи уникальны", new Set(models.SCRIPT_MODELS.map((m) => m.key)).size === models.SCRIPT_MODELS.length);
check("у каждой модели есть слаг и подпись", models.SCRIPT_MODELS.every((m) => m.model && m.title && m.note));
check(
  "дефолтный ключ есть в списке",
  models.SCRIPT_MODELS.some((m) => m.key === models.DEFAULT_SCRIPT_MODEL_KEY),
);
// Модель по умолчанию берёт слаг из .env, иначе OPENROUTER_MODEL перестал бы
// работать после появления кнопок.
check(
  "дефолтная модель = OPENROUTER_MODEL",
  models.getScriptModel(models.DEFAULT_SCRIPT_MODEL_KEY).model === config.openRouterModel,
);
check("неизвестный ключ -> дефолт", models.getScriptModel("нет").key === models.DEFAULT_SCRIPT_MODEL_KEY);
check("пустой ключ -> дефолт", models.getScriptModel().key === models.DEFAULT_SCRIPT_MODEL_KEY);

console.log("\n=== слаг для запроса ===");
check("ничего не выбрано -> из .env", models.resolveScriptModel() === config.openRouterModel);
check("ключ из списка -> его слаг", models.resolveScriptModel("opus") === "anthropic/claude-opus-5");
// Ручной слаг проходит как есть: ID моделей на OpenRouter меняются чаще, чем
// наш список, и упереться в него нельзя.
check(
  "произвольный слаг проходит как есть",
  models.resolveScriptModel("x-ai/grok-9") === "x-ai/grok-9",
);
check(
  "слаг, совпавший с ключом, не превращается в другую модель",
  models.resolveScriptModel("flash") === "google/gemini-2.5-flash",
);

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

console.log("\n=== ритм: сцена — это кадр, а не мысль ===");
// Проверка появилась после первого настоящего ролика: шесть сцен на 69 секунд,
// один кадр висел 15 секунд. Правило «не больше N слов» было в промпте, но
// никто не смотрел, выполнено ли оно.
const { rhythmProblem, minSceneCount, wordBudget, STYLE_EXAMPLE } = await import(
  "../src/pipeline/generateScript.ts"
);
const sc = (n) => ({ caption: "c", voiceoverText: Array(n).fill("слово").join(" ") });

check(
  "бюджет слов считается от длины ролика",
  wordBudget(60) === 126 && wordBudget(30) === 63,
  `${wordBudget(60)} / ${wordBudget(30)}`,
);
check(
  "подсказка о числе кадров растёт вместе с длиной ролика",
  minSceneCount(60) > minSceneCount(30),
  `${minSceneCount(60)} против ${minSceneCount(30)}`,
);
check(
  "и не превышает MAX_SCENES — просить невозможного нельзя",
  minSceneCount(600) <= 15,
  String(minSceneCount(600)),
);

// Меряем длину сцены, а не их количество: три сцены на пятнадцать секунд —
// нормальный ритм, а три сцены на минуту — беда. Короткий ролик проверка
// трогать не должна.
check(
  "короткий ролик из трёх сцен претензий не вызывает",
  rhythmProblem({ title: "т", scenes: [sc(8), sc(8), sc(8)] }, 60) === undefined,
  rhythmProblem({ title: "т", scenes: [sc(8), sc(8), sc(8)] }, 60),
);

// Форма настоящего сценария, который дал 71-секундный ролик.
const real = { title: "т", scenes: [sc(12), sc(38), sc(40), sc(30), sc(25), sc(20)] };
const realProblem = rhythmProblem(real, 60);
check("сценарий из настоящего ролика забракован", Boolean(realProblem), realProblem);
check(
  "названа причина, по которой ролик вылезет за лимит",
  /бюджете/.test(realProblem ?? ""),
  realProblem,
);

check(
  "одна растянутая сцена среди нормальных ловится",
  /сцена 4/.test(
    rhythmProblem({ title: "т", scenes: Array.from({ length: 13 }, (_, i) => sc(i === 3 ? 26 : 8)) }, 60) ?? "",
  ),
);
// Последней сцене можно вдвое больше: там призыв к действию, рвать его пополам
// незачем — да и проверка на рекламу освобождает только последнюю сцену.
check(
  "финалу с призывом разрешена двойная длина",
  rhythmProblem({ title: "т", scenes: Array.from({ length: 13 }, (_, i) => sc(i === 12 ? 20 : 8)) }, 60) === undefined,
);
check(
  "но и финалу не бесконечно",
  Boolean(rhythmProblem({ title: "т", scenes: Array.from({ length: 13 }, (_, i) => sc(i === 12 ? 40 : 8)) }, 60)),
);

// Пример стиля в промпте сильнее правил: раньше он показывал пять длинных
// сцен, и модель копировала именно его. Значит пример обязан сам проходить
// проверку, которую мы предъявляем модели.
const example = JSON.parse(STYLE_EXAMPLE);
{
  check(
    "пример стиля сам проходит проверку ритма",
    rhythmProblem(example, 60) === undefined,
    rhythmProblem(example, 60),
  );
  check("в примере больше десяти кадров", example.scenes.length >= 10, String(example.scenes.length));
}


console.log("\n=== маркетинговые проверки ===");
const {
  deadEndProblem,
  hookNumberProblem,
  ctaProblem,
  staleProblem,
} = await import("../src/pipeline/generateScript.ts");

console.log("--- финал без вывода ---");
// Ролик, кончающийся «учёные работают над этим», не даёт зрителю ни вывода,
// ни повода поделиться. Смотрим предпоследнюю сцену: в последней призыв.
for (const [what, text] of [
  ["учёные ищут", "Инженеры и учёные ищут способы снизить энергопотребление."],
  ["непростая задача", "Это непростая задача, братуха."],
  ["время покажет", "Что будет дальше — время покажет."],
  ["пока неясно", "Пока непонятно, чем это кончится."],
  ["работа идёт", "Работа всё ещё идёт."],
]) {
  const script = { title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: text }, cta] };
  check(`поймано: ${what}`, deadEndProblem(script) !== undefined, String(deadEndProblem(script)));
}
check(
  "вывод для зрителя претензий не вызывает",
  deadEndProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "Значит, проси у модели конкретику, а не красоту." }, cta] }) === undefined,
);
// Смотреть надо предпоследнюю: в последней сцене эти же слова были бы частью
// призыва, а не концовкой рассказа.
check(
  "в самом призыве такие слова не ищем",
  deadEndProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "Проси конкретику." }, { caption: "CTA", voiceoverText: "Время покажет, но затестить бота можно бесплатно прямо сейчас." }] }) === undefined,
);

console.log("--- яркая цифра должна быть в хуке ---");
const buried = {
  title: "t",
  scenes: [
    { caption: "ХУК", voiceoverText: "Нейросети жрут энергию, и это стало проблемой." },
    { caption: "ЦИФРА", voiceoverText: "Одно обучение — 1287 мегаватт-часов электричества." },
    cta,
  ],
};
check("цифра в середине поймана", hookNumberProblem(buried) !== undefined, String(hookNumberProblem(buried)));
check(
  "названо, в какой именно сцене она лежит",
  /сцене 2/.test(hookNumberProblem(buried) ?? ""),
  hookNumberProblem(buried),
);
check(
  "цифра в хуке — претензий нет",
  hookNumberProblem({ title: "t", scenes: [{ caption: "ХУК", voiceoverText: "Одно обучение нейросети — 1287 мегаватт-часов." }, { caption: "К", voiceoverText: "Это много." }, cta] }) === undefined,
);
check(
  "ролик без крупных цифр вообще не трогаем",
  hookNumberProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "Проси три варианта." }, cta] }) === undefined,
);
// Год и номер поколения — не «яркая цифра», иначе проверка сработает на
// каждом втором ролике про ИИ.
check(
  "год не считается крючком",
  hookNumberProblem({ title: "t", scenes: [{ caption: "ХУК", voiceoverText: "Смотри, что поменялось." }, { caption: "К", voiceoverText: "В 2026 году всё стало иначе." }, cta] }) === undefined,
);

console.log("--- призыв ---");
const weakCta = { title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "Проси конкретику." }, { caption: "CTA", voiceoverText: "Наш бот умеет фото, видео и музыку. Загляни по ссылке в профиле, там много интересного." }] };
const ctaFound = ctaProblem(weakCta);
check("слабый призыв пойман", ctaFound !== undefined, String(ctaFound));
check("названо «там много интересного»", /много интересного/.test(ctaFound ?? ""), ctaFound);
check("названо отсутствие предложения", /конкретного предложения/.test(ctaFound ?? ""), ctaFound);
check(
  "растянутый призыв пойман",
  /растянут/.test(
    ctaProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "CTA", voiceoverText: "Бесплатно " + Array(30).fill("слово").join(" ") }] }) ?? "",
  ),
);
check(
  "конкретный короткий призыв проходит",
  ctaProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "CTA", voiceoverText: "По ссылке в шапке затестишь любую нейросеть бесплатно." }] }) === undefined,
  ctaProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "CTA", voiceoverText: "По ссылке в шапке затестишь любую нейросеть бесплатно." }] }),
);

console.log("--- устаревшие примеры ---");
check(
  "GPT-3 датирует ролик",
  /GPT-3/.test(staleProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "Нейросеть GPT-3, к примеру, потребляет много." }, cta] }) ?? ""),
);
check(
  "актуальное поколение не трогаем",
  staleProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "GPT-5.4 справляется с этим сама." }, cta] }) === undefined,
);
check(
  "версия с точкой не путается со старой",
  staleProblem({ title: "t", scenes: [cleanScript.scenes[0], { caption: "К", voiceoverText: "Claude 5 и Llama 4 умеют это." }, cta] }) === undefined,
);

console.log("--- сценарий из присланного ролика ---");
// Тот самый ролик, ради которого проверки и появились.
const shipped = {
  title: "Энергия нейросетей",
  scenes: [
    { caption: "НЕЙРОСЕТИ ЖРУТ ЭНЕРГИЮ", voiceoverText: "Нейросети потребляют так много энергии, что уже стало настоящей проблемой. Чего так? Объясню, смотри." },
    { caption: "1287 МЕГАВАТТ-ЧАСОВ", voiceoverText: "Нейросеть GPT-3, к примеру, за одно обучение потребляет около 1287 мегаватт-часов электричества." },
    { caption: "УМНОЖЕНИЕ МАТРИЦ", voiceoverText: "Прикол в том, что обучение — это миллиарды операций умножения матриц." },
    { caption: "НЕПРОСТАЯ ЗАДАЧА", voiceoverText: "Инженеры и учёные ищут способы снизить энергопотребление. Это непростая задача, братуха." },
    { caption: "ЗАГЛЯНИ В ПРОФИЛЬ", voiceoverText: "Хочешь сам поработать с мощными нейросетями? Наш бот соберёт для тебя фото, видео, музыку. Загляни по ссылке профиле, там много интересного, да?" },
  ],
};
const shippedProblems = scriptProblems(shipped, 60);
for (const key of ["яркая цифра", "кончается ничем", "слабый призыв", "устаревшие примеры"]) {
  check(`найдено: ${key}`, shippedProblems.some((p) => p.includes(key)), shippedProblems.join(" | ").slice(0, 90));
}

// Пример стиля в промпте сильнее правил, поэтому он обязан проходить ВСЕ
// проверки, которые мы предъявляем модели, — не только ритм.
console.log("--- пример стиля безупречен ---");
const exampleProblems = scriptProblems(JSON.parse(STYLE_EXAMPLE), 60);
check("пример проходит все проверки", exampleProblems.length === 0, exampleProblems.join(" | "));


console.log("\n=== корпус здоровых сценариев: проверки не должны срабатывать ===");
// Все проверки выше выведены из разбора ОДНОГО ролика, и это главный риск:
// правило, подогнанное под единственный случай, начинает браковать нормальные
// сценарии на других темах. Корпус — защита от этого. Каждый сценарий здесь
// написан как хороший: соблюдает ритм, имеет вывод и внятный призыв. Ни один
// не должен вызывать ни одной претензии.
//
// Корпус уже отработал: на первом прогоне он забраковал два правила.
// «Тысячи вариантов» считалось яркой цифрой (обобщение с «1287 мегаватт-часов»
// на любое слово масштаба), а предел подписи хука в проверке был 5 слов при
// восьми в промпте — модель следовала инструкции и получала отказ.
const sc2 = (caption, voiceoverText) => ({ caption, voiceoverText });
const HEALTHY = {
  "промпты, без единой цифры": [
    sc2("ПРОСИШЬ КРАСИВО — ПОЛУЧАЕШЬ МУСОР", "Ты просишь у нейросети «красиво», а получаешь мусор. Вот почему."),
    sc2("МОДЕЛЬ НЕ ЗНАЕТ ТВОЁ КРАСИВО", "Модель не знает, что красиво лично для тебя."),
    sc2("ОНА УСРЕДНЯЕТ", "Она усредняет всё, что видела, и выдаёт середину."),
    sc2("НАЗЫВАЙ ПРЕДМЕТЫ", "Называй предметы, а не впечатления: не «уютно», а «плед, лампа, чашка»."),
    sc2("СВЕТ РЕШАЕТ", "Свет решает больше композиции — скажи, откуда он падает."),
    sc2("ТРИ ПРАВКИ", "Три точные правки работают лучше одного длинного промпта."),
    sc2("ПОПРОБУЙ", "По ссылке в шапке затестишь любую нейросеть бесплатно."),
  ],
  "цифра в середине, но не крючок": [
    sc2("ТЫ ПЛАТИШЬ ПЯТЬ РАЗ", "Ты платишь пяти сервисам за то, что делает один."),
    sc2("ТЕКСТ ОТДЕЛЬНО", "За текст платишь одному, за картинки другому."),
    sc2("ТЫСЯЧИ ВАРИАНТОВ", "А внутри у них тысячи вариантов одной и той же модели."),
    sc2("СЧИТАЙ ПО ЗАДАЧАМ", "Считай не по сервисам, а по задачам, которые реально делаешь."),
    sc2("ПОПРОБУЙ", "Затестить любую нейросеть можно бесплатно по ссылке в шапке."),
  ],
  "историческая рамка с устаревшей моделью": [
    sc2("ПЯТЬ ЛЕТ НАЗАД ЭТО БЫЛО ЧУДОМ", "Пять лет назад машина, пишущая связный текст, была чудом."),
    sc2("ТОГДА", "Тогда GPT-3 удивлял всех одним абзацем без ошибок."),
    sc2("СЕЙЧАС ЭТО НОРМА", "Сегодня это лежит в телефоне и работает за секунду."),
    sc2("ПРОВЕРЯЙ ФАКТЫ", "Проверяй факты сам, особенно даты, имена и цифры."),
    sc2("ПОПРОБУЙ", "По ссылке в шапке затестишь любую нейросеть бесплатно."),
  ],
  "призыв через подписку, без слова «бесплатно»": [
    sc2("НЕЙРОКАРТИНКУ ВИДНО ПО РУКАМ", "Нейрокартинку почти всегда видно по рукам и по тексту."),
    sc2("ПАЛЬЦЫ", "Пальцы — самое сложное: их часто больше или меньше."),
    sc2("СМОТРИ НА КРАЯ", "Смотри на края кадра — там ошибок больше всего."),
    sc2("ПОДПИШИСЬ", "Подпишись — разбираю по одной нейросети каждую неделю."),
  ],
  "«непростая задача», но с выводом": [
    sc2("МУЗЫКА ЗА МИНУТУ", "Нейросеть пишет музыку за минуту, но звучит она никак."),
    sc2("ПРИЧИНА В ЗАПРОСЕ", "Причина не в модели, а в том, что ты просишь."),
    sc2("СКАЖИ ПРО ТЕМП", "Скажи темп, инструменты и настроение в двух словах."),
    sc2("НАЧНИ С ОДНОГО", "Подобрать формулировку непростая задача, поэтому начни с одного инструмента."),
    sc2("ПОПРОБУЙ", "Затестить любую нейросеть бесплатно можно по ссылке в шапке."),
  ],
  "крупная цифра стоит в хуке": [
    sc2("40 ЧАСОВ В МЕСЯЦ", "Сорок часов в месяц уходит у монтажёра на рутину."),
    sc2("ЧТО ЭТО ЗА ЧАСЫ", "Это нарезка, субтитры, подбор музыки и вычитка текста."),
    sc2("МАШИНА БЕРЁТ РУТИНУ", "Машина хорошо берёт именно такое: однотипное и скучное."),
    sc2("ЭТО И ЕСТЬ РАБОТА", "Решать, что показать, остаётся человеку — это и есть работа."),
    sc2("ПОПРОБУЙ", "По ссылке в шапке затестишь любую нейросеть бесплатно."),
  ],
};

for (const [name, scenes] of Object.entries(HEALTHY)) {
  const problems = scriptProblems({ title: name, scenes }, 60);
  check(`здоровый сценарий проходит: ${name}`, problems.length === 0, problems.join(" | "));
}

// Обратная сторона: проверка, которая никогда не срабатывает, бесполезна.
// Тот самый сценарий, ради которого всё и делалось, обязан браковаться по
// всем четырём пунктам сразу.
const sick = {
  title: "t",
  scenes: [
    sc2("НЕЙРОСЕТИ ЖРУТ ЭНЕРГИЮ", "Нейросети потребляют много энергии, и это стало проблемой."),
    sc2("1287 МЕГАВАТТ-ЧАСОВ", "GPT-3 за одно обучение потребляет 1287 мегаватт-часов электричества."),
    sc2("НЕПРОСТАЯ ЗАДАЧА", "Инженеры и учёные ищут способы. Это непростая задача."),
    sc2("ЗАГЛЯНИ", "Наш бот умеет фото и видео. Загляни по ссылке, там много интересного."),
  ],
};
const sickProblems = scriptProblems(sick, 60);
for (const key of ["яркая цифра", "кончается ничем", "слабый призыв", "устаревшие примеры"]) {
  check(`больной сценарий всё ещё бракуется: ${key}`, sickProblems.some((p) => p.includes(key)));
}

process.exit(fails === 0 ? 0 : 1);
