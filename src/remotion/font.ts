import { continueRender, delayRender, staticFile } from "remotion";

// Шрифт подписей — Oswald 700: узкий плотный гротеск, как в референс-видео,
// и, в отличие от Anton (стоял здесь раньше), с полной кириллицей.
//
// Файлы лежат в public/fonts, а не тянутся с fonts.gstatic.com: рендер не
// должен зависеть от внешней сети. Лицензия — public/fonts/OFL.txt.
const FAMILY = "Oswald Local";

// Если шрифт по какой-то причине не встанет, подписи всё равно должны
// остаться узкими и плотными, а не расплыться системным шрифтом.
export const CAPTION_FONT_FAMILY =
  `"${FAMILY}", "Arial Narrow", "Liberation Sans Narrow", Impact, sans-serif`;

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

// Ждём шрифт не дольше этого: лучше отрендерить кадр запасным шрифтом, чем
// уронить весь рендер по таймауту delayRender. Локальные файлы встают за
// десятки миллисекунд, так что в норме ожидание незаметно.
const MAX_WAIT_MS = 3000;

let started = false;

export function loadCaptionFont(): void {
  if (started || typeof document === "undefined") return;
  started = true;

  // Объявляем шрифт декларативно через CSS: браузер сам подхватит файлы при
  // отрисовке текста, без обращения к FontFace API из JS.
  const style = document.createElement("style");
  style.textContent = SUBSETS.map(
    ({ file, unicodeRange }) => `@font-face {
  font-family: "${FAMILY}";
  font-style: normal;
  font-weight: 700;
  /* swap, не block: при block текст на время загрузки невидим, и кадр,
     снятый в этот момент, вышел бы пустым. */
  font-display: swap;
  src: url("${staticFile(file)}") format("woff2");
  unicode-range: ${unicodeRange};
}`,
  ).join("\n");
  document.head.appendChild(style);

  const handle = delayRender("Загрузка шрифта подписей", {
    timeoutInMilliseconds: MAX_WAIT_MS * 3,
  });

  // Гонка с таймером: continueRender вызывается при любом исходе и заведомо
  // раньше, чем сработает таймаут delayRender.
  const timer = new Promise<void>((resolve) => setTimeout(resolve, MAX_WAIT_MS));
  const fontsReady = Promise.all([
    // Кириллица и латиница лежат в разных файлах — просим оба.
    document.fonts.load(`700 100px "${FAMILY}"`, "Пример"),
    document.fonts.load(`700 100px "${FAMILY}"`, "Sample"),
  ]).then(() => undefined);

  Promise.race([fontsReady, timer])
    .catch((error) => {
      console.error("Шрифт подписей не загрузился, беру запасной:", error);
    })
    .finally(() => continueRender(handle));
}
