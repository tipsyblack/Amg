import { OSWALD_700_CYRILLIC, OSWALD_700_LATIN } from "./fontData";

// Шрифт подписей — Oswald 700: узкий плотный гротеск, как в референс-видео,
// и, в отличие от Anton (стоял здесь раньше), с полной кириллицей.
//
// Шрифт вшит в код как base64 (src/remotion/fontData.ts), а не грузится по
// ссылке. Так задумано: пока мы ждали загрузку через delayRender, сборка
// видео дважды падала по таймауту. Теперь ждать нечего — @font-face не делает
// ни одного запроса, и в этом файле нет ни delayRender, ни таймеров
// (в Remotion setTimeout подменён покадровым временем и как страховка не
// работает). Лицензия шрифта — public/fonts/OFL.txt.
const FAMILY = "Oswald Local";

// Запасные шрифты на случай, если что-то пойдёт не так: подписи должны
// остаться узкими и плотными, а не расплыться системным шрифтом.
export const CAPTION_FONT_FAMILY =
  `"${FAMILY}", "Arial Narrow", "Liberation Sans Narrow", Impact, sans-serif`;

// Диапазоны из метаданных Google Fonts: браузер берёт нужный файл по символу.
const SUBSETS = [
  {
    data: OSWALD_700_CYRILLIC,
    unicodeRange: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  },
  {
    data: OSWALD_700_LATIN,
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
];

let injected = false;

export function loadCaptionFont(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;

  const style = document.createElement("style");
  style.textContent = SUBSETS.map(
    ({ data, unicodeRange }) => `@font-face {
  font-family: "${FAMILY}";
  font-style: normal;
  font-weight: 700;
  /* swap: текст никогда не бывает невидимым, даже в первом кадре */
  font-display: swap;
  src: url("${data}") format("woff2");
  unicode-range: ${unicodeRange};
}`,
  ).join("\n");
  document.head.appendChild(style);
}
