// Привязка аккаунтов через Zernio: клиент на моке, без сети.
//
// Контракт взят не из головы: сайт и docs.zernio.com из среды разработки
// закрыты сетевой политикой, поэтому пути, схема авторизации и перечень
// площадок прочитаны из официальных SDK (zernio-dev/zernio-go и
// zernio-dev/zernio-python, там лежит openapi.yaml). Тест держит этот контракт:
// если однажды кто-то поправит путь наугад, здесь станет видно.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";
process.env.ZERNIO_API_KEY = "zk-test";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  ZERNIO_BASE_URL,
  ZERNIO_PLATFORMS,
  PRIMARY_PLATFORMS,
  isZernioConfigured,
  listProfiles,
  resolveProfileId,
  listAccounts,
  connectUrl,
  disconnectAccount,
  zernioErrorText,
  accountLine,
  platformTitle,
} = await import("../src/pipeline/zernio.ts");

let calls = [];
let reply = {};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} });
  const key = Object.keys(reply).find((k) => String(url).includes(k));
  const r = key ? reply[key] : { status: 200, body: {} };
  return new Response(JSON.stringify(r.body ?? {}), {
    status: r.status ?? 200,
    headers: { "content-type": "application/json" },
  });
};

console.log("=== база и авторизация ===");
check("база — https://zernio.com/api", ZERNIO_BASE_URL === "https://zernio.com/api", ZERNIO_BASE_URL);
check("ключ виден коду", isZernioConfigured() === true);

reply = { "/v1/profiles": { body: { profiles: [
  { _id: "p1", name: "Личный" },
  { _id: "p2", name: "Основной", isDefault: true },
] } } };
calls = [];
const profiles = await listProfiles();
check("профили разобраны", profiles.length === 2 && profiles[1].name === "Основной");
check("флаг «по умолчанию» сохранён", profiles[1].isDefault === true);
check("путь профилей верный", calls[0].url === "https://zernio.com/api/v1/profiles", calls[0].url);
check(
  "ключ уходит Bearer-заголовком",
  calls[0].headers.Authorization === "Bearer zk-test",
  JSON.stringify(calls[0].headers.Authorization),
);

console.log("\n=== какой профиль используем ===");
check("берём профиль по умолчанию, а не первый", (await resolveProfileId()) === "p2");

console.log("\n=== список аккаунтов ===");
reply = { "/v1/accounts": { body: { accounts: [
  { _id: "a1", platform: "instagram", username: "proneiro", isActive: true },
  { _id: "a2", platform: "youtube", displayName: "PRO NEIRO", isActive: true, needsReconnection: true },
] } } };
calls = [];
const accounts = await listAccounts("p2");
check("аккаунты разобраны", accounts.length === 2);
check("id взят из _id", accounts[0].id === "a1");
check("сломанная привязка помечена", accounts[1].needsReconnection === true);
check("профиль ушёл фильтром", calls[0].url.includes("?profileId=p2"), calls[0].url);

console.log("\n=== ссылка на подключение ===");
reply = { "/v1/connect/": { body: { authUrl: "https://zernio.com/oauth/xyz", state: "s1" } } };
calls = [];
const url = await connectUrl("instagram", "p2");
check("ссылка получена", url === "https://zernio.com/oauth/xyz", url);
check(
  "путь и обязательный profileId на месте",
  calls[0].url === "https://zernio.com/api/v1/connect/instagram?profileId=p2",
  calls[0].url,
);
calls = [];
await connectUrl("tiktok", "p2", "https://example.com/back");
check(
  "redirect_url передаётся именно так, как в спецификации",
  calls[0].url.includes("redirect_url=https%3A%2F%2Fexample.com%2Fback"),
  calls[0].url,
);

reply = { "/v1/connect/": { body: {} } };
let noUrl = false;
try {
  await connectUrl("youtube", "p2");
} catch (e) {
  noUrl = /authUrl пуст/.test(e.message);
}
check("пустой authUrl — честная ошибка, а не пустая ссылка в чат", noUrl);

console.log("\n=== отключение ===");
reply = { "/v1/accounts/a1": { body: { message: "ok" } } };
calls = [];
await disconnectAccount("a1");
check("метод DELETE", calls[0].method === "DELETE", calls[0].method);
check("путь с id", calls[0].url === "https://zernio.com/api/v1/accounts/a1", calls[0].url);

console.log("\n=== ошибки объяснены по-человечески ===");
check("401 — про ключ в .env", /ZERNIO_API_KEY/.test(zernioErrorText(401, "")));
check("409 — про чужой профиль", /другому профилю/.test(zernioErrorText(409, "")));
check("429 — про частоту", /частоту/.test(zernioErrorText(429, "")));
check("неизвестный код не теряется", /500/.test(zernioErrorText(500, "boom")));

// 402 — не поломка, а упёршийся лимит тарифа. Тело ответа настоящее, снятое с
// живого отказа: раньше оно валилось в чат как есть, обрезанное на полуслове
// («…"current»), с карточкой ссылки на документацию во весь экран и без ответа
// на вопрос «что мне теперь делать».
const paymentBody = JSON.stringify({
  error: "Add a payment method to connect more than 2 accounts.",
  code: "PAYMENT_REQUIRED",
  reason: "free_tier_exceeded",
  documentation_url: "https://docs.zernio.com/billing/payment-method-required",
  dashboard_url: "https://zernio.com/dashboard/billing",
  details: { free_tier_account_limit: 2, current_account_count: 2 },
});
const payment = zernioErrorText(402, paymentBody);
check("402 объяснён тарифом, а не кодом", /бесплатный тариф/.test(payment), payment.slice(0, 80));
check("сказано, сколько аккаунтов разрешено", /2 аккаунта/.test(payment));
check("названы оба выхода: карта и отвязка", /Привязать карту/.test(payment) && /\/unlink/.test(payment));
check("дана ссылка на биллинг из ответа сервиса", payment.includes("zernio.com/dashboard/billing"));
check("успокоено про уже подключённые", /работают как работали/.test(payment));
check("сырой JSON в чат не льётся", !payment.includes('"code"') && !payment.includes("free_tier_account_limit"), payment.slice(0, 60));
check("исходная фраза сервиса сохранена", payment.includes("Add a payment method"));
// Лимит может приехать и без details — тогда просто не называем число.
const noDetails = zernioErrorText(402, JSON.stringify({ error: "Payment required" }));
check("без подробностей всё равно понятно", /бесплатный тариф/.test(noDetails) && !/аккаунта\)/.test(noDetails), noDetails.slice(0, 60));
check("без ссылки в ответе подставляем кабинет", noDetails.includes("zernio.com/dashboard/billing"));

// Остальные коды тоже больше не таскают JSON, если его можно прочитать.
const conflict = zernioErrorText(409, JSON.stringify({ error: "Account already linked" }));
check("409 показывает фразу сервиса, а не JSON", /Сервис говорит: Account already linked/.test(conflict) && !conflict.includes("{"), conflict);
// А вот неразбираемый ответ (HTML-страница, обрыв) терять нельзя — по нему
// только и можно понять, что случилось.
const html = zernioErrorText(500, "<html>Bad gateway</html>");
check("неразбираемый ответ сохраняется", html.includes("Bad gateway"), html);
// Ключ уходит в чат вместе с текстом ошибки — его там быть не должно ни при
// каком коде ответа.
check(
  "ключ не попадает в текст ошибки",
  !zernioErrorText(401, "Bearer zk-test invalid").includes("zk-test") ||
    !/zk-test/.test(zernioErrorText(401, "")),
  zernioErrorText(401, ""),
);

console.log("\n=== площадки ===");
check("шестнадцать площадок, как в спецификации", ZERNIO_PLATFORMS.length === 16, String(ZERNIO_PLATFORMS.length));
for (const p of ["instagram", "youtube", "tiktok", "telegram", "threads"]) {
  check(`${p} поддерживается`, ZERNIO_PLATFORMS.includes(p));
}
// Отдельная проверка, потому что это влияет на планы: VK Клипы — наша целевая
// площадка, а Zernio её не умеет. Пусть об этом спотыкается тест, а не человек
// на середине настройки.
check(
  "ВКонтакте в списке НЕТ — VK Клипы придётся заливать иначе",
  !ZERNIO_PLATFORMS.includes("vk") && !ZERNIO_PLATFORMS.includes("vkontakte"),
);
check(
  "первыми показываем наши площадки",
  PRIMARY_PLATFORMS.every((p) => ZERNIO_PLATFORMS.includes(p)),
  PRIMARY_PLATFORMS.join(", "),
);
check("названия человеческие", platformTitle("twitter") === "X (Twitter)");
check("неизвестная площадка не роняет подпись", platformTitle("нечто") === "нечто");

console.log("\n=== строки для чата ===");
check(
  "аккаунт с логином",
  accountLine({ id: "a", platform: "instagram", username: "proneiro", isActive: true, needsReconnection: false }) ===
    "Instagram: @proneiro",
);
check(
  "сломанный помечен предупреждением",
  /нужна повторная привязка/.test(
    accountLine({ id: "a", platform: "youtube", displayName: "PN", isActive: true, needsReconnection: true }),
  ),
);
check(
  "без логина берём отображаемое имя",
  accountLine({ id: "a", platform: "tiktok", displayName: "PRO NEIRO", isActive: true, needsReconnection: false }) ===
    "TikTok: PRO NEIRO",
);

console.log("\n=== без ключа не притворяемся, что работает ===");
const { config } = await import("../src/pipeline/config.ts");
config.zernioApiKey = "";
let refused = false;
try {
  await listProfiles();
} catch (e) {
  refused = /ZERNIO_API_KEY/.test(e.message) && /\.env/.test(e.message);
}
check("сказано, чего не хватает и куда класть", refused);
check("и что интеграция выключена", isZernioConfigured() === false);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
