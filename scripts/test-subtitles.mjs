// Проверка субтитров «по слову»: сборка слов из выравнивания ElevenLabs,
// приблизительный расчёт без выравнивания и выбор слова для кадра.
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const { charactersToWords, estimateWordTimings, wordsForScene } = await import(
  "../src/pipeline/wordTimings.ts"
);

console.log("=== слова из посимвольного выравнивания ===");
// Так отвечает ElevenLabs на /with-timestamps: массив символов и по два
// времени на каждый. Слова собираем сами — пробелы своим словом не считаются.
const phrase = "Илон Маск строит";
const characters = phrase.split("");
const starts = characters.map((_, i) => i * 0.1);
const ends = characters.map((_, i) => i * 0.1 + 0.1);
const words = charactersToWords({
  characters,
  character_start_times_seconds: starts,
  character_end_times_seconds: ends,
});
check("слов ровно три", words.length === 3, words.map((w) => w.text).join("|"));
check("текст без пробелов", words.map((w) => w.text).join(" ") === phrase);
check("первое слово начинается с нуля", words[0].startMs === 0, String(words[0].startMs));
check(
  "времена возрастают и не пересекаются",
  words.every((w, i) => w.endMs > w.startMs && (i === 0 || w.startMs >= words[i - 1].endMs)),
  words.map((w) => `${w.startMs}-${w.endMs}`).join(" "),
);
check(
  "конец последнего слова совпадает с концом фразы",
  Math.abs(words[2].endMs - phrase.length * 100) <= 100,
  `${words[2].endMs} при длине ${phrase.length * 100}`,
);
check("пустое выравнивание не ломает", charactersToWords({}).length === 0);
check(
  "рассинхрон массивов игнорируется",
  charactersToWords({ characters: ["а", "б"], character_start_times_seconds: [0] }).length === 0,
);

console.log("\n=== приблизительный расчёт без выравнивания ===");
const text = "Дело в том, что руки в обучении почти всегда мелкие.";
const est = estimateWordTimings(text, 4);
check("слов столько же, сколько в тексте", est.length === text.split(/\s+/).length, String(est.length));
check("первое слово с нуля", est[0].startMs === 0);
check(
  "последнее слово кончается на длительности реплики",
  Math.abs(est[est.length - 1].endMs - 4000) <= 5,
  String(est[est.length - 1].endMs),
);
check(
  "слова идут подряд без дыр",
  est.every((w, i) => i === 0 || w.startMs === est[i - 1].endMs),
);
check(
  "длинному слову достаётся больше времени",
  (() => {
    const short = est.find((w) => w.text === "в");
    const long = est.find((w) => w.text.startsWith("обучении"));
    return long.endMs - long.startMs > short.endMs - short.startMs;
  })(),
);
check("нулевая длительность не ломает", estimateWordTimings(text, 0).length === 0);
check("пустой текст не ломает", estimateWordTimings("   ", 3).length === 0);

console.log("\n=== выбор источника таймингов ===");
const provider = [{ text: "точно", startMs: 0, endMs: 500, timestampMs: 250, confidence: null }];
check("тайминги провайдера в приоритете", wordsForScene(text, 4, provider) === provider);
check("без них считаем сами", wordsForScene(text, 4, []).length > 1);
check("undefined тоже приводит к расчёту", wordsForScene(text, 4, undefined).length > 1);

console.log("\n=== выбор слова в кадре ===");
// В референсе в кадре ровно одно слово: страниц из нескольких слов с
// подсветкой текущего там нет, поэтому и разбивки на страницы у нас больше нет.
const { wordAt, captionText } = await import("../src/remotion/subtitleWord.ts");
const line = "Илон Маск строит дата-центры для своего ИИ в космосе, ему чё, мало места";
const timed = estimateWordTimings(line, 6);
check("до начала речи слова нет", wordAt(timed, -10) === undefined);
check("в начале — первое", wordAt(timed, 0) === timed[0]);
check("в конце — последнее", wordAt(timed, 999999) === timed[timed.length - 1]);
check(
  "на границе берётся уже начавшееся",
  wordAt(timed, timed[1].startMs) === timed[1],
);
check("на пустом наборе не падает", wordAt([], 100) === undefined);
check(
  "внутри слова показывается оно само",
  timed.every((w) => wordAt(timed, (w.startMs + w.endMs) / 2) === w),
);
// Паузы между словами бывают при тайминге от провайдера: кадр в паузе не должен
// оставаться пустым — слово висит до следующего.
const withGaps = [
  { text: "раз", startMs: 0, endMs: 300 },
  { text: "два", startMs: 900, endMs: 1200 },
];
check("в паузе держится предыдущее слово", wordAt(withGaps, 600) === withGaps[0]);

// Знаки препинания по краям: в обоих референсах в подписях их нет ни одного,
// а у нас в кадр попадало «ДА?» и «МОДЕЛЕЙ.».
const capCases = [
  ["МОДЕЛЕЙ.", "МОДЕЛЕЙ"],
  ["ДА?", "ДА"],
  ["ТОМ,", "ТОМ"],
  ["«Привет»", "Привет"],
  ["скобки)", "скобки"],
  ["...", "..."],           // слово целиком из знаков — оставляем как было
  ["0,5", "0,5"],           // десятичная запятая внутри числа: в референсе есть
  ["2030", "2030"],
  ["как-то", "как-то"],
  ["ё", "ё"],
];
for (const [input, want] of capCases) {
  const got = captionText(input);
  check(`подпись «${input}» → «${want}»`, got === want, `получилось «${got}»`);
}
check("после конца речи держится последнее", wordAt(withGaps, 5000) === withGaps[1]);

console.log("\n=== карточка не наезжает на субтитры ===");
// Так это и сломалось на реальном ролике: карточка повторяет пропорции
// картинки, картинки приходили 9:16, и рамка легла поверх букв. Проверяем
// именно инвариант «низ карточки выше верха заглавных», а не конкретные числа.
const layout = await import("../src/remotion/layout.ts");
const textTop = layout.subtitleTopPx();
const fits = (w, h) => layout.cardBottomPx(layout.cardAspect(w, h)) < textTop;
check(
  "вертикальная 9:16 не достаёт до строки",
  fits(1080, 1920),
  `низ карточки ${layout.cardBottomPx(layout.cardAspect(1080, 1920)).toFixed(0)}, верх букв ${textTop.toFixed(0)}`,
);
check("портрет 3:4 не достаёт", fits(900, 1200));
check("квадрат не достаёт", fits(1024, 1024));
check("совсем узкая картинка тоже", fits(600, 2400));
check("размеры неизвестны — пропорции референса", layout.cardAspect() === layout.CARD_ASPECT);
check(
  "3:4 проходит без обрезки — пропорции берутся как есть",
  Math.abs(layout.cardAspect(900, 1200) - 0.75) < 1e-9,
  String(layout.cardAspect(900, 1200)),
);
check(
  "просвет до строки не меньше заявленного",
  textTop - layout.cardBottomPx(layout.minCardAspect()) >=
    (layout.CARD_TO_TEXT_GAP_PERCENT / 100) * layout.REF_HEIGHT - 1,
);

console.log("\n=== сцена несёт слова дальше в рендер ===");
const { sceneSchema } = await import("../src/types.ts");
const { MIX } = await import("../src/remotion/mix.ts");

console.log("\n=== смена картинки внутри сцены ===");
const base = {
  caption: "C",
  voiceoverText: "текст",
  audioFileName: "a.mp3",
  durationInFrames: 180,
};
check(
  "сцена со второй картинкой валидна",
  sceneSchema.safeParse({
    ...base,
    imageFileName: "scene-0.png",
    swapImageFileName: "scene-0-swap.png",
    swapImageWidth: 900,
    swapImageHeight: 1189,
    swapStartMs: 1200,
  }).success,
);
check(
  "сцена без второй картинки валидна",
  sceneSchema.safeParse({ ...base, imageFileName: "scene-0.png" }).success,
);
check(
  "отрицательный момент смены отвергается",
  !sceneSchema.safeParse({ ...base, swapStartMs: -1 }).success,
);
// Смена не должна успевать наложиться на уход сцены: длительность берётся из
// MIX, и это единственное место, где она задана.
check(
  "длина смены задана и меньше сцены",
  MIX.imageSwapSeconds > 0.2 && MIX.imageSwapSeconds < 1,
  `${MIX.imageSwapSeconds} с`,
);
check(
  "смена короче мягкого стыка не более чем вдвое",
  MIX.imageSwapSeconds >= MIX.softTransitionSeconds,
  `смена ${MIX.imageSwapSeconds} c, стык ${MIX.softTransitionSeconds} с`,
);
const parsed = sceneSchema.safeParse({
  caption: "ТЕСТ",
  voiceoverText: "текст",
  audioFileName: "scene-0.mp3",
  durationInFrames: 90,
  words: [{ text: "текст", startMs: 0, endMs: 400 }],
});
check("схема принимает слова", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
check(
  "сцена без слов тоже валидна",
  sceneSchema.safeParse({
    caption: "ТЕСТ",
    voiceoverText: "текст",
    audioFileName: "scene-0.mp3",
    durationInFrames: 90,
  }).success,
);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
