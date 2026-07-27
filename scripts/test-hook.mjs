// Проверка обязательного хука: валидатор первой сцены и одна переписка через
// generateScriptWithHook. Сеть не нужна — OpenRouter подменяется на локальную
// заглушку, которая по очереди отдаёт заготовленные ответы.
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

process.env.OPENROUTER_API_KEY ??= "test-key";
process.env.KIE_API_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { hookProblem, generateScriptWithHook } = await import(
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

console.log("\n=== переписывание слабого хука ===");
const weakScript = {
  title: "Про нейросети",
  scenes: [
    { caption: "ПРИВЕТ!", voiceoverText: "Привет, друзья! Сегодня расскажу про нейросети." },
    { caption: "ВСЁ В ОДНОМ БОТЕ", voiceoverText: "Все модели в одном месте." },
    { caption: "ЖМИ ССЫЛКУ", voiceoverText: "Переходи по ссылке в описании." },
  ],
};
const strongScript = {
  title: "Про нейросети",
  scenes: [
    { caption: "ПЛАТИШЬ ПЯТЬ РАЗ", voiceoverText: "Ты платишь пяти сервисам за одно и то же." },
    { caption: "ВСЁ В ОДНОМ БОТЕ", voiceoverText: "Все модели в одном месте." },
    { caption: "ЖМИ ССЫЛКУ", voiceoverText: "Переходи по ссылке в описании." },
  ],
};

let requests = [];
const queue = [];
globalThis.fetch = async (url, init) => {
  requests.push(JSON.parse(init.body));
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(queue.shift()) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

queue.push(weakScript, strongScript);
requests = [];
const rewritten = await generateScriptWithHook("Продукт: нейросети в Телеграм.");
check("сделано два запроса", requests.length === 2, String(requests.length));
check("хук заменён", rewritten.script.scenes[0].caption === "ПЛАТИШЬ ПЯТЬ РАЗ", rewritten.script.scenes[0].caption);
check("причина сообщена наружу", rewritten.hookFixed?.includes("приветствия") === true, String(rewritten.hookFixed));
check(
  "в правку попала причина и запрет менять остальное",
  requests[1].messages.at(-1).content.includes("ТОЛЬКО первую сцену") &&
    requests[1].messages.at(-1).content.includes("приветствия"),
  requests[1].messages.at(-1).content,
);
check(
  "остальные сцены не потерялись",
  rewritten.script.scenes.length === 3 && rewritten.script.scenes[2].caption === "ЖМИ ССЫЛКУ",
);

queue.length = 0;
queue.push(strongScript);
requests = [];
const asIs = await generateScriptWithHook("Продукт: нейросети в Телеграм.");
check("хороший хук не переписывается", requests.length === 1, String(requests.length));
check("флаг правки не выставлен", asIs.hookFixed === undefined, String(asIs.hookFixed));

// Даже если модель со второй попытки снова принесла слабый хук, отдаём
// сценарий, а не падаем: пустой результат хуже слабого.
queue.length = 0;
queue.push(weakScript, weakScript);
requests = [];
const stillWeak = await generateScriptWithHook("Продукт: нейросети в Телеграм.");
check("после двух попыток сценарий всё равно есть", stillWeak.script.scenes.length === 3);
check("вторая попытка не зациклилась", requests.length === 2, String(requests.length));

console.log("\n=== промпт требует хук ===");
const prompt = requests[0].messages[0].content;
check("в промпте есть блок про хук", prompt.includes("ПЕРВАЯ СЦЕНА — ХУК"));
check("приветствия запрещены прямо в промпте", prompt.includes("НИКАКИХ приветствий"));
check("лимит слов назван", /не больше 12 слов/i.test(prompt), prompt.match(/не больше 12 слов.{0,24}/i)?.[0]);

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
