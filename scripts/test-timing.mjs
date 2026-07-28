// Проверка ограничения длины ролика и набора вариантов анимации.
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

const { fitToBudget } = await import("../src/pipeline/assets.ts");
const { config } = await import("../src/pipeline/config.ts");
const { sceneMotion, MOTION_CYCLE_LENGTH } = await import("../src/remotion/transitions.ts");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const scene = (frames) => ({
  caption: "c",
  voiceoverText: "v",
  audioFileName: "a.mp3",
  durationInFrames: frames,
});

console.log(`=== лимит: ${config.maxVideoSeconds} с, максимум ${config.maxScenes} сцен ===`);
check("лимит сцен равен 15", config.maxScenes === 15);
check("лимит длины равен 60 с", config.maxVideoSeconds === 60);

console.log("\n=== короткий ролик не трогаем ===");
// Длительности считаем от config.fps, а не числом кадров: fps настраивается
// (по умолчанию 60), и захардкоженные 300 кадров означали бы разное время.
const sec = (seconds) => Math.round(seconds * config.fps);
const short = [scene(sec(10)), scene(sec(10))]; // 20 с
const shortFit = fitToBudget(short);
check("длительности не изменились", shortFit.scenes.every((s, i) => s.durationInFrames === short[i].durationInFrames));
check("превышения нет", shortFit.overBudgetSeconds === 0);
check("итог 20 с", Math.round(shortFit.totalSeconds) === 20, String(shortFit.totalSeconds));

console.log("\n=== чуть длиннее лимита: сжимаем паузы ===");
// 15 сцен по 4.1667 с = 62.5 с при лимите 60
const slightlyFrames = sec(62.5 / 15);
const slightly = Array.from({ length: 15 }, () => scene(slightlyFrames));
const slightlyFit = fitToBudget(slightly);
check("уложились в лимит", slightlyFit.overBudgetSeconds === 0, `осталось лишних ${slightlyFit.overBudgetSeconds} с`);
check("итог не больше 60 с", slightlyFit.totalSeconds <= 60.01, String(slightlyFit.totalSeconds));
check("сцены стали короче", slightlyFit.scenes[0].durationInFrames < slightlyFrames, String(slightlyFit.scenes[0].durationInFrames));

console.log("\n=== сильно длиннее: паузы не спасают, честно сообщаем ===");
const longFrames = sec(100 / 15);
const long = Array.from({ length: 15 }, () => scene(longFrames)); // 100 с
const longFit = fitToBudget(long);
check("превышение не скрыто", longFit.overBudgetSeconds > 5, `${Math.round(longFit.overBudgetSeconds)} с сверх лимита`);
check("паузы всё равно сжаты", longFit.scenes[0].durationInFrames < longFrames, String(longFit.scenes[0].durationInFrames));
check("сцены не выброшены", longFit.scenes.length === 15);
check("ни одна сцена не обнулилась", longFit.scenes.every((s) => s.durationInFrames > 0));

console.log("\n=== лимит длины можно задать на чат ===");
// /length в боте кладёт секунды в сессию, и подгонка должна считаться по ним,
// а не по .env: иначе плотный сценарий вечно «длиннее лимита».
const dense = Array.from({ length: 5 }, () => scene(sec(14))); // 70 с
check("по умолчанию 70 с не влезают", fitToBudget(dense).overBudgetSeconds > 5, `${Math.round(fitToBudget(dense).overBudgetSeconds)} с сверх`);
const withLimit = fitToBudget(dense, 75);
check("с лимитом 75 с — влезают", withLimit.overBudgetSeconds === 0, String(withLimit.overBudgetSeconds));
check("паузы при этом не режутся зря", withLimit.scenes[0].durationInFrames === sec(14), String(withLimit.scenes[0].durationInFrames));

console.log("\n=== варианты анимации ===");
const motions = Array.from({ length: 15 }, (_, i) => sceneMotion(i));
const entries = new Set(motions.map((m) => m.entry));
const exits = new Set(motions.map((m) => m.exit));
const sfx = new Set(motions.map((m) => m.sfx));
check("несколько видов появления", entries.size >= 4, [...entries].join(", "));
check("есть смятие на уходе", exits.has("crumple"));
// Механики, снятые с референса: влёт повёрнутой карточкой, тасовка колодой и
// схлопывание по горизонтали. Проверяем именно их наличие в переборе — без
// этого они могли бы остаться мёртвым кодом.
check("есть влёт с поворотом", entries.has("spin"));
check("есть тасовка", entries.has("shuffle"));
check("есть схлопывание по горизонтали", exits.has("squeeze"));
// Мягкий стык должен быть, но один на несколько резких — как в референсе.
const soft = motions.filter((m) => m.soft).length;
check("мягкий стык есть", soft >= 1, `${soft} из ${motions.length}`);
check("мягких стыков меньшинство", soft * 3 <= motions.length, String(soft));
check("несколько разных звуков", sfx.size >= 3, [...sfx].join(", "));
check(
  "на соседних стыках звук не повторяется",
  motions.every((m, i, arr) => i === 0 || m.sfx !== arr[i - 1].sfx),
  motions.map((m) => m.sfx).join(" "),
);
check("подряд идущие сцены разные", motions.slice(0, 5).every((m, i, arr) => i === 0 || m.entry !== arr[i - 1].entry));
check(
  "выбор детерминирован и повторяется по длине цикла",
  sceneMotion(3).entry === sceneMotion(3).entry &&
    sceneMotion(3 + MOTION_CYCLE_LENGTH).entry === sceneMotion(3).entry,
  `цикл из ${MOTION_CYCLE_LENGTH} вариантов`,
);
// Библиотечные переходы (шторка, переворот, круговая развёртка) должны быть в
// наборе, но не на каждом стыке: иначе теряются свои анимации карточки.
const libraryCuts = motions.filter((m) => m.library);
check("библиотечные переходы есть", libraryCuts.length >= 2, libraryCuts.map((m) => m.library).join(", "));
check("но не на каждом стыке", libraryCuts.length < motions.length / 2, `${libraryCuts.length} из ${motions.length}`);
check(
  "на библиотечном стыке карточка не уезжает сама",
  motions.every((m) => !m.library || m.exit === "none"),
);

console.log("\n=== звуки стыков: файлы есть и они резкие ===");
// Звуки на стыке должны быть щелчками и хлопками, а не наплывами: атака в
// единицы миллисекунд и короткий спад. Проверяем по самим файлам, потому что
// заменить их легко, а услышать разницу в тесте — нет.
const { existsSync, readFileSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
const { tmpdir } = await import("node:os");
const pathMod = await import("node:path");
for (const name of sfx) {
  const file = `public/sfx/${name}.wav`;
  if (!existsSync(file)) {
    check(`${name}: файл на месте`, false, file);
    continue;
  }
  const wav = pathMod.join(tmpdir(), `amg-sfx-${name}.wav`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-ac", "1", "-ar", "44100", "-f", "wav", wav]);
  const b = readFileSync(wav);
  let off = 12;
  while (b.toString("latin1", off, off + 4) !== "data") off += 8 + b.readUInt32LE(off + 4);
  const start = off + 8, sr = 44100, n = (b.length - start) / 2;
  const win = Math.round(sr * 0.005);
  const env = [];
  for (let i = 0; i + win < n; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = b.readInt16LE(start + 2 * (i + j)) / 32768; s += v * v; }
    env.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...env), pi = env.indexOf(peak);
  let di = env.length - 1;
  for (let i = pi; i < env.length; i++) if (env[i] < peak * 0.1) { di = i; break; }
  const attackMs = pi * 5, decayMs = (di - pi) * 5, lengthMs = Math.round((n / sr) * 1000);
  // Атака мгновенная (это и есть «резко»), но хвост слышимый: с совсем
  // коротким спадом звук проскакивал под озвучкой незаметно.
  check(
    `${name}: атака ${attackMs} мс, спад ${decayMs} мс, длит ${lengthMs} мс`,
    attackMs <= 15 && decayMs >= 60 && decayMs <= 320 && lengthMs >= 200 && lengthMs <= 700,
  );
}

console.log("\n=== уровни слоёв в миксе ===");
const { MIX } = await import("../src/remotion/mix.ts");
check("музыка тише всего", MIX.music < MIX.hookSfx && MIX.music < MIX.sfx, `музыка ${MIX.music}`);
check("музыка не глушит речь", MIX.music <= 0.1, String(MIX.music));
check("стык слышен поверх озвучки", MIX.sfx >= 0.6, String(MIX.sfx));
check("но не перебивает её совсем", MIX.sfx <= 0.85, String(MIX.sfx));
check("звук хука не громче стыка", MIX.hookSfx <= MIX.sfx, `${MIX.hookSfx} vs ${MIX.sfx}`);
// Перекрытие — это и есть длительность анимации ухода. Оно должно оставаться
// в пределах запаса тишины после реплики (0.4-0.5 с).
check("резкий стык заметен", MIX.sharpTransitionSeconds >= 0.25, String(MIX.sharpTransitionSeconds));
check("мягкий стык длиннее резкого", MIX.softTransitionSeconds > MIX.sharpTransitionSeconds);
check("оба укладываются в паузу после реплики", MIX.softTransitionSeconds <= 0.5, String(MIX.softTransitionSeconds));

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
