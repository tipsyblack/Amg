import { config } from "./config";
import { extractJson } from "./generateScript";

/**
 * Темы дня из мира нейросетей.
 *
 * Зачем это нужно. Контент-завод, который каждый день рассказывает одно и то
 * же, перестаёт собирать охваты: два ролика подряд вышли про «нейросети рисуют
 * картинки» и «нейросети делают контент» — для зрителя это один ролик, снятый
 * дважды. Проверка на повтор в scriptRepeat.ts работает ВНУТРИ ролика, а здесь
 * задача другая: не повторяться ИЗО ДНЯ В ДЕНЬ.
 *
 * Поэтому тема берётся не из головы, а из новостей: что произошло за последние
 * дни. Свежая новость даёт и повод посмотреть, и то, чего зритель ещё не знает.
 *
 * Список уже отснятых тем передаётся сюда и уходит в запрос: модель обязана
 * предложить другое. Это не гарантия — модель может назвать то же другими
 * словами, — поэтому рядом стоит быстрая проверка похожести по словам
 * (`isFreshTopic`), она отсеивает совпадения ещё до генерации сценария.
 */

export interface NewsTopic {
  /** Тема одной строкой — она же уходит в бриф сценариста. */
  title: string;
  /** Что именно произошло: факт с деталью, а не «вышла новая модель». */
  what: string;
  /** Почему это интересно зрителю нашего канала. */
  why: string;
}

const TOPICS_WANTED = 5;

function buildPrompt(used: string[], niche: string): string {
  const usedBlock =
    used.length > 0
      ? `\n\nПРО ЭТО МЫ УЖЕ СНИМАЛИ, повторять нельзя ни в каком виде:\n` +
        used.map((t) => `- ${t}`).join("\n")
      : "";

  return (
    `Ты — редактор канала про нейросети. Подбери ${TOPICS_WANTED} тем для ` +
    `коротких вертикальных роликов на сегодня.\n\n` +
    `Ниша канала: ${niche}\n\n` +
    "ЧТО СЧИТАЕТСЯ ТЕМОЙ. Конкретное событие последних дней: вышла модель и " +
    "что именно она умеет, компания что-то запустила или закрыла, появилось " +
    "измеримое исследование, случился публичный скандал или запрет. Обязательна " +
    "деталь, которую можно проверить: что именно изменилось, для кого, насколько.\n\n" +
    "ЧТО ТЕМОЙ НЕ СЧИТАЕТСЯ: «нейросети меняют мир», «ИИ в маркетинге», " +
    "«топ-5 сервисов», «как писать промпты» и прочие вечнозелёные рассуждения. Это " +
    "не новость, и зрителю нечего узнать.\n\n" +
    "ТЕМА ДОЛЖНА ВЕСТИ К ПРОДУКТУ: у нас бот, где можно попробовать разные " +
    "нейросети. Значит новость должна быть про то, чем зритель может " +
    "воспользоваться сам, а не про инфраструктуру, обучение моделей или " +
    "корпоративные сделки.\n\n" +
    "Все пять тем должны быть про РАЗНОЕ: не пять новостей об одной компании " +
    "и не пять про генерацию картинок." +
    usedBlock +
    "\n\nОтвечай СТРОГО валидным JSON без markdown-обёртки:\n" +
    '{"topics":[{"title":"тема одной строкой","what":"что произошло, с деталью",' +
    '"why":"почему это интересно зрителю"}]}'
  );
}

interface TopicsResult {
  topics: NewsTopic[];
  /** Веб-поиск не сработал — темы могут быть несвежими. */
  webSearchUnavailable?: boolean;
}

/**
 * Спрашивает у модели с веб-поиском, что происходит в мире нейросетей.
 *
 * Без веб-поиска смысл теряется — модель предложит то, что помнит с обучения,
 * а это по определению не сегодняшняя повестка. Поэтому неудача поиска не
 * молчаливая: она возвращается флагом, и бот обязан о ней сказать.
 */
export async function suggestNewsTopics(
  used: string[] = [],
  niche = "нейросети для обычных людей: картинки, видео, текст, музыка",
  webSearch = true,
  model: string = config.openRouterModel,
): Promise<TopicsResult> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: buildPrompt(used, niche) }],
    response_format: { type: "json_object" },
  };
  if (webSearch) {
    body.plugins = [{ id: "web", max_results: config.scriptWebSearchResults }];
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (webSearch) {
      const fallback = await suggestNewsTopics(used, niche, false, model);
      return { ...fallback, webSearchUnavailable: true };
    }
    throw new Error(
      `OpenRouter вернул ошибку ${response.status} при подборе тем`,
    );
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter вернул пустой ответ на подбор тем");

  const parsed = JSON.parse(extractJson(content)) as { topics?: NewsTopic[] };
  const topics = (parsed.topics ?? [])
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .map((t) => ({
      title: t.title.trim(),
      what: (t.what ?? "").trim(),
      why: (t.why ?? "").trim(),
    }));
  if (topics.length === 0) throw new Error("Тем в ответе не оказалось");
  return { topics };
}

// Сколько значимых слов должно совпасть, чтобы считать темы одной и той же.
// Здесь порог мягче, чем у проверки повторов внутри ролика (там три): темы —
// это одна строка, общих слов в них мало по определению, и два совпадения уже
// означают тот же предмет разговора.
const SAME_TOPIC_STEMS = 2;

/**
 * Не про то же ли это, что мы уже снимали.
 *
 * Считаем по общим корням, как и повтор внутри ролика. Это грубая проверка и
 * она не понимает смысла: «Midjourney обновилась» и «вышла новая версия
 * Midjourney» она поймает, а «Sora научилась звуку» и «видеомодели получили
 * озвучку» — нет. Её задача не заменить голову, а не дать выпустить дубль
 * механически.
 */
export function isFreshTopic(title: string, used: string[]): boolean {
  const mine = topicStems(title);
  if (mine.size === 0) return true;
  for (const old of used) {
    const theirs = topicStems(old);
    let shared = 0;
    for (const s of mine) if (theirs.has(s)) shared++;
    if (shared >= SAME_TOPIC_STEMS) return false;
  }
  return true;
}

// Слова, которые есть почти в каждой теме нашей ниши и потому ничего не
// различают. Без этого списка любые две темы «совпадали» бы по слову
// «нейросеть».
const TOPIC_STOP = new Set([
  "нейросет", "нейрон", "модел", "искусствен", "интеллект", "техн",
  "нов", "вышл", "выпуст", "запуст", "обнов", "представ", "показа",
  "как", "что", "для", "это", "мож", "теперь", "уже",
]);

function topicStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/ё/g, "е").split(/[^а-яa-z0-9]+/)) {
    if (raw.length < 4) continue;
    // Грубое отсечение окончания: тем сравнивается мало и редко, точная
    // морфология тут не окупается.
    const stem = raw.slice(0, Math.max(4, raw.length - 2));
    if (TOPIC_STOP.has(stem)) continue;
    out.add(stem);
  }
  return out;
}

/**
 * Бриф для сценариста из выбранной темы. Отдельной функцией, потому что бриф
 * должен нести не только заголовок, но и деталь: без неё сценарист напишет
 * общие слова ровно о том, чего мы избегаем.
 */
export function topicBrief(topic: NewsTopic): string {
  const parts = [topic.title];
  if (topic.what) parts.push(`Что произошло: ${topic.what}`);
  if (topic.why) parts.push(`Чем цепляет: ${topic.why}`);
  return parts.join("\n");
}
