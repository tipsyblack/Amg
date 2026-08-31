// Генерирует src/remotion/fontData.ts — шрифт подписей, вшитый в код как
// base64. Так @font-face не делает сетевых запросов, и рендеру не нужно
// ничего ждать: никакого delayRender, который может истечь по таймауту.
//
// Запуск после замены файлов шрифта:  node scripts/build-font-data.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const SUBSETS = [
  {
    constName: "OSWALD_700_CYRILLIC",
    file: "public/fonts/oswald-700-cyrillic.woff2",
  },
  {
    constName: "OSWALD_700_LATIN",
    file: "public/fonts/oswald-700-latin.woff2",
  },
];

const parts = [
  "// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не правьте руками.",
  "// Пересобрать: node scripts/build-font-data.mjs",
  "//",
  "// Шрифт подписей в base64. Вшит в код намеренно: при загрузке по ссылке",
  "// рендер приходилось ждать через delayRender, и это ожидание дважды",
  "// валило сборку видео по таймауту. Лицензия — public/fonts/OFL.txt.",
  "",
];

for (const { constName, file } of SUBSETS) {
  const buffer = await readFile(path.join(ROOT, file));
  parts.push(
    `// ${file} (${buffer.length} байт)`,
    `export const ${constName} =`,
    `  "data:font/woff2;base64,${buffer.toString("base64")}";`,
    "",
  );
}

const outFile = path.join(ROOT, "src/remotion/fontData.ts");
await writeFile(outFile, parts.join("\n"), "utf-8");
console.log(`Готово: ${path.relative(ROOT, outFile)}`);
