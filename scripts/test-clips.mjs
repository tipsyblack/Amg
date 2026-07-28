// Проверка оживления кадров: какие сцены попадают под клип, что реестр моделей
// собирает вход правильно, что длина клипа меряется у файла, и что Scene
// подмораживает последний кадр вместо повтора.
//
// Реальных запросов в Kie.ai здесь нет: слаги моделей не подтверждены (см.
// videoModels.ts), проверять их можно только на живом аккаунте командой
// /vidmodel probe. Проверяем всё, что от аккаунта не зависит.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { VIDEO_MODELS, DEFAULT_VIDEO_MODEL_KEY, getVideoModel } = await import(
  "../src/pipeline/videoModels.ts"
);
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

for (const spec of VIDEO_MODELS) {
  const input = spec.buildInput("движение", "https://example.com/a.png", 2);
  check(
    `${spec.title}: вход содержит промпт, первый кадр и длительность`,
    input.prompt === "движение" &&
      input.image_url === "https://example.com/a.png" &&
      input.duration === 2,
    JSON.stringify(input),
  );
  check(
    `${spec.title}: пропорции 3:4 — как у карточки`,
    input.aspect_ratio === "3:4",
    String(input.aspect_ratio),
  );
}

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
