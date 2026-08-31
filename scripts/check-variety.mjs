// Замер разнообразия картинок: одинаковые ли кадры в ролике.
//
//   npm run variety:check -- public/images   — по картинкам до сборки
//   npm run variety:check -- out/video.mp4   — по собранному ролику
//
// Сама арифметика лежит в src/pipeline/variety.ts: тот же замер бот показывает
// в чате после отрисовки, и считаться он должен одинаково.
import { statSync } from "node:fs";
import {
  measureImages,
  measureVideo,
  varietyReport,
  VARIETY_TARGETS,
} from "../src/pipeline/variety.ts";

const target = process.argv[2] ?? "public/images";
const info = statSync(target, { throwIfNoEntry: false });
if (!info) {
  console.error(`Нечего замерять: ${target} не найден`);
  process.exit(2);
}

const images = info.isDirectory()
  ? await measureImages(target)
  : await measureVideo(target);

if (images.length < 2) {
  console.error(`Картинок слишком мало (${images.length}) — замерять нечего`);
  process.exit(2);
}

const report = varietyReport(images);

console.log(`Картинок: ${images.length}\n`);
console.log("что                     тон    светлота  занято");
for (const s of images) {
  console.log(
    `${s.name.padEnd(22).slice(0, 22)} ${String(Math.round(s.hue)).padStart(4)}°  ` +
      `${s.lum.toFixed(2).padStart(7)}  ${(s.fill * 100).toFixed(0).padStart(5)}%`,
  );
}

console.log(
  `\n       ${"показатель".padEnd(28)}${"замер".padStart(6)}${"планка".padStart(9)}` +
    `${"референс".padStart(10)}${"было".padStart(8)}`,
);
for (const t of VARIETY_TARGETS) {
  const value = report.measured[t.key];
  const ok = !report.failed.includes(t);
  const limit = `${t.cmp === "max" ? "≤" : "≥"} ${t.format(t.limit)}`;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${t.title.padEnd(28)}${t.format(value).padStart(6)}` +
      `${limit.padStart(9)}${t.ref.padStart(10)}${t.was.padStart(8)}`,
  );
}
console.log(
  `\nсамый частый сектор тона: ${report.topSector.from}°–${report.topSector.from + 60}°, ` +
    `в нём ${report.topSector.count} из ${images.length}`,
);
console.log(
  report.failed.length === 0
    ? "\nРазнообразия хватает\n"
    : `\nОднообразно по ${report.failed.length} показателям — картинки ролика похожи друг на друга\n`,
);
process.exit(report.failed.length === 0 ? 0 : 1);
