// Проверка субтитров «по слову»: сборка слов из выравнивания ElevenLabs,
// приблизительный расчёт без выравнивания и разбивка на страницы.
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
const text = "Прикол в том, что в космосе минус двести семьдесят.";
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
    const long = est.find((w) => w.text.startsWith("семьдесят"));
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

console.log("\n=== разбивка на страницы ===");
const { buildSubtitlePages, pageAt } = await import("../src/remotion/subtitlePages.ts");
const line = "Илон Маск строит дата-центры для своего ИИ в космосе, ему чё, мало места";
const pages = buildSubtitlePages(estimateWordTimings(line, 6));
check("страниц несколько", pages.length >= 3, String(pages.length));
check(
  "в каждой странице не больше 26 символов",
  pages.every((p) => p.tokens.reduce((n, t) => n + t.text.length + 1, 0) <= 27),
  pages.map((p) => p.tokens.map((t) => t.text).join(" ")).join(" | "),
);
check(
  "все слова разошлись по страницам",
  pages.reduce((sum, p) => sum + p.tokens.length, 0) === line.split(/\s+/).length,
);
check(
  "страницы идут по времени",
  pages.every((p, i) => i === 0 || p.startMs >= pages[i - 1].startMs),
);
// Это и была причина выносить разбивку в свой модуль: createTikTokStyleCaptions
// группирует по ПАУЗАМ, а у слитных таймингов пауз нет — библиотека сама по
// себе отдаёт одну страницу на всю реплику.
const { createTikTokStyleCaptions } = await import("@remotion/captions");
const libraryOnly = createTikTokStyleCaptions({
  captions: estimateWordTimings(line, 6),
  combineTokensWithinMilliseconds: 1400,
}).pages;
check(
  "без нашей разбивки библиотека даёт одну страницу",
  libraryOnly.length === 1,
  `страниц у библиотеки: ${libraryOnly.length}`,
);

console.log("\n=== выбор текущей страницы ===");
check("до начала речи страницы нет", pageAt(pages, -10) === undefined);
check("в начале — первая", pageAt(pages, 0) === pages[0]);
check("в конце — последняя", pageAt(pages, 999999) === pages[pages.length - 1]);
check(
  "на границе берётся уже начавшаяся",
  pageAt(pages, pages[1].startMs) === pages[1],
);
check("на пустом наборе не падает", pageAt([], 100) === undefined);
check("пустые слова не дают страниц", buildSubtitlePages([]).length === 0);

console.log("\n=== сцена несёт слова дальше в рендер ===");
const { sceneSchema } = await import("../src/types.ts");
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
