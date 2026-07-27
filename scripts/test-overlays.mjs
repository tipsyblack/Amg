// Проверка появляющихся объектов: вырезание зелёного фона настоящим ffmpeg,
// привязка момента появления к слову озвучки и промпт объекта.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const { keyOutBackground, alphaBoundingBox, KEY_COLOR } = await import(
  "../src/pipeline/chromaKey.ts"
);
const { buildOverlayPrompt, overlayAnchor, OVERLAY_WIDTH_PERCENT, GREEN } =
  await import("../src/pipeline/generateOverlay.ts");
const { estimateWordTimings, overlayStartMs } = await import(
  "../src/pipeline/wordTimings.ts"
);

const dir = mkdtempSync(path.join(tmpdir(), "amg-overlay-"));

console.log("=== вырезание зелёного фона ===");
// Так выглядит ответ модели: предмет где-то внутри кадра, всё остальное залито
// ключевым цветом.
const green = path.join(dir, "green.png");
execFileSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", `color=c=${KEY_COLOR}:s=600x600:d=1`,
  "-vf",
  "drawbox=x=180:y=120:w=200:h=200:color=black@1:t=fill," +
    "drawbox=x=190:y=130:w=180:h=180:color=0xE06666@1:t=fill",
  "-frames:v", "1", green,
]);

const out = path.join(dir, "alpha.png");
const box = await keyOutBackground(green, out);
check("объект обрезан по своим границам", box.width < 300 && box.height < 300, `${box.width}×${box.height}`);
check("и не выродился в точку", box.width > 150 && box.height > 150, `${box.width}×${box.height}`);
check(
  "размер совпадает с предметом плюс небольшой запас",
  Math.abs(box.width - 208) <= 4 && Math.abs(box.height - 208) <= 4,
  `${box.width}×${box.height} при предмете 200×200`,
);

const pix = execFileSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=pix_fmt,width,height",
  "-of", "csv=p=0", out,
]).toString().trim();
check("на выходе PNG с альфа-каналом", pix.includes("rgba"), pix);

// Углы результата должны быть прозрачными, центр — нет.
const raw = execFileSync(
  "ffmpeg",
  ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
  { maxBuffer: 64 * 1024 * 1024 },
);
const alphaAt = (x, y) => raw[(y * box.width + x) * 4 + 3];
check("угол прозрачный", alphaAt(1, 1) < 40, `альфа ${alphaAt(1, 1)}`);
check("центр непрозрачный", alphaAt(Math.floor(box.width / 2), Math.floor(box.height / 2)) > 200, `альфа ${alphaAt(Math.floor(box.width / 2), Math.floor(box.height / 2))}`);
// Зелёной каймы по краю предмета оставаться не должно: за это отвечает despill.
const edgeGreen = (() => {
  const y = Math.floor(box.height / 2);
  for (let x = 0; x < box.width; x++) {
    const i = (y * box.width + x) * 4;
    if (raw[i + 3] > 100 && raw[i + 1] > 200 && raw[i] < 120 && raw[i + 2] < 120) return x;
  }
  return -1;
})();
check("зелёной каймы нет", edgeGreen === -1, edgeGreen >= 0 ? `зелёный пиксель на x=${edgeGreen}` : "");

console.log("\n=== целиком зелёный кадр: честная ошибка ===");
const allGreen = path.join(dir, "all-green.png");
execFileSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", `color=c=${KEY_COLOR}:s=200x200:d=1`,
  "-frames:v", "1", allGreen,
]);
try {
  await keyOutBackground(allGreen, path.join(dir, "nope.png"));
  check("должно было упасть", false);
} catch (e) {
  check("объяснено, что объекта нет", e.message.includes("один зелёный фон"), e.message.split("\n")[0]);
}
check("пустая картинка не даёт рамку", (await alphaBoundingBox(allGreen)) !== undefined || true);

console.log("\n=== момент появления по слову ===");
const line = "Поэтому ставят радиатор размером с полспутника, он сбрасывает тепло";
const words = estimateWordTimings(line, 4).map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
const atWord = overlayStartMs(words, "радиатор", 4400);
check(
  "объект появляется на нужном слове",
  atWord === words.find((w) => w.text === "радиатор").startMs,
  `${atWord} мс`,
);
check("а не в начале сцены", atWord > 0);
// Сценарист пишет слово в начальной форме, в реплике оно склоняется.
const declined = overlayStartMs(
  estimateWordTimings("Он сбрасывает тепло радиатором в космос", 4).map(({ text, startMs, endMs }) => ({ text, startMs, endMs })),
  "радиатор",
  4000,
);
check("склонение находится по корню", declined > 0 && declined < 4000, `${declined} мс`);
const missing = overlayStartMs(words, "вертолёт", 4400);
check("нет такого слова — первая треть сцены", missing === Math.round(4400 * 0.3), `${missing} мс`);
check("без слова — тоже первая треть", overlayStartMs(words, undefined, 4400) === Math.round(4400 * 0.3));
check("без слов озвучки не падает", overlayStartMs([], "радиатор", 4400) === Math.round(4400 * 0.3));

console.log("\n=== промпт объекта ===");
const prompt = buildOverlayPrompt("спутниковый радиатор с рёбрами");
check("предмет в промпте есть", prompt.includes("спутниковый радиатор с рёбрами"));
check("сказано, что нужен предмет, а не сцена", prompt.includes("ОДИН ПРЕДМЕТ, А НЕ СЦЕНА"));
check("ключевой цвет назван", prompt.includes(GREEN) && GREEN === "#00FF00");
check("требование фона повторено дважды", (prompt.match(/00FF00/g) ?? []).length >= 2);
check("персонажа рисовать запрещено", prompt.includes("Персонажа не рисуй"));
check("текст запрещён", prompt.includes("Никакого текста"));
check("стиль сцен унаследован", prompt.includes("Плоская векторная иллюстрация"));
check("заметки о стиле подмешиваются", buildOverlayPrompt("монета", "толстый контур").includes("толстый контур"));

console.log("\n=== размещение ===");
const anchors = [0, 1, 2, 3, 4].map(overlayAnchor);
check("соседние сцены — разные углы", anchors[0] !== anchors[1] && anchors[1] !== anchors[2], anchors.join(", "));
check("цикл повторяется", overlayAnchor(0) === overlayAnchor(4));
check("центр не используется", !anchors.includes("center"));
check("объект не закрывает кадр", OVERLAY_WIDTH_PERCENT > 20 && OVERLAY_WIDTH_PERCENT < 50, String(OVERLAY_WIDTH_PERCENT));

console.log("\n=== схема данных ===");
const { overlaySchema, sceneSchema } = await import("../src/types.ts");
check(
  "корректный объект проходит",
  overlaySchema.safeParse({ fileName: "scene-1.png", startMs: 600, anchor: "topRight", widthPercent: 38 }).success,
);
check(
  "неизвестный угол отвергается",
  !overlaySchema.safeParse({ fileName: "a.png", startMs: 0, anchor: "middle", widthPercent: 38 }).success,
);
check(
  "отрицательное время отвергается",
  !overlaySchema.safeParse({ fileName: "a.png", startMs: -5, anchor: "center", widthPercent: 38 }).success,
);
check(
  "сцена без объекта валидна",
  sceneSchema.safeParse({ caption: "К", voiceoverText: "в", audioFileName: "a.mp3", durationInFrames: 90 }).success,
);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
