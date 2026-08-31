// Темы дня: запрос к OpenRouter на моке и отсев уже снятого.
//
// Сеть не трогаем — подменяем fetch. Проверять надо не модель, а нас: что в
// запрос уходит список снятых тем, что ответ разбирается, что при отказе
// веб-поиска мы говорим об этом вслух, и что похожая тема не проходит дважды.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const { suggestNewsTopics, isFreshTopic, topicBrief } = await import(
  "../src/pipeline/newsTopics.ts"
);

const TOPICS = {
  topics: [
    { title: "Sora научилась звуку", what: "видео теперь со звуком", why: "можно снять клип целиком" },
    { title: "Midjourney v8 держит одного персонажа", what: "лицо не плывёт между кадрами", why: "комикс одним героем" },
  ],
};

let requests = [];
let httpStatus = 200;
let body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(TOPICS) } }] });
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  return new Response(body, {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
};

console.log("=== запрос к модели ===");
let result = await suggestNewsTopics([]);
check("темы разобраны", result.topics.length === 2, String(result.topics.length));
check("заголовок на месте", result.topics[0].title === "Sora научилась звуку");
check("деталь события сохранена", result.topics[0].what === "видео теперь со звуком");
check("веб-поиск включён", Array.isArray(requests[0].plugins) && requests[0].plugins[0].id === "web");
check("ответ просим строгим JSON", requests[0].response_format?.type === "json_object");
check("про повторы в чистом запросе не сказано", !/УЖЕ СНИМАЛИ/.test(requests[0].messages[0].content));

console.log("\n=== снятые темы уходят запретом ===");
requests = [];
await suggestNewsTopics(["Нейросети рисуют картинки", "Как нейросети делают контент"]);
const prompt = requests[0].messages[0].content;
check("список снятого попал в запрос", /УЖЕ СНИМАЛИ/.test(prompt));
check("и сами темы перечислены", /Нейросети рисуют картинки/.test(prompt) && /делают контент/.test(prompt));
check("вечнозелёные темы запрещены прямо в промпте", /топ-5 сервисов/.test(prompt));
check("требуется деталь, а не «вышла новая модель»", /деталь, которую можно проверить/.test(prompt));
check("тема обязана вести к продукту", /ВЕСТИ К ПРОДУКТУ/.test(prompt));

console.log("\n=== веб-поиск не сработал ===");
requests = [];
let calls = 0;
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  calls++;
  // Первый запрос (с плагином) падает, второй — без плагина — проходит.
  const ok = calls > 1;
  return new Response(
    ok ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(TOPICS) } }] }) : "нет",
    { status: ok ? 200 : 404, headers: { "content-type": "application/json" } },
  );
};
result = await suggestNewsTopics([]);
check("темы всё равно получены", result.topics.length === 2);
check("повтор ушёл без плагина", requests.length === 2 && requests[1].plugins === undefined);
check(
  "про несвежесть сказано наружу, а не проглочено",
  result.webSearchUnavailable === true,
);

console.log("\n=== ответ без тем — честная ошибка ===");
globalThis.fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{"topics":[]}' } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
let failed = false;
try {
  await suggestNewsTopics([]);
} catch (error) {
  failed = /Тем в ответе/.test(error.message);
}
check("пустой список не выдаётся за результат", failed);

console.log("\n=== не снимаем одно и то же дважды ===");
const used = [
  "Нейросети рисуют картинки за секунды",
  "Sora научилась звуку",
];
check(
  "та же тема другими окончаниями — не свежая",
  isFreshTopic("Sora научилась звукам и музыке", used) === false,
);
check(
  "перестановка слов не спасает",
  isFreshTopic("Звук в Sora: научилась", used) === false,
);
check("новая тема проходит", isFreshTopic("Midjourney держит одного персонажа", used) === true);
check(
  "общее слово «нейросети» не делает тему повтором",
  isFreshTopic("Нейросети научились считать деньги в Excel", ["Нейросети рисуют картинки за секунды"]) === true,
);
check("пустая история — всё свежее", isFreshTopic("Что угодно", []) === true);
check("пустая тема не роняет проверку", isFreshTopic("", used) === true);

console.log("\n=== бриф из темы ===");
const brief = topicBrief(TOPICS.topics[0]);
check("в бриф попал заголовок", brief.includes("Sora научилась звуку"));
check("и деталь события", brief.includes("видео теперь со звуком"));
check("и чем цепляет", brief.includes("можно снять клип целиком"));
check(
  "без деталей бриф не разваливается",
  topicBrief({ title: "Только заголовок", what: "", why: "" }) === "Только заголовок",
);

console.log("\n=== память снятых тем ===");
const { rememberShotTopic, listShotTopics, forgetShotTopics, forgetShotTopic } =
  await import("../src/bot/state.ts");
const chat = -777001;
forgetShotTopics(chat);
rememberShotTopic(chat, "Первая тема");
rememberShotTopic(chat, "Вторая тема");
check("новые темы идут первыми", listShotTopics(chat)[0] === "Вторая тема", listShotTopics(chat).join(" | "));
rememberShotTopic(chat, "первая ТЕМА");
check(
  "повтор той же темы не плодит дублей",
  listShotTopics(chat).length === 2,
  listShotTopics(chat).join(" | "),
);
check("и поднимается наверх", listShotTopics(chat)[0] === "первая ТЕМА");
rememberShotTopic(chat, "   ");
check("пустая тема не запоминается", listShotTopics(chat).length === 2);
console.log("\n=== вернуть одну тему в подбор ===");
// Тема запоминается сразу при выборе, а не после сборки. Обратная сторона
// нашлась в работе: ролик не доснят, идея понравилась, а тема уже занята.
// Стирать ради этого всю память — терять защиту от повторов за два месяца.
forgetShotTopics(chat);
for (const t of ["Старая тема", "Средняя тема", "Свежая тема"]) rememberShotTopic(chat, t);
check("без аргумента возвращается последняя", forgetShotTopic(chat) === "Свежая тема");
check("остальные на месте", listShotTopics(chat).length === 2, listShotTopics(chat).join(" | "));
check("и порядок не сбился", listShotTopics(chat)[0] === "Средняя тема");
check("по номеру из списка", forgetShotTopic(chat, 1) === "Старая тема");
rememberShotTopic(chat, "Почему нейросеть рисует шесть пальцев");
check("по части названия", forgetShotTopic(chat, "шесть пальцев") === "Почему нейросеть рисует шесть пальцев");
check("регистр не важен", (() => {
  rememberShotTopic(chat, "Токены и деньги");
  return forgetShotTopic(chat, "ТОКЕНЫ") === "Токены и деньги";
})());
check("чего нет — не возвращается", forgetShotTopic(chat, "такого не было") === undefined);
check("номер за пределами списка — тоже", forgetShotTopic(chat, 99) === undefined);
check("пустая память не роняет", forgetShotTopic(-777002) === undefined);

forgetShotTopics(chat);
check("сброс очищает память", listShotTopics(chat).length === 0);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
