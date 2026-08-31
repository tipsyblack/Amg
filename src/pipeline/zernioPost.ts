import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { ZERNIO_BASE_URL, zernioErrorText, type ZernioAccount } from "./zernio";

/**
 * Публикация ролика через Zernio.
 *
 * Контракт, как и у привязки, прочитан из openapi.yaml в официальном SDK
 * (zernio-dev/zernio-python): сам сервис из среды разработки закрыт сетевой
 * политикой.
 *
 * Порядок такой:
 *  1. файл заливается в хранилище Zernio (presign → PUT → публичная ссылка);
 *  2. текст и настройки прогоняются через их же проверку (dry-run), которая
 *     ловит нарушения форматов ДО публикации;
 *  3. создаётся пост — сразу или на время;
 *  4. состояние и ошибки читаются по каждой площадке отдельно.
 */

/** Ролик, который публикуем. */
export interface PostVideo {
  /** Путь к файлу НА СЕРВЕРЕ. */
  file: string;
  /** Заголовок ролика — из сценария. */
  title: string;
  /** Текст под пост. */
  description: string;
}

// Заголовок YouTube по их же спецификации не длиннее 100 символов, и это
// жёсткий предел: длиннее — отказ при публикации, а не молчаливое обрезание.
const YOUTUBE_TITLE_MAX = 100;

/**
 * Настройки под каждую площадку.
 *
 * Здесь же честные пометки об ИИ. Ролики целиком синтетические: картинки
 * нарисованы моделью, голос синтезирован. И YouTube, и Instagram требуют это
 * помечать, и оба умеют пометить сами, если заметят. Поэтому ставим флаги
 * сразу: правило площадки, а не наша осторожность, и лучше пометка от нас,
 * чем санкция от них.
 */
export interface PostOptions {
  /**
   * Отдать ролик в Creator Inbox вместо прямой публикации.
   *
   * Нужен, когда у TikTok очередь на прямую публикацию («direct posting is at
   * capacity»). Поле подтверждено по их openapi.yaml (TikTokPlatformData.draft):
   * ролик приходит в приложение уведомлением, и человек дописывает пост сам.
   * Там же оговорка про права: для черновика аккаунту нужен video.upload, для
   * прямой публикации — video.publish. Аккаунт, привязанный только под прямую
   * публикацию, черновик может не принять.
   */
  tiktokDraft?: boolean;
}

export function platformOptions(
  platform: string,
  video: PostVideo,
  options: PostOptions = {},
): Record<string, unknown> | undefined {
  switch (platform) {
    case "youtube":
      return {
        title: trimTitle(video.title, YOUTUBE_TITLE_MAX),
        visibility: "public",
        // Отдельный флаг COPPA. YouTube пишет, что без явного значения может
        // ограничить показы, поэтому ставим явно: контент не детский.
        madeForKids: false,
        containsSyntheticMedia: true,
        // 22 — «Люди и блоги», значение по умолчанию у самого Zernio. Ставим
        // явно, чтобы не зависеть от их дефолта.
        categoryId: "22",
      };
    case "instagram":
      return {
        // Reels, а не лента: ролик вертикальный и со звуком.
        shareToFeed: true,
        isAiGenerated: true,
      };
    case "tiktok":
      return {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        ...(options.tiktokDraft ? { draft: true } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * Заголовок под предел площадки. Режем по границе слова: обрубленное посреди
 * слова название выглядит как сбой, а не как сокращение.
 */
export function trimTitle(title: string, max: number): string {
  const clean = title.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

async function request<T>(
  endpoint: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  if (!config.zernioApiKey) {
    throw new Error(
      "Не задан ZERNIO_API_KEY. Ключ кладётся в .env на сервере (/setkey).",
    );
  }
  const response = await fetch(`${ZERNIO_BASE_URL}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.zernioApiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(postErrorText(response.status, text));
  }
  return (await response.json()) as T;
}

/**
 * Ошибки публикации поверх общих. 409 здесь означает не «занято», а защиту от
 * двойной публикации — и объяснить это надо словами, иначе выглядит поломкой.
 */
export function postErrorText(status: number, body: string): string {
  if (status === 409) {
    return (
      "Zernio отклонил как повтор (409): такой же ролик с таким же текстом " +
      "уже уходил на эту площадку за последние 24 часа. Это их защита от " +
      "двойной публикации. Поменяйте текст поста — или, если это правда " +
      "другой ролик, проверьте, не отправился ли предыдущий дважды." +
      (body ? `\n\nОтвет сервиса: ${body.slice(0, 300)}` : "")
    );
  }
  if (status === 413) {
    return "Файл слишком большой для Zernio (413). Предел — 5 ГБ на файл.";
  }
  return zernioErrorText(status, body);
}

/**
 * Заливает файл и возвращает публичную ссылку.
 *
 * Через presign, а не через upload-direct: у второго предел 25 МБ и файлы
 * живут 7 дней, а presign держит до 5 ГБ. Наши ролики укладываются и в 25 МБ,
 * но запас нужен: включённое оживление кадров легко выводит за него.
 */
export async function uploadVideo(file: string): Promise<string> {
  const filename = path.basename(file);
  const bytes = await readFile(file);

  const { uploadUrl, publicUrl } = await request<{
    uploadUrl?: string;
    publicUrl?: string;
  }>("/v1/media/presign", {
    method: "POST",
    body: JSON.stringify({
      filename,
      contentType: "video/mp4",
      size: bytes.byteLength,
    }),
  });
  if (!uploadUrl || !publicUrl) {
    throw new Error("Zernio не вернул ссылки для загрузки файла.");
  }

  // PUT идёт в хранилище, а не в Zernio: ключ сюда не отправляем, ссылка уже
  // подписана.
  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: new Uint8Array(bytes),
    headers: { "Content-Type": "video/mp4" },
  });
  if (!put.ok) {
    throw new Error(
      `Файл не залился в хранилище (${put.status}). Ссылка на загрузку живёт час — попробуйте ещё раз.`,
    );
  }
  return publicUrl;
}

export interface PostTarget {
  platform: string;
  accountId: string;
}

interface PostBody {
  title: string;
  content: string;
  mediaItems: { type: string; url: string; filename?: string }[];
  platforms: {
    platform: string;
    accountId: string;
    platformSpecificData?: Record<string, unknown>;
  }[];
  publishNow?: boolean;
  scheduledFor?: string;
  timezone?: string;
}

/** Тело запроса. Отдельно от отправки, чтобы проверять его без сети. */
export function buildPostBody(
  video: PostVideo,
  videoUrl: string,
  targets: PostTarget[],
  when: { publishNow: true } | { scheduledFor: string; timezone: string },
  options: PostOptions = {},
): PostBody {
  return {
    title: video.title,
    content: video.description,
    mediaItems: [
      { type: "video", url: videoUrl, filename: path.basename(video.file) },
    ],
    platforms: targets.map((t) => ({
      platform: t.platform,
      accountId: t.accountId,
      platformSpecificData: platformOptions(t.platform, video, options),
    })),
    ...when,
  };
}

export interface ValidationProblem {
  platform?: string;
  message: string;
}

/**
 * Прогон без публикации: их же проверка форматов.
 *
 * Зачем это вместо своих правил: пределы площадок меняются, и повторять их у
 * себя — значит однажды разойтись с реальностью и получить отказ уже после
 * загрузки файла. Проверка на их стороне всегда свежее нашей.
 */
export async function validatePost(
  body: PostBody,
): Promise<{ errors: ValidationProblem[]; warnings: ValidationProblem[] }> {
  const result = await request<{
    errors?: (string | { platform?: string; message?: string })[];
    warnings?: (string | { platform?: string; message?: string })[];
  }>("/v1/tools/validate/post", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    errors: (result.errors ?? []).map(toProblem),
    warnings: (result.warnings ?? []).map(toProblem),
  };
}

function toProblem(
  item: string | { platform?: string; message?: string },
): ValidationProblem {
  if (typeof item === "string") return { message: item };
  return { platform: item.platform, message: item.message ?? JSON.stringify(item) };
}

export interface PostPlatformState {
  platform: string;
  status: string;
  url?: string;
  errorMessage?: string;
  errorCategory?: string;
  errorSource?: string;
}

export interface PostState {
  id: string;
  status: string;
  scheduledFor?: string;
  platforms: PostPlatformState[];
}

function toState(post: Record<string, unknown>): PostState {
  const platforms = (post.platforms as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: String(post._id ?? ""),
    status: String(post.status ?? "unknown"),
    scheduledFor: post.scheduledFor ? String(post.scheduledFor) : undefined,
    platforms: platforms.map((p) => ({
      platform: String(p.platform ?? "?"),
      status: String(p.status ?? "?"),
      url: p.platformPostUrl ? String(p.platformPostUrl) : undefined,
      errorMessage: p.errorMessage ? String(p.errorMessage) : undefined,
      errorCategory: p.errorCategory ? String(p.errorCategory) : undefined,
      errorSource: p.errorSource ? String(p.errorSource) : undefined,
    })),
  };
}

/**
 * Создаёт пост.
 *
 * `x-request-id` обязателен по смыслу, хотя и не по схеме: без него повтор
 * запроса после обрыва связи создаст ВТОРОЙ пост. С ним Zernio за пять минут
 * узнаёт повтор и возвращает исходный.
 */
export async function createPost(
  video: PostVideo,
  videoUrl: string,
  targets: PostTarget[],
  when: { publishNow: true } | { scheduledFor: string; timezone: string },
  options: PostOptions = {},
): Promise<PostState> {
  const body = buildPostBody(video, videoUrl, targets, when, options);
  const data = await request<{ post?: Record<string, unknown>; existingPost?: Record<string, unknown> }>(
    "/v1/posts",
    { method: "POST", body: JSON.stringify(body) },
    { "x-request-id": randomUUID() },
  );
  const post = data.post ?? data.existingPost;
  if (!post) throw new Error("Zernio не вернул созданный пост.");
  return toState(post);
}

export async function getPost(postId: string): Promise<PostState> {
  const data = await request<{ post?: Record<string, unknown> }>(
    `/v1/posts/${encodeURIComponent(postId)}`,
  );
  if (!data.post) throw new Error("Zernio не вернул пост.");
  return toState(data.post);
}

export async function retryPost(postId: string): Promise<PostState> {
  const data = await request<{ post?: Record<string, unknown> }>(
    `/v1/posts/${encodeURIComponent(postId)}/retry`,
    { method: "POST" },
  );
  if (!data.post) throw new Error("Zernio не вернул пост после повтора.");
  return toState(data.post);
}

/**
 * Что делать с ошибкой площадки.
 *
 * Категории приходят от Zernio, а перевод в действие — наш: голое
 * `platform_rejected` человеку ничего не говорит, а «площадка сочла это
 * нарушением правил» говорит.
 */
export function explainPostError(state: PostPlatformState): string {
  const what: Record<string, string> = {
    auth_expired:
      "доступ к аккаунту отозван — привяжите заново: /link",
    user_content:
      "площадке не подошёл формат или длина — проверьте текст и сам файл",
    user_abuse:
      "сработали ограничения площадки на частоту — подождите и повторите: /retrypost",
    account_issue:
      "проблема в настройках аккаунта на самой площадке (права, тип профиля)",
    platform_rejected:
      "площадка сочла это нарушением своих правил — текст или ролик придётся менять",
    platform_error:
      "сбой на стороне площадки — обычно лечится повтором позже: /retrypost",
    system_error:
      "сбой на стороне Zernio — повторите: /retrypost",
  };
  // Сообщение сильнее категории, и это не теория. Живой отказ TikTok:
  // категория user_content («не подошёл формат или длина»), а в сообщении —
  // «direct posting is at capacity right now», то есть у площадки очередь и
  // наш файл ни при чём. Мы честно пересказывали категорию и отправляли
  // человека проверять ролик, в котором нечего чинить.
  const known = knownFailure(state.errorMessage ?? "");
  const advice = known ?? what[state.errorCategory ?? ""] ?? "причина не названа";
  const detail = state.errorMessage ? `\n   ${state.errorMessage}` : "";
  return `${advice}${detail}`;
}

/**
 * Отказы, которые площадка объясняет словами лучше, чем Zernio — категорией.
 * Список короткий намеренно: сюда попадает только то, что мы видели живьём.
 */
function knownFailure(message: string): string | undefined {
  if (/at capacity/i.test(message) || /Creator Inbox/i.test(message)) {
    return (
      "у TikTok очередь на прямую публикацию — это временно и к нашему ролику " +
      "отношения не имеет. Повторить позже: /retrypost. Либо отдать ролик " +
      "черновиком в Creator Inbox: /publish draft — он придёт в приложение " +
      "уведомлением, останется нажать «опубликовать»"
    );
  }
  return undefined;
}

/** Готово ли всё: есть ли ещё что ждать. */
export function isSettled(state: PostState): boolean {
  return !state.platforms.some(
    (p) => p.status === "pending" || p.status === "publishing",
  );
}

/** Строки состояния для чата. */
export function postStateLines(state: PostState, title: (p: string) => string): string[] {
  return state.platforms.map((p) => {
    if (p.status === "published") {
      return `✅ ${title(p.platform)}${p.url ? `\n   ${p.url}` : ""}`;
    }
    if (p.status === "failed") {
      return `❌ ${title(p.platform)}: ${explainPostError(p)}`;
    }
    return `⏳ ${title(p.platform)}: ${p.status}`;
  });
}

/**
 * Смещение часового пояса в минутах в указанный момент.
 *
 * Считаем через Intl, а не по таблице: переход на летнее время меняет
 * смещение, и зашитое число однажды окажется неверным на час.
 */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Момент времени по стенным часам в заданном поясе.
 *
 * Прямого способа в стандартной библиотеке нет, поэтому берём приближение и
 * поправляем его на смещение пояса. Второй проход нужен для переходов на
 * летнее время: там смещение до и после поправки разное, и без второго шага
 * ошибка в час.
 */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hours: number; minutes: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours, parts.minutes);
  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000);
  instant = new Date(naive - zoneOffsetMinutes(instant, timeZone) * 60000);
  return instant;
}

/** Стенные часы в поясе для момента времени. */
export function zonedParts(
  at: Date,
  timeZone: string,
): { year: number; month: number; day: number; hours: number; minutes: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hours: get("hour") % 24,
    minutes: get("minute"),
  };
}

/**
 * Время публикации из «18:00» или «завтра 09:30».
 *
 * Время понимается в ЧАСОВОМ ПОЯСЕ КАНАЛА (POST_TIMEZONE), а не сервера.
 * Сервер почти наверняка живёт по UTC, и без этого «в шесть вечера» уехало бы
 * на три часа — ролик вышел бы ночью, а заметили бы это только по охватам.
 *
 * Если названное время уже прошло, имеется в виду завтра: «поставь на 9:00» в
 * десять утра — это про завтрашнее утро, а не про вчерашнее.
 */
export function parseWhen(
  input: string,
  timeZone: string = config.postTimezone,
  now: Date = new Date(),
): { scheduledFor: string; timezone: string } | { error: string } {
  const text = input.trim().toLowerCase();
  const tomorrow = /^завтра\s+/.test(text);
  const time = text.replace(/^завтра\s+/, "");
  const match = time.match(/^(\d{1,2})[:. ](\d{2})$/);
  if (!match) {
    return {
      error:
        "Не разобрал время. Формат: /schedule 18:00 или /schedule завтра 09:30",
    };
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return { error: `Такого времени не бывает: ${hours}:${match[2]}` };
  }

  const today = zonedParts(now, timeZone);
  let when = zonedTimeToUtc({ ...today, hours, minutes }, timeZone);
  if (tomorrow || when.getTime() <= now.getTime()) {
    const next = new Date(when.getTime() + 24 * 3600 * 1000);
    const nextParts = zonedParts(next, timeZone);
    when = zonedTimeToUtc({ ...nextParts, hours, minutes }, timeZone);
  }

  return { scheduledFor: when.toISOString(), timezone: timeZone };
}

/** Куда публикуем: только живые аккаунты. */
export function publishableTargets(accounts: ZernioAccount[]): PostTarget[] {
  return accounts
    .filter((a) => a.isActive && !a.needsReconnection)
    .map((a) => ({ platform: a.platform, accountId: a.id }));
}


/**
 * Уже запланированные публикации — чтобы отметить занятые дни в календаре.
 *
 * Сбой этого запроса не должен ломать календарь: отметки полезны, но без них
 * выбрать день по-прежнему можно. Поэтому ошибки здесь глотаются осознанно —
 * единственное место в этом файле, где так делается.
 */
export async function listScheduledDates(profileId?: string): Promise<string[]> {
  try {
    const query = new URLSearchParams({ status: "scheduled", limit: "200" });
    if (profileId) query.set("profileId", profileId);
    const data = await request<{ posts?: { scheduledFor?: string }[] }>(
      `/v1/posts?${query.toString()}`,
    );
    return (data.posts ?? [])
      .map((p) => p.scheduledFor)
      .filter((x): x is string => Boolean(x));
  } catch {
    return [];
  }
}
