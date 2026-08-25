import { config } from "./config";

/**
 * Клиент Zernio — привязка аккаунтов соцсетей.
 *
 * Пока только ПРИВЯЗКА: список профилей, список подключённых аккаунтов, ссылка
 * на подключение и отключение. Публикацию сюда не тащим — её просили сделать
 * отдельно, и смешивать эти две вещи в одном заходе не стоит: привязку можно
 * проверить руками сегодня, а публикация тянет за собой расписание, лимиты
 * площадок и разбор ошибок постинга.
 *
 * КОНТРАКТ ВЗЯТ ИЗ ПЕРВОИСТОЧНИКА, а не угадан. Сам сайт zernio.com и
 * docs.zernio.com из этой среды закрыты сетевой политикой (403 на CONNECT),
 * поэтому спецификация прочитана из официальных SDK на GitHub —
 * zernio-dev/zernio-go и zernio-dev/zernio-python, где лежит openapi.yaml.
 * Оттуда же взяты база, схема авторизации и перечень платформ.
 */

export const ZERNIO_BASE_URL = "https://zernio.com/api";

/**
 * Площадки, которые Zernio умеет подключать. Список из openapi.yaml, поле
 * `platform` эндпоинта /v1/connect/{platform}.
 *
 * ВАЖНО: ВКонтакте в этом списке НЕТ. VK Клипы — одна из наших целевых
 * площадок, и её придётся публиковать иначе. Здесь список ровно тот, что
 * заявлен, без додумывания.
 */
export const ZERNIO_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "tiktok",
  "youtube",
  "threads",
  "reddit",
  "pinterest",
  "bluesky",
  "googlebusiness",
  "telegram",
  "snapchat",
  "discord",
  "slack",
  "whatsapp",
] as const;

export type ZernioPlatform = (typeof ZERNIO_PLATFORMS)[number];

/** Площадки, ради которых мы это делаем, — их показываем первыми. */
export const PRIMARY_PLATFORMS: ZernioPlatform[] = [
  "instagram",
  "youtube",
  "tiktok",
  "telegram",
];

export interface ZernioProfile {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ZernioAccount {
  id: string;
  platform: string;
  username?: string;
  displayName?: string;
  profileUrl?: string;
  isActive: boolean;
  /** Площадка сообщила, что токен мёртв: нужно подключить заново. */
  needsReconnection: boolean;
}

export function isZernioConfigured(): boolean {
  return Boolean(config.zernioApiKey);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!config.zernioApiKey) {
    throw new Error(
      "Не задан ZERNIO_API_KEY. Ключ кладётся в .env на сервере, в репозиторий он не попадает.",
    );
  }

  const response = await fetch(`${ZERNIO_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.zernioApiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Ключ в сообщение не попадает никогда: оно уходит в чат, а иногда и в
    // логи. Показываем код и ответ сервиса, этого достаточно для разбора.
    throw new Error(zernioErrorText(response.status, text));
  }
  return (await response.json()) as T;
}

/**
 * Человеческое объяснение вместо голого кода. Отдельной функцией, чтобы
 * проверять её без сети: формулировки — половина пользы от интеграции.
 */
export function zernioErrorText(status: number, body: string): string {
  const parsed = parseZernioError(body);
  // Голый JSON в чате — это не сообщение об ошибке, а свалка. Он приходил
  // обрезанным на полуслове («…"current»), тянул за собой карточку ссылки на
  // документацию и занимал полэкрана, а главное — не отвечал на вопрос «что
  // мне теперь делать». Если сервис прислал разбираемый ответ, показываем его
  // словами; сырой хвост оставляем только когда разобрать нечего.
  const said = parsed.message ? ` Сервис говорит: ${parsed.message}` : "";
  const tail = parsed.message
    ? ""
    : body
      ? ` Ответ сервиса: ${body.slice(0, 200)}`
      : "";

  switch (status) {
    case 401:
      return "Zernio не принял ключ (401). Проверьте ZERNIO_API_KEY в .env на сервере.";
    case 402:
      return paymentRequiredText(parsed);
    case 403:
      return `Zernio отказал в доступе (403) — возможно, тариф не включает эту возможность.${said}${tail}`;
    case 404:
      return `Zernio не нашёл объект (404) — профиль или аккаунт уже удалён.${said}${tail}`;
    case 409:
      return `Zernio: конфликт (409) — аккаунт уже подключён к другому профилю.${said}${tail}`;
    case 429:
      return "Zernio ограничил частоту запросов (429). Попробуйте через минуту.";
    default:
      return `Zernio вернул ошибку ${status}.${said}${tail}`;
  }
}

interface ZernioErrorBody {
  message?: string;
  reason?: string;
  /** Сколько аккаунтов разрешено на бесплатном тарифе. */
  accountLimit?: number;
  dashboardUrl?: string;
}

/**
 * Разбор ответа Zernio об ошибке. Ответ структурный (error, code, reason,
 * details, dashboard_url), и грех этим не воспользоваться — но полагаться на
 * него нельзя: сервис вправе ответить и HTML-страницей.
 */
export function parseZernioError(body: string): ZernioErrorBody {
  try {
    const data = JSON.parse(body) as {
      error?: string;
      message?: string;
      reason?: string;
      dashboard_url?: string;
      details?: { free_tier_account_limit?: number };
    };
    return {
      message: data.error ?? data.message,
      reason: data.reason,
      accountLimit: data.details?.free_tier_account_limit,
      dashboardUrl: data.dashboard_url,
    };
  } catch {
    return {};
  }
}

/**
 * 402 — это не поломка, а упёршийся лимит тарифа, и ответ должен быть про
 * выбор, а не про код ошибки. Выборов ровно два: платить или освободить место.
 */
function paymentRequiredText(parsed: ZernioErrorBody): string {
  const limit = parsed.accountLimit;
  const where = parsed.dashboardUrl ?? "https://zernio.com/dashboard/billing";
  return (
    "Zernio не даёт подключить ещё один аккаунт: упёрлись в бесплатный тариф" +
    (limit ? ` (в нём ${limit} аккаунта)` : "") +
    ".\n\nВыбор такой:\n" +
    "1. Привязать карту в кабинете Zernio — " +
    where +
    " — и подключать сколько нужно.\n" +
    "2. Освободить место: /accounts покажет подключённые, /unlink отвяжет " +
    "лишний. Отвязка ничего не удаляет в самой соцсети.\n\n" +
    "Уже подключённые аккаунты работают как работали — публикацию это не " +
    "ломает." +
    (parsed.message ? `\n\nСервис говорит: ${parsed.message}` : "")
  );
}

/** Профили Zernio: аккаунты подключаются внутрь профиля. */
export async function listProfiles(): Promise<ZernioProfile[]> {
  const data = await request<{
    profiles?: { _id: string; name?: string; isDefault?: boolean }[];
  }>("/v1/profiles");
  return (data.profiles ?? []).map((p) => ({
    id: p._id,
    name: p.name ?? "без имени",
    isDefault: Boolean(p.isDefault),
  }));
}

/**
 * Профиль, в который подключаем. Явно заданный в .env имеет приоритет —
 * иначе берём профиль по умолчанию, а если и его нет, первый в списке.
 */
export async function resolveProfileId(): Promise<string> {
  if (config.zernioProfileId) return config.zernioProfileId;
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    throw new Error(
      "В Zernio нет ни одного профиля — создайте его в личном кабинете, " +
        "аккаунты подключаются внутрь профиля.",
    );
  }
  return (profiles.find((p) => p.isDefault) ?? profiles[0]).id;
}

/** Подключённые аккаунты. */
export async function listAccounts(
  profileId?: string,
): Promise<ZernioAccount[]> {
  const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
  const data = await request<{
    accounts?: {
      _id: string;
      platform: string;
      username?: string;
      displayName?: string;
      profileUrl?: string;
      isActive?: boolean;
      needsReconnection?: boolean;
    }[];
  }>(`/v1/accounts${query}`);
  return (data.accounts ?? []).map((a) => ({
    id: a._id,
    platform: a.platform,
    username: a.username,
    displayName: a.displayName,
    profileUrl: a.profileUrl,
    isActive: a.isActive !== false,
    needsReconnection: Boolean(a.needsReconnection),
  }));
}

/**
 * Ссылка, по которой человек подключает свой аккаунт.
 *
 * `headless` не трогаем: в этом режиме Zernio отдаёт сырые данные OAuth и
 * ждёт, что выбор страницы или организации мы нарисуем сами. У нас нет
 * веб-интерфейса, только чат, поэтому пусть выбор рисует Zernio.
 */
export async function connectUrl(
  platform: ZernioPlatform,
  profileId: string,
  redirectUrl?: string,
): Promise<string> {
  const params = new URLSearchParams({ profileId });
  if (redirectUrl) params.set("redirect_url", redirectUrl);
  const data = await request<{ authUrl?: string }>(
    `/v1/connect/${encodeURIComponent(platform)}?${params.toString()}`,
  );
  if (!data.authUrl) {
    throw new Error("Zernio не вернул ссылку для подключения (authUrl пуст).");
  }
  return data.authUrl;
}

/** Отключает аккаунт. */
export async function disconnectAccount(accountId: string): Promise<void> {
  await request(`/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}

/** Название площадки для чата. */
export function platformTitle(platform: string): string {
  const titles: Record<string, string> = {
    facebook: "Facebook",
    instagram: "Instagram",
    linkedin: "LinkedIn",
    twitter: "X (Twitter)",
    tiktok: "TikTok",
    youtube: "YouTube",
    threads: "Threads",
    reddit: "Reddit",
    pinterest: "Pinterest",
    bluesky: "Bluesky",
    googlebusiness: "Google Business",
    telegram: "Telegram",
    snapchat: "Snapchat",
    discord: "Discord",
    slack: "Slack",
    whatsapp: "WhatsApp",
  };
  return titles[platform] ?? platform;
}

/** Строка про аккаунт для списка в чате. */
export function accountLine(account: ZernioAccount): string {
  const who = account.username
    ? `@${account.username}`
    : account.displayName ?? account.id;
  const mark = account.needsReconnection
    ? " ⚠️ нужна повторная привязка"
    : account.isActive
      ? ""
      : " (выключен)";
  return `${platformTitle(account.platform)}: ${who}${mark}`;
}
