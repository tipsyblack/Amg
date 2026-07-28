// Проверка оживления кадров: какие сцены попадают под клип, что реестр моделей
// собирает вход правильно, что длина клипа меряется у файла, и что Scene
// подмораживает последний кадр вместо повтора.
//
// Реальных запросов в Kie.ai здесь нет — проверяем всё, что от аккаунта не
// зависит. Живой прогон уже поймал две ошибки, которые здесь и закреплены:
// выдуманные слаги вида bytedance/seedance-v2-mini-i2v (API ответил 422) и
// длительность 2 с при минимуме 4 у Seedance 2.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const { clipSceneIndexes, buildClipPrompt } = await import(
  "../src/pipeline/generateClip.ts"
);
const {
  VIDEO_MODELS,
  DEFAULT_VIDEO_MODEL_KEY,
  getVideoModel,
  clampClipSeconds,
} = await import("../src/pipeline/videoModels.ts");
const { config } = await import("../src/pipeline/config.ts");
const { getClipDurationInSeconds } = await import(
  "../src/pipeline/audioDuration.ts"
);
const { sceneSchema } = await import("../src/types.ts");

console.log("=== выбор сцен под клип ===");
check("ноль клипов — пустой список", clipSceneIndexes(10, 0).length === 0);
check("отрицательное число тоже", clipSceneIndexes(10, -1).length === 0);
check(
  "один клип достаётся хуку",
  JSON.stringify(clipSceneIndexes(10, 1)) === "[0]",
  JSON.stringify(clipSceneIndexes(10, 1)),
);
check(
  "два клипа — хук и финал",
  JSON.stringify(clipSceneIndexes(10, 2)) === "[0,9]",
  JSON.stringify(clipSceneIndexes(10, 2)),
);

// Третий и дальше уходят в середину, а не громоздятся у краёв: иначе всё
// движение ролика собирается в начале, а середина остаётся мёртвой.
const three = clipSceneIndexes(10, 3);
check("три клипа: три разные сцены", new Set(three).size === 3, JSON.stringify(three));
check(
  "третий — в середине, а не рядом с краем",
  three[1] > 1 && three[1] < 8,
  JSON.stringify(three),
);

for (const count of [1, 2, 3, 4, 5]) {
  for (const total of [1, 2, 3, 5, 8, 15]) {
    const picked = clipSceneIndexes(total, count);
    const unique = new Set(picked).size === picked.length;
    const inRange = picked.every((i) => Number.isInteger(i) && i >= 0 && i < total);
    const bounded = picked.length <= Math.min(count, total);
    if (!unique || !inRange || !bounded) {
      check(
        `набор сцен корректен при total=${total}, count=${count}`,
        false,
        JSON.stringify(picked),
      );
    }
  }
}
check("сцены не повторяются и не выходят за границы ни при каком раскладе", true);

// Сцен меньше, чем просили клипов — оживляем все, но не выдумываем лишних.
check(
  "клипов больше, чем сцен — берём все сцены",
  JSON.stringify(clipSceneIndexes(3, 5)) === "[0,1,2]",
  JSON.stringify(clipSceneIndexes(3, 5)),
);

console.log("\n=== промпт клипа ===");
const prompt = buildClipPrompt("Шамиль показывает на экран с графиком");
check("реплика попала в промпт", prompt.includes("показывает на экран"));
check(
  "камера просится неподвижной — иначе стык перестаёт читаться",
  /неподвижн/i.test(prompt) && /без наездов/i.test(prompt),
);
check("запрет текста на месте", /никакого текста/i.test(prompt));
check(
  "просим сохранить исходный кадр, а не перерисовать",
  /не дорисовывай/i.test(prompt) && /та же композиция/i.test(prompt),
);

console.log("\n=== реестр моделей ===");
check("ключи моделей уникальны", new Set(VIDEO_MODELS.map((m) => m.key)).size === VIDEO_MODELS.length);
check("слаги моделей уникальны", new Set(VIDEO_MODELS.map((m) => m.model)).size === VIDEO_MODELS.length);
check(
  "модель по умолчанию есть в реестре",
  VIDEO_MODELS.some((m) => m.key === DEFAULT_VIDEO_MODEL_KEY),
);
check(
  "неизвестный ключ откатывается на модель по умолчанию",
  getVideoModel("нет-такой").key === DEFAULT_VIDEO_MODEL_KEY,
);

// Слаги сверены с документацией Kie.ai после того, как угаданные имена вида
// bytedance/seedance-v2-mini-i2v получили от API 422 «model name is not
// supported». Фиксируем именование, чтобы оно не уехало обратно.
check(
  "по умолчанию bytedance/seedance-2-mini",
  getVideoModel().model === "bytedance/seedance-2-mini",
  getVideoModel().model,
);
check(
  "нигде не осталось выдуманного суффикса -i2v",
  VIDEO_MODELS.every((m) => !m.model.includes("i2v") || m.model.includes("image-to-video")),
  VIDEO_MODELS.map((m) => m.model).join(" "),
);
check(
  "все слаги начинаются с bytedance/",
  VIDEO_MODELS.every((m) => m.model.startsWith("bytedance/")),
);

for (const spec of VIDEO_MODELS) {
  const input = spec.buildInput("движение", "https://example.com/a.png", spec.minSeconds);
  // Главная ошибка первой попытки: у Seedance 2.x входная картинка называется
  // first_frame_url, а не image_url — с image_url запрос не прошёл бы даже с
  // верным слагом. Проверяем, что поле есть под одним из двух имён и что
  // ссылка действительно в нём.
  const frame = input.first_frame_url ?? input.image_url;
  check(
    `${spec.title}: первый кадр передан`,
    frame === "https://example.com/a.png",
    JSON.stringify(input),
  );
  check(
    `${spec.title}: промпт и длительность на месте`,
    input.prompt === "движение" &&
      (input.duration === spec.minSeconds || input.duration === String(spec.minSeconds)),
    JSON.stringify(input),
  );
  check(
    `${spec.title}: разрешение из настройки, а не зашито`,
    input.resolution === config.clipResolution,
    String(input.resolution),
  );
  // Свою озвучку мы уже оплатили; звук от модели лёг бы поверх неё.
  if ("generate_audio" in input) {
    check(`${spec.title}: звук модели выключен`, input.generate_audio === false);
  }
  // У V1 есть прямой выключатель движения камеры — он ровно про нашу задачу.
  if ("camera_fixed" in input) {
    check(`${spec.title}: камера зафиксирована`, input.camera_fixed === true);
  }
  check(
    `${spec.title}: диапазон длительности осмысленный`,
    spec.minSeconds > 0 && spec.minSeconds <= spec.maxSeconds,
    `${spec.minSeconds}-${spec.maxSeconds}`,
  );
  check(`${spec.title}: цена задана`, spec.pricePerSecond > 0);
}

console.log("\n--- длительность приводится к допустимой ---");
const mini = getVideoModel("sd2mini");
// Ровно та ошибка, которую поймал первый прогон на живом аккаунте: мы просили
// две секунды, а Seedance 2 короче четырёх не делает вовсе.
check(
  "две секунды поднимаются до минимума модели",
  clampClipSeconds(mini, 2) === mini.minSeconds,
  String(clampClipSeconds(mini, 2)),
);
check(
  "слишком длинный клип обрезается по максимуму",
  clampClipSeconds(mini, 999) === mini.maxSeconds,
  String(clampClipSeconds(mini, 999)),
);
check(
  "допустимая длительность не трогается",
  clampClipSeconds(mini, 6) === 6,
);
check(
  "значение по умолчанию из .env уже допустимо для всех моделей",
  VIDEO_MODELS.every((s) => clampClipSeconds(s, config.clipSeconds) === config.clipSeconds ||
    config.clipSeconds < s.minSeconds),
  String(config.clipSeconds),
);
check(
  "CLIP_SECONDS по умолчанию — 4, а не 2",
  config.clipSeconds === 4,
  String(config.clipSeconds),
);

console.log("\n=== длительность клипа ===");
const dir = mkdtempSync(path.join(tmpdir(), "amg-clip-"));
try {
  // Настоящий mp4 на 2 секунды: длину надо мерить у файла, потому что модели
  // округляют её по-своему, а по этому числу решается, с какого кадра
  // подмораживать последний кадр.
  const clip = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x426:d=2:r=30",
    "-pix_fmt", "yuv420p", clip,
  ]);
  const seconds = await getClipDurationInSeconds(clip, 99);
  check(
    "длительность прочитана из файла, а не взята из запроса",
    Math.abs(seconds - 2) < 0.2,
    String(seconds),
  );

  const missing = await getClipDurationInSeconds(
    path.join(dir, "нет-такого.mp4"),
    2,
  );
  check(
    "нечитаемый файл не роняет сборку, а откатывается на заявленную длину",
    missing === 2,
    String(missing),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== библиотека маскота ===");
const {
  CLIP_LIBRARY,
  buildLibraryClipPrompt,
  clipRoleForScene,
  getClipDefinition,
  libraryFileName,
  pickLibraryClip,
  resolveClipSelection,
} = await import("../src/pipeline/clipLibrary.ts");

check("в библиотеке ровно десять клипов", CLIP_LIBRARY.length === 10, String(CLIP_LIBRARY.length));
check(
  "идентификаторы уникальны",
  new Set(CLIP_LIBRARY.map((c) => c.id)).size === CLIP_LIBRARY.length,
);
check(
  "имена файлов уникальны и не пересекаются с клипами сцен",
  new Set(CLIP_LIBRARY.map((c) => libraryFileName(c.id))).size === 10 &&
    CLIP_LIBRARY.every((c) => libraryFileName(c.id).startsWith("lib-")),
);
check("поиск по id работает", getClipDefinition("intro-lean")?.role === "intro");

// Клипы хука переписаны: первая версия строилась на появлении персонажа, но
// карточка хука в тот же момент сама приезжает наездом — получалось два
// появления подряд. Теперь персонаж в кадре с первого кадра. Закрепляем: если
// «появление» вернётся в текст, проверка упадёт.
const intros = CLIP_LIBRARY.filter((c) => c.role === "intro");
check(
  "клипы хука не строятся на появлении персонажа",
  intros.every(
    (c) => !/появля|вырывается|материализ|влетает|проявляется/i.test(c.action),
  ),
  intros.map((c) => c.id).join(", "),
);
check(
  "во всех трёх персонаж уже в кадре",
  intros.every((c) => /уже (стоит )?в кадре/i.test(c.action)),
  intros.map((c) => c.id).join(", "),
);
check(
  "жесты хука разные, а не три вариации одного",
  new Set(intros.map((c) => c.title)).size === intros.length,
);
check("неизвестный id — undefined", getClipDefinition("нет") === undefined);

// Роли должны покрывать все места, куда клип может встать: иначе сцена
// молча останется картинкой, и понять почему будет неоткуда.
for (const role of ["intro", "reaction", "handoff", "outro"]) {
  const count = CLIP_LIBRARY.filter((c) => c.role === role).length;
  check(`роль ${role}: есть хотя бы два варианта`, count >= 2, `${count}`);
}

check(
  "хук получает появление, финал — прощание",
  clipRoleForScene(0, 8) === "intro" && clipRoleForScene(7, 8) === "outro",
);
check(
  "середина — не появление и не прощание",
  [1, 2, 3, 4, 5, 6].every((i) => {
    const role = clipRoleForScene(i, 8);
    return role === "reaction" || role === "handoff";
  }),
);
// Сцена одна на весь ролик: она и хук, и финал. Появление важнее — с него
// начинается просмотр.
check("единственная сцена считается хуком", clipRoleForScene(0, 1) === "intro");

console.log("\n--- выбор из библиотеки ---");
const allReady = new Set(CLIP_LIBRARY.map((c) => c.id));
check(
  "из пустой библиотеки не выбирается ничего",
  pickLibraryClip("intro", new Set()) === undefined,
);
check(
  "выбранный клип совпадает по роли",
  pickLibraryClip("outro", allReady)?.role === "outro",
);
check(
  "частично собранная библиотека: берётся только готовое",
  pickLibraryClip("intro", new Set(["intro-snap"]))?.id === "intro-snap",
);
check(
  "роли, которой нет в готовых, не выдумывается замена",
  pickLibraryClip("outro", new Set(["intro-snap"])) === undefined,
);
// Занятые в этом же ролике клипы пропускаются — иначе два соседних
// оживления окажутся одним и тем же жестом.
const used = new Set(["react-think", "react-nod"]);
check(
  "занятый клип не выдаётся повторно",
  pickLibraryClip("reaction", allReady, used)?.id === "react-surprise",
);
// Но если заняты все — лучше повтор, чем пустая сцена.
const allReactionsUsed = new Set(
  CLIP_LIBRARY.filter((c) => c.role === "reaction").map((c) => c.id),
);
check(
  "когда заняты все клипы роли, повтор всё равно лучше пустоты",
  pickLibraryClip("reaction", allReady, allReactionsUsed)?.role === "reaction",
);
// Выбор случайный: если брать всегда первый, все ролики будут открываться
// одним кадром. Проверяем, что за много попыток встречается больше одного.
const seen = new Set();
for (let i = 0; i < 200; i++) seen.add(pickLibraryClip("intro", allReady)?.id);
check("выбор перебирает варианты, а не залипает на первом", seen.size > 1, `${seen.size}`);

console.log("\n--- промпт библиотечного клипа ---");
const libPrompt = buildLibraryClipPrompt(getClipDefinition("intro-snap"));
check("действие попало в промпт", libPrompt.includes("щёлкает пальцами"));
check(
  "фон просится пустым: клип встаёт в карточку рядом с иллюстрациями",
  /фон/i.test(libPrompt) && /без окружения/i.test(libPrompt),
);
check("камера неподвижна", /неподвижн/i.test(libPrompt));
check("запрет текста на месте", /никакого текста/i.test(libPrompt));
check(
  "внешность просим не перерисовывать",
  /не перерисовывай/i.test(libPrompt),
);
check(
  "все десять промптов собираются без ошибок и непустые",
  CLIP_LIBRARY.every((c) => buildLibraryClipPrompt(c).length > 200),
);

console.log("\n--- что пересобирать ---");
// Пересобирать все десять клипов ради трёх — это лишние деньги, поэтому
// выбор понимает и роль, и отдельные идентификаторы.
check(
  "пустой список — вся библиотека",
  resolveClipSelection([])?.length === CLIP_LIBRARY.length,
);
check(
  "роль разворачивается в свои клипы",
  resolveClipSelection(["intro"])?.every((c) => c.role === "intro") &&
    resolveClipSelection(["intro"])?.length === 3,
  String(resolveClipSelection(["intro"])?.length),
);
check(
  "конкретные идентификаторы",
  JSON.stringify(resolveClipSelection(["intro-snap", "outro-lamp"])?.map((c) => c.id)) ===
    '["intro-snap","outro-lamp"]',
);
check(
  "роль и id вперемешку, без дублей",
  resolveClipSelection(["intro", "intro-snap"])?.length === 3,
  String(resolveClipSelection(["intro", "intro-snap"])?.length),
);
// Молча пересобрать не то, что просили, — значит потратить чужие деньги.
check(
  "непонятное слово отвергается целиком",
  resolveClipSelection(["intro", "чепуха"]) === undefined,
);

console.log("\n=== библиотека предпочитается платной генерации ===");
// Самое дорогое место во всей фиче: если порядок перепутать, каждый ролик
// начнёт платить за то, что уже оплачено. Кладём в библиотеку настоящий файл
// и проверяем, что он подставился, а в Kie.ai никто не пошёл (ключ здесь
// фальшивый — любой сетевой вызов провалился бы).
const { sceneClip } = await import("../src/pipeline/assets.ts");
const { CLIP_LIBRARY_DIR, PUBLIC_CLIPS_DIR } = await import(
  "../src/pipeline/clipLibrary.ts"
);
const libDir = CLIP_LIBRARY_DIR;
const hadLibDir = existsSync(libDir);
const fakeId = "intro-lean";
const fakeFile = path.join(libDir, libraryFileName(fakeId));
const hadFake = existsSync(fakeFile);
try {
  mkdirSync(libDir, { recursive: true });
  mkdirSync(PUBLIC_CLIPS_DIR, { recursive: true });
  if (!hadFake) {
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=320x426:d=2:r=30",
      "-pix_fmt", "yuv420p", fakeFile,
    ]);
  }

  const fromLibrary = await sceneClip({
    index: 0,
    total: 5,
    voiceoverText: "текст",
    imageUrl: "https://example.com/scene.png",
    ready: new Set([fakeId]),
  });
  check(
    "готовый клип берётся из библиотеки, а не генерируется",
    fromLibrary?.source === "library" && fromLibrary?.libraryId === fakeId,
    JSON.stringify(fromLibrary),
  );
  check(
    "длительность подставленного клипа посчитана",
    fromLibrary?.clipDurationInFrames > 0,
    String(fromLibrary?.clipDurationInFrames),
  );
  check(
    "файл действительно лёг туда, где его прочитает Remotion",
    existsSync(path.join(PUBLIC_CLIPS_DIR, fromLibrary.clipFileName)),
  );

  // source=library — платных генераций не делать вовсе, даже если готового
  // клипа для этой роли нет. Иначе «только библиотека» молча тратила бы деньги.
  const strict = await sceneClip({
    index: 2,
    total: 5,
    voiceoverText: "текст",
    imageUrl: "https://example.com/scene.png",
    ready: new Set([fakeId]),
    source: "library",
  });
  check(
    "режим «только библиотека» не уходит в платную генерацию",
    strict === undefined,
    JSON.stringify(strict),
  );

  rmSync(path.join(PUBLIC_CLIPS_DIR, libraryFileName(fakeId)), { force: true });
} finally {
  if (!hadFake) rmSync(fakeFile, { force: true });
  if (!hadLibDir) rmSync(libDir, { recursive: true, force: true });
}

console.log("\n=== схема сцены ===");
const withClip = sceneSchema.safeParse({
  caption: "подпись",
  voiceoverText: "текст",
  audioFileName: "scene-0.mp3",
  imageFileName: "scene-0.png",
  clipFileName: "scene-0.mp4",
  clipDurationInFrames: 120,
  durationInFrames: 180,
});
check("сцена с клипом проходит схему", withClip.success, JSON.stringify(withClip.error?.issues));

const withoutClip = sceneSchema.safeParse({
  caption: "подпись",
  voiceoverText: "текст",
  audioFileName: "scene-0.mp3",
  imageFileName: "scene-0.png",
  durationInFrames: 180,
});
check("сцена без клипа тоже — поле необязательное", withoutClip.success);

// Нулевая длительность клипа означала бы деление сцены на «до» и «после» в
// одной точке: Freeze получил бы отрицательный кадр.
const zeroClip = sceneSchema.safeParse({
  caption: "подпись",
  voiceoverText: "текст",
  audioFileName: "scene-0.mp3",
  clipFileName: "scene-0.mp4",
  clipDurationInFrames: 0,
  durationInFrames: 180,
});
check("нулевая длина клипа отвергается схемой", !zeroClip.success);

// Настоящий рендер: единственный способ убедиться, что клип действительно
// играет внутри карточки и что после его конца кадр замирает, а не
// повторяется с начала. Держим за флагом — рендер одного кадра занимает около
// минуты и требует браузера, который Remotion скачивает сам.
//
// REMOTION_BROWSER=<путь> подставляет уже установленный Chromium (например,
// /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell) —
// нужно там, где скачивать браузер некуда.
if (process.env.CLIP_RENDER_TEST === "1") {
  console.log("\n=== рендер: клип играет и замирает ===");
  const renderDir = mkdtempSync(path.join(tmpdir(), "amg-cliprender-"));
  const clipName = "__clip-test.mp4";
  const imageName = "__clip-test.png";
  const clipPath = path.join("public/clips", clipName);
  const imagePath = path.join("public/images", imageName);
  try {
    // testsrc2 не просто меняется от кадра к кадру — он печатает в углу свой
    // тайм-код, и по нему видно не «что-то поменялось», а какая именно
    // секунда клипа стоит в кадре.
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=600x800:duration=1:rate=60",
      "-pix_fmt", "yuv420p", clipPath,
    ]);
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x3366aa:s=600x800:d=1",
      "-frames:v", "1", imagePath,
    ]);

    const propsFile = path.join(renderDir, "props.json");
    writeFileSync(
      propsFile,
      JSON.stringify({
        title: "Проверка клипа",
        fps: 60,
        width: 1080,
        height: 1920,
        sfxEnabled: false,
        scenes: [
          {
            caption: "тест",
            voiceoverText: "тест",
            audioFileName: "scene-0.wav",
            imageFileName: imageName,
            imageWidth: 600,
            imageHeight: 800,
            clipFileName: clipName,
            // Клип вдвое короче сцены: остаток она должна досидеть на его
            // последнем кадре.
            clipDurationInFrames: 60,
            durationInFrames: 120,
          },
        ],
      }),
    );

    const still = (frame) => {
      const out = path.join(renderDir, `f${frame}.png`);
      execFileSync(
        "npx",
        [
          "remotion", "still", "src/remotion/index.ts", "VideoComposition",
          out, `--props=${propsFile}`, `--frame=${frame}`,
          ...(process.env.REMOTION_BROWSER
            ? [`--browser-executable=${process.env.REMOTION_BROWSER}`]
            : []),
        ],
        { stdio: "pipe" },
      );
      return execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    };

    // Считаем только внутри карточки: снаружи живут акценты, они шевелятся
    // сами по себе и к клипу отношения не имеют.
    const W = 1080;
    const cardDiff = (a, b) => {
      let n = 0;
      for (let y = 240; y < 1270; y += 3) {
        for (let x = 160; x < 920; x += 3) {
          const i = y * W * 3 + x * 3;
          if (
            Math.abs(a[i] - b[i]) > 10 ||
            Math.abs(a[i + 1] - b[i + 1]) > 10 ||
            Math.abs(a[i + 2] - b[i + 2]) > 10
          ) {
            n++;
          }
        }
      }
      return n;
    };

    const playingA = still(20);
    const playingB = still(45);
    const frozenA = still(75);
    const frozenB = still(110);

    const moving = cardDiff(playingA, playingB);
    const still2 = cardDiff(frozenA, frozenB);
    check(
      "пока клип идёт, содержимое карточки меняется",
      moving > 1000,
      `${moving} отличий`,
    );
    // Не ноль: два декодирования одного кадра дают крохотный разброс (на
    // замере было 54 пробы из 87 тысяч при максимальной разнице 16 из 255).
    // Важно на два порядка меньше, чем при движении.
    check(
      "после конца клипа кадр замирает, а не повторяется с начала",
      still2 * 20 < moving,
      `${still2} отличий против ${moving} в движении`,
    );
  } finally {
    rmSync(renderDir, { recursive: true, force: true });
    rmSync(clipPath, { force: true });
    rmSync(imagePath, { force: true });
  }
}

process.exit(fails === 0 ? 0 : 1);
