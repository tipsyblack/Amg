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

const { hookProblem, promoProblem, generateCheckedScript } = await import(
  "../src/pipeline/generateScript.ts"
);

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
    "современные нейросетевые модели в повседневных рабочих задачах",
};
check("слишком длинный хук отклонён", hookProblem(long)?.includes("слов") === true, String(hookProblem(long)));

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
check("лимит слов назван", /не больше 12 слов/i.test(prompt), prompt.match(/не больше 12 слов.{0,24}/i)?.[0]);
check("сказано, что ролик не рекламный", prompt.includes("ЭТО НЕ РЕКЛАМНЫЙ РОЛИК"));
check("продукт разрешён только в финале", prompt.includes("кроме последней"));
check("требуется конкретика, а не общие слова", prompt.includes("Пиши конкретно"));
check("запрещено выдумывать цифры", prompt.includes("не выдумывай"));

console.log("\n=== визуальный акцент на первой сцене ===");
const { sceneMotion } = await import("../src/remotion/transitions.ts");
check("у хука своё движение", sceneMotion(0).emphasis === true);
check("хук наезжает, а не проявляется", sceneMotion(0).entry === "punch", sceneMotion(0).entry);
check("у остальных сцен акцента нет", [1, 2, 3, 4, 5, 6, 7].every((i) => !sceneMotion(i).emphasis));
check("движение по-прежнему детерминировано", sceneMotion(1).entry === sceneMotion(7).entry);

const { existsSync, statSync } = await import("node:fs");
check("звук хука в репозитории", existsSync("public/sfx/hook.wav"));
check("звук хука не пустой", existsSync("public/sfx/hook.wav") && statSync("public/sfx/hook.wav").size > 1000);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
