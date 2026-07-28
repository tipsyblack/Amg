import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { getClipDurationInSeconds } from "./audioDuration";
import { config } from "./config";

// Библиотека клипов с маскотом: десять коротких роликов, которые генерируются
// ОДИН РАЗ и переиспользуются во всех будущих видео.
//
// Зачем отдельно от оживления сцены. Клип из картинки сцены (generateClip.ts)
// стоит денег на каждый ролик и привязан к конкретной иллюстрации. А маскот
// делает одно и то же в любом ролике: появляется, удивляется, показывает,
// прощается. Такие клипы не зависят от темы, поэтому платить за них каждый раз
// незачем — сгенерировали десять штук и дальше берём готовые бесплатно.
//
// Где они встают. Там же, где по нашему правилу и так появляется маскот
// (assets.ts, sceneWithCharacter): хук — лицо ролика, финал — призыв к
// действию. Середина при желании тоже, но роль там другая — реакция, а не
// приветствие.

export const CLIP_LIBRARY_DIR = path.resolve("assets/clips");
export const PUBLIC_CLIPS_DIR = path.resolve("public/clips");

/** Роль клипа — где в ролике он уместен. */
export type ClipRole = "intro" | "reaction" | "handoff" | "outro";

export interface ClipDefinition {
  id: string;
  role: ClipRole;
  title: string;
  /** Что делает маскот. Идёт в промпт как описание движения. */
  action: string;
}

// Десять клипов: три появления, три реакции, два показа, два прощания.
// Перекос в сторону появлений намеренный — хук есть в каждом ролике, и если
// вариант там будет один, все ролики начнут выглядеть одинаково.
export const CLIP_LIBRARY: ClipDefinition[] = [
  // Клипы хука. Первая версия была построена на появлении: джин выходил из
  // лампы, проявлялся из дымки, влетал в кадр. Это ошибка замысла, а не
  // исполнения — карточка хука в тот же момент сама приезжает упругим
  // наездом, и появление внутри неё давало два появления подряд. Мы уже
  // наступали на эти грабли со стыками: два движения на одном стыке гасят
  // друг друга (см. coversFrame в transitions.ts).
  //
  // Поэтому теперь персонаж В КАДРЕ С ПЕРВОГО КАДРА и сразу что-то делает.
  // Причина та же, по которой хук не проявляется, а врубается: первый кадр
  // ролика — это ещё и обложка в ленте, и он должен быть непустым.
  {
    id: "intro-lean",
    role: "intro",
    title: "Подаётся к зрителю",
    action:
      "джин уже стоит в кадре и резко подаётся вперёд, к зрителю, будто " +
      "собирается сказать что-то важное по секрету; брови приподняты, взгляд " +
      "прямо в камеру",
  },
  {
    id: "intro-snap",
    role: "intro",
    title: "Щёлкает пальцами",
    action:
      "джин уже стоит в кадре и щёлкает пальцами; над его ладонью вспыхивает " +
      "искра и разлетается золотыми частицами",
  },
  {
    id: "intro-brows",
    role: "intro",
    title: "Хитрая улыбка",
    action:
      "джин уже стоит в кадре, склоняет голову набок, вскидывает бровь и " +
      "хитро улыбается уголком рта, будто знает то, чего не знает зритель",
  },
  {
    id: "react-think",
    role: "reaction",
    title: "Задумывается",
    action:
      "джин задумчиво поглаживает бородку, склонив голову набок, брови " +
      "чуть сведены",
  },
  {
    id: "react-surprise",
    role: "reaction",
    title: "Удивляется",
    action:
      "джин удивлённо вскидывает брови и разводит руками, глаза широко " +
      "раскрыты",
  },
  {
    id: "react-nod",
    role: "reaction",
    title: "Одобрительно кивает",
    action:
      "джин уверенно кивает несколько раз, скрестив руки на груди, с лёгкой " +
      "усмешкой",
  },
  {
    id: "hand-give",
    role: "handoff",
    title: "Протягивает предмет",
    action:
      "джин протягивает раскрытую ладонь вперёд, над ней всплывает и мягко " +
      "покачивается искорка света",
  },
  {
    id: "hand-show",
    role: "handoff",
    title: "Показывает в сторону",
    action:
      "джин разворачивается вполоборота и широким жестом показывает рукой в " +
      "сторону, приглашая посмотреть",
  },
  {
    id: "outro-thumb",
    role: "outro",
    title: "Большой палец и подмигивание",
    action:
      "джин показывает большой палец вверх и подмигивает одним глазом, " +
      "довольно улыбаясь",
  },
  {
    id: "outro-lamp",
    role: "outro",
    title: "Уходит в лампу",
    action:
      "джин машет на прощание и втягивается обратно в лампу дымным вихрем, " +
      "постепенно исчезая",
  },
];

export function libraryFileName(id: string): string {
  return `lib-${id}.mp4`;
}

export function getClipDefinition(id: string): ClipDefinition | undefined {
  return CLIP_LIBRARY.find((clip) => clip.id === id);
}

/**
 * Промпт библиотечного клипа.
 *
 * От промпта оживления сцены отличается тем, что здесь фон обязан остаться
 * пустым и светлым: клип встаёт в карточку рядом с иллюстрациями, и если
 * модель дорисует маскоту окружение, он выпадет из общего ряда. Внешность
 * задаётся приложенным эталоном (первый кадр), а не описанием.
 */
export function buildLibraryClipPrompt(clip: ClipDefinition): string {
  return (
    "Оживи приложенный кадр с персонажем, сохранив его внешность в точности: " +
    "лицо, причёску, одежду, цвет кожи и стиль плоской векторной иллюстрации " +
    "с толстым чёрным контуром. Персонажа не перерисовывай.\n\n" +
    `Что он делает: ${clip.action}.\n\n` +
    "Фон — однотонный светлый, без окружения, предметов, интерьера и " +
    "пейзажа. Камера стоит неподвижно: без наездов, отъездов, панорам и " +
    "облётов. Смены плана нет, склейки нет — это один непрерывный кадр.\n\n" +
    "КРИТИЧНО: никакого текста, надписей, букв и цифр в кадре."
  );
}

export async function ensureLibraryDir(): Promise<void> {
  await mkdir(CLIP_LIBRARY_DIR, { recursive: true });
}

async function libraryFiles(): Promise<string[]> {
  try {
    return await readdir(CLIP_LIBRARY_DIR);
  } catch {
    return [];
  }
}

/** Какие клипы уже сгенерированы и лежат в библиотеке. */
export async function readyClipIds(): Promise<Set<string>> {
  const present = new Set(await libraryFiles());
  return new Set(
    CLIP_LIBRARY.filter((clip) => present.has(libraryFileName(clip.id))).map(
      (clip) => clip.id,
    ),
  );
}

/**
 * Файлы клипов, которых больше нет в списке.
 *
 * Появляются, когда клип переписан под другим идентификатором: старый файл
 * остаётся лежать, но никогда не будет подставлен. Сам их не удаляю — это
 * оплаченные файлы, и решать должен человек; но показать обязан, иначе
 * библиотека тихо обрастает мусором.
 */
export async function orphanClipFiles(): Promise<string[]> {
  const known = new Set(CLIP_LIBRARY.map((clip) => libraryFileName(clip.id)));
  return (await libraryFiles()).filter(
    (file) => file.startsWith("lib-") && file.endsWith(".mp4") && !known.has(file),
  );
}

/**
 * Разбирает, что просили пересобрать: роль целиком («intro»), конкретные
 * идентификаторы или ничего (тогда все недостающие). Возвращает undefined,
 * если хоть одно слово непонятно — молча пересобрать не то, что просили,
 * значит потратить чужие деньги.
 */
export function resolveClipSelection(
  words: string[],
): ClipDefinition[] | undefined {
  if (words.length === 0) return CLIP_LIBRARY;
  const roles = new Set<ClipRole>(["intro", "reaction", "handoff", "outro"]);
  const picked: ClipDefinition[] = [];
  for (const word of words) {
    if (roles.has(word as ClipRole)) {
      picked.push(...CLIP_LIBRARY.filter((clip) => clip.role === word));
      continue;
    }
    const clip = getClipDefinition(word);
    if (!clip) return undefined;
    picked.push(clip);
  }
  return [...new Set(picked)];
}

/**
 * Выбирает готовый клип нужной роли. Выбор случайный среди готовых: если брать
 * всегда первый, все ролики начнут открываться одним и тем же кадром. На
 * повторяемость рендера это не влияет — выбор происходит при сборке данных и
 * попадает в video-data.json, а рендер уже читает готовое имя файла.
 *
 * Ролей может не быть вовсе (библиотека пуста или сгенерирована частично) —
 * тогда undefined, и вызывающий решает, генерировать клип за деньги или
 * оставить сцену картинкой.
 */
export function pickLibraryClip(
  role: ClipRole,
  ready: Set<string>,
  exclude: Set<string> = new Set(),
): ClipDefinition | undefined {
  const candidates = CLIP_LIBRARY.filter(
    (clip) => clip.role === role && ready.has(clip.id) && !exclude.has(clip.id),
  );
  // Все клипы этой роли уже заняты в этом же ролике — лучше повтор, чем
  // пустая сцена, поэтому пробуем ещё раз без списка занятых.
  const pool =
    candidates.length > 0
      ? candidates
      : CLIP_LIBRARY.filter((clip) => clip.role === role && ready.has(clip.id));
  if (pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Роль клипа для сцены по её месту в ролике. Совпадает с правилом появления
 * маскота (sceneWithCharacter): хук и финал — его места, середина — про
 * содержание, и там он в лучшем случае реагирует.
 */
export function clipRoleForScene(index: number, total: number): ClipRole {
  if (index === 0) return "intro";
  if (index === total - 1) return "outro";
  // Чередуем реакцию и показ, чтобы две соседние оживлённые сцены не были
  // одним и тем же жестом.
  return index % 2 === 1 ? "reaction" : "handoff";
}

/**
 * Кладёт библиотечный клип туда, где его прочитает Remotion, и меряет длину.
 * Сам файл остаётся в библиотеке — копия в public/ живёт до следующего ролика.
 */
export async function installLibraryClip(
  clip: ClipDefinition,
): Promise<{ clipFileName: string; clipDurationInFrames: number }> {
  const fileName = libraryFileName(clip.id);
  await mkdir(PUBLIC_CLIPS_DIR, { recursive: true });
  const target = path.join(PUBLIC_CLIPS_DIR, fileName);
  await copyFile(path.join(CLIP_LIBRARY_DIR, fileName), target);

  const seconds = await getClipDurationInSeconds(target, config.clipSeconds);
  return {
    clipFileName: fileName,
    clipDurationInFrames: Math.max(Math.round(seconds * config.fps), 1),
  };
}
