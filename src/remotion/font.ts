import { continueRender, delayRender, staticFile } from "remotion";

// Шрифт подписей — Oswald 700: узкий плотный гротеск, как в референс-видео,
// и, в отличие от Anton (стоял здесь раньше), с полной кириллицей.
//
// Файлы лежат в public/fonts, а не тянутся с fonts.gstatic.com: рендер не
// должен зависеть от внешней сети. Лицензия — public/fonts/OFL.txt.
export const CAPTION_FONT_FAMILY = "Oswald Local";

// Диапазоны из метаданных Google Fonts: браузер берёт нужный файл по символу.
const SUBSETS = [
  {
    file: "fonts/oswald-700-cyrillic.woff2",
    unicodeRange: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  },
  {
    file: "fonts/oswald-700-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
];

// Грузим один раз на модуль: при рендере кадры считаются в одном браузере.
let loaded = false;

export function loadCaptionFont(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;

  const handle = delayRender("Загрузка шрифта подписей");

  Promise.all(
    SUBSETS.map(async ({ file, unicodeRange }) => {
      const face = new FontFace(
        CAPTION_FONT_FAMILY,
        `url(${staticFile(file)}) format('woff2')`,
        { weight: "700", unicodeRange },
      );
      await face.load();
      // Типы DOM в @types/react-dom не описывают FontFaceSet.add.
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
    }),
  )
    .catch((error) => {
      // Без шрифта кадр всё равно нужно отрисовать: иначе рендер встанет.
      console.error("Не удалось загрузить шрифт подписей:", error);
    })
    .finally(() => continueRender(handle));
}
