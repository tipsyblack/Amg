// Проверка ограничения длины ролика и набора вариантов анимации.
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

const { fitToBudget } = await import("../src/pipeline/assets.ts");
const { config } = await import("../src/pipeline/config.ts");
const { sceneMotion, MOTION_CYCLE_LENGTH, SFX_LEAD_MS, resolveSfx } = await import(
  "../src/remotion/transitions.ts"
);

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
check("сцены стали короче", slightlyFit.scenes[0].durationInFrames < slightlyFrames, String(slightlyFit.scenes[0].durationInFrames));
check("превышение уменьшилось", slightlyFit.overBudgetSeconds < 2.5, `${slightlyFit.overBudgetSeconds.toFixed(1)} с сверх лимита вместо 2.5`);
// Раньше здесь стояло «уложились в лимит»: запас после реплики был 0.4 с, и
// подгонка могла снять по 0.28 с со сцены — 4.2 с на пятнадцати сценах.
// Теперь запас 0.15 с, потому что в референсе стыки идут ПОВЕРХ речи и держать
// под них тишину незачем. Амортизатора больше нет, и это правильно: лишние
// секунды надо убирать из сценария, а не растягивать паузами. Ровно это и
// делает проверка ритма — она ловит перебор слов ДО генерации.
check(
  "но чудес не обещает: остаток честно показан",
  slightlyFit.overBudgetSeconds > 0,
  `${slightlyFit.overBudgetSeconds.toFixed(1)} с`,
);

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

console.log("\n=== брендовая концовка ===");
const { buildOutro } = await import("../src/pipeline/assets.ts");
const outro = buildOutro();
check("концовка собирается", outro !== undefined);
check("название взято из настроек", outro?.title === config.brandName, String(outro?.title));
check("длительность в кадрах, а не секундах", outro?.durationInFrames === Math.round(config.outroSeconds * config.fps), String(outro?.durationInFrames));
// Ссылаться на отсутствующий файл нельзя: Remotion уронит рендер на последнем
// кадре, когда посчитаны уже и озвучка, и все картинки. Поэтому проверяем и
// то, что логотип подставился, и то, что файл под ним реально существует —
// настройка по умолчанию не должна указывать в пустоту.
const fsMod = await import("node:fs");
const pathMod2 = await import("node:path");
check("логотип подставлен", outro?.logoFileName === config.brandLogoFile, String(outro?.logoFileName));
check(
  "файл логотипа лежит в public/brand",
  fsMod.existsSync(pathMod2.resolve("public/brand", config.brandLogoFile)),
  config.brandLogoFile,
);
// Длина ролика должна включать концовку, иначе последний кадр обрежется.
const { videoDataSchema } = await import("../src/types.ts");
const parsed = videoDataSchema.safeParse({
  title: "т", fps: config.fps, width: 1080, height: 1920,
  scenes: [{ caption: "c", voiceoverText: "v", audioFileName: "a.mp3", durationInFrames: 60 }],
  outro: { title: "БРЕНД", durationInFrames: 120 },
});
check("схема принимает концовку", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
check("ролик без концовки тоже валиден", videoDataSchema.safeParse({
  title: "т", fps: config.fps, width: 1080, height: 1920,
  scenes: [{ caption: "c", voiceoverText: "v", audioFileName: "a.mp3", durationInFrames: 60 }],
}).success);

console.log("\n=== появления, закрывающие кадр ===");
// Зум-блюр приходит во весь экран, рваная шторка вырезает сцену по краю —
// таким входам не нужен ни кроссфейд, ни уход предыдущей сцены. Иначе в кадре
// одновременно идут два движения: на рендере уходящая карточка мялась прямо
// под наползающим рваным краем.
const { coversFrame } = await import("../src/remotion/transitions.ts");
check("зум-блюр закрывает кадр", coversFrame({ entry: "zoomIn", exit: "none", sfx: "snap" }) === true);
check("рваная шторка закрывает кадр", coversFrame({ entry: "tornWipe", exit: "none", sfx: "snap" }) === true);
check("обычное появление — нет", coversFrame({ entry: "fade", exit: "none", sfx: "snap" }) === false);
const covering = motions.filter((m) => coversFrame(m));
check("такие появления есть в цикле", covering.length >= 2, `${covering.length} из ${motions.length}`);
check("но не большинство", covering.length * 2 < motions.length, String(covering.length));

console.log("\n=== звуки стыков: файлы есть и стоят по пику ===");
// Звуки двух родов, и требования к ним разные.
//
// Импульс (щелчок, хлопок, снап, удар, поп) — атака в единицы миллисекунд,
// пик в самом начале файла, задержка до стыка нулевая.
//
// Вуш — разгон в десятки и сотни миллисекунд, пик в середине. Требовать от
// него резкой атаки бессмысленно: он по построению другой. Зато у него есть
// своё жёсткое требование — SFX_LEAD_MS должен совпадать с настоящим
// положением пика, иначе удар не попадёт на склейку. Ровно это и проверяем,
// по самим файлам: правка звука не должна молча разойтись с постановкой.
const { existsSync, readFileSync } = await import("node:fs");
const path = (await import("node:path")).default;
const { execFileSync } = await import("node:child_process");
const { tmpdir } = await import("node:os");
const pathMod = await import("node:path");

const SYNTHESIZED = new Set(["click", "clap", "snap", "impact", "pop", "hook"]);

/** Огибающая окнами по 5 мс: положение пика, спад, длина. */
function sfxShape(file) {
  const wav = pathMod.join(tmpdir(), `amg-sfx-${path.basename(file)}`);
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
  return { peakMs: pi * 5, decayMs: (di - pi) * 5, lengthMs: Math.round((n / sr) * 1000) };
}

// pop звучит не на стыке, а при прилёте объекта внутри сцены, поэтому в цикл
// переходов он не входит — и в проверки его нужно внести отдельно, иначе новый
// звук оказался бы единственным непроверенным в наборе.
for (const name of [...sfx, "pop", "swoosh-long"]) {
  const file = `public/sfx/${name}.wav`;
  const imported = !SYNTHESIZED.has(name);
  if (!existsSync(file)) {
    // Записанных звуков в репозитории нет: права на них у того, кто их принёс.
    // Их отсутствие — не поломка, но замена должна быть предусмотрена.
    check(
      `${name}: не импортирован, есть синтезированная замена`,
      imported && resolveSfx(name, []) !== name && SYNTHESIZED.has(resolveSfx(name, [])),
      imported ? `заменяется на ${resolveSfx(name, [])}` : file,
    );
    continue;
  }
  const { peakMs, decayMs, lengthMs } = sfxShape(file);
  if (imported) {
    // Пик обязан совпасть с таблицей — с точностью до кадра при 60 fps.
    check(
      `${name}: пик на ${peakMs} мс, в таблице ${SFX_LEAD_MS[name]} мс`,
      Math.abs(peakMs - SFX_LEAD_MS[name]) <= 1000 / config.fps,
      `расхождение ${Math.abs(peakMs - SFX_LEAD_MS[name])} мс`,
    );
    // Длина ограничена, но чем — зависит от места. Звук стыка не должен
    // звучать половину следующей сцены; звук концовки не должен пережить саму
    // концовку. У длинного вуша поэтому своя мерка, и она не поблажка: 1800 мс
    // против 2000 мс концовки — запас меньше, чем у любого стыкового.
    const maxLengthMs =
      name === "swoosh-long" ? Math.round(config.outroSeconds * 1000) : 1500;
    check(
      `${name}: длина ${lengthMs} мс при пределе ${maxLengthMs}`,
      lengthMs >= 200 && lengthMs <= maxLengthMs,
    );
  } else {
    // Атака мгновенная (это и есть «резко»), но хвост слышимый: с совсем
    // коротким спадом звук проскакивал под озвучкой незаметно.
    check(
      `${name}: атака ${peakMs} мс, спад ${decayMs} мс, длит ${lengthMs} мс`,
      peakMs <= 15 && decayMs >= 60 && decayMs <= 320 && lengthMs >= 200 && lengthMs <= 700,
    );
    // pop в таблицу задержек не входит: он звучит не на стыке, а при прилёте
    // объекта, и ставится по своему таймингу внутри сцены.
    if (SFX_LEAD_MS[name] !== undefined) {
      check(`${name}: ставится прямо на стык`, SFX_LEAD_MS[name] === 0, String(SFX_LEAD_MS[name]));
    }
  }
}

console.log("\n=== замена, когда записанных звуков нет ===");
// Ролик должен собираться на машине, где sfx:import не запускали. Проверяем
// обе стороны: и что замена находится, и что она не ломает правило «на
// соседних стыках звук не повторяется» — иначе подстановка сама создала бы
// два одинаковых удара подряд.
const fallbackNames = motions.map((m) => resolveSfx(m.sfx, []));
check(
  "без импорта все звуки синтезированные",
  fallbackNames.every((n) => SYNTHESIZED.has(n)),
  [...new Set(fallbackNames)].join(", "),
);
check(
  "и на соседних стыках всё равно не повторяются",
  fallbackNames.every((n, i, arr) => i === 0 || n !== arr[i - 1]),
  fallbackNames.join(" "),
);
check(
  "с импортом берётся сам записанный звук",
  resolveSfx("swoosh", ["swoosh"]) === "swoosh",
);
check(
  "неизвестный список = старые данные: берём синтез",
  SYNTHESIZED.has(resolveSfx("swoosh", undefined)),
  resolveSfx("swoosh", undefined),
);
check(
  "у синтезированного звука замены нет и не нужно",
  resolveSfx("impact", []) === "impact",
);

console.log("\n=== спектр звуков: основание, а не один щелчок ===");
// Границы сняты с присланного референса: на девяти стыках и появлениях
// мощность в момент события минус мощность фона за 0.4 с до него. У его
// акцентов спектральный центр 900-6000 Гц и 8-61% энергии ниже 300 Гц.
// У наших первых версий было 5600-9600 Гц и 0.1-0.4% низа — оттого звук
// выходил тонким и «пластиковым»: у click стоял highpass=700, у clap и snap
// полосовые фильтры от 1900 и 4200 Гц, то есть низ срезался целиком.
//
// Сам звук из референса не заимствован, только измерен: там плотный микс с
// чужой озвучкой и музыкой (медиана -6.9 dB, тишины 0.5%), вырезать оттуда
// чистый стингер нечего.
//
// Считаем прямым ДПФ по равномерной сетке 10 Гц. Именно равномерной: с
// шагом 50 Гц метрика промахивалась мимо узкого низкого пика на 130 Гц и
// показывала 3% там, где на деле 12.6%.
const SFX_GRID_STEP = 10;
const SFX_GRID_MAX = 12000;
const SFX_WINDOW_SECONDS = 0.15;

function sfxSpectrum(name) {
  const b = readFileSync(path.resolve("public/sfx", `${name}.wav`));
  const sr = b.readUInt32LE(24);
  const total = (b.length - 44) / 2;
  const n = Math.min(total, Math.round(sr * SFX_WINDOW_SECONDS));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    x[i] = (b.readInt16LE(44 + 2 * i) / 32768) * w;
  }

  let sumAll = 0;
  let sumLow = 0;
  let sumWeighted = 0;
  for (let f = SFX_GRID_STEP; f <= SFX_GRID_MAX; f += SFX_GRID_STEP) {
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * f) / sr;
    for (let i = 0; i < n; i++) {
      const a = step * i;
      re += x[i] * Math.cos(a);
      im -= x[i] * Math.sin(a);
    }
    const mag = Math.sqrt(re * re + im * im);
    sumAll += mag;
    sumWeighted += f * mag;
    if (f < 300) sumLow += mag;
  }
  return { centroid: sumWeighted / sumAll, lowShare: (100 * sumLow) / sumAll };
}

for (const name of ["click", "clap", "snap", "impact", "pop"]) {
  const { centroid, lowShare } = sfxSpectrum(name);
  check(
    `${name}: центр ${Math.round(centroid)} Гц, низ ${lowShare.toFixed(1)}%`,
    centroid >= 900 && centroid <= 6100 && lowShare >= 7 && lowShare <= 65,
  );
}

// Громкость выравнивается отдельным проходом в build-sfx: раньше она держалась
// на подобранных вручную volume= в каждом звуке и разъезжалась при любой
// правке фильтров — после добавления низа разброс дошёл до 5 dB, то есть один
// стык бил, а другой еле шелестел.
const levels = ["click", "clap", "snap", "impact", "pop", "hook"].map((name) => {
  const b = readFileSync(path.resolve("public/sfx", `${name}.wav`));
  const n = (b.length - 44) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(44 + 2 * i) / 32768;
    sum += v * v;
  }
  return { name, db: 20 * Math.log10(Math.sqrt(sum / n)) };
});
const spread =
  Math.max(...levels.map((l) => l.db)) - Math.min(...levels.map((l) => l.db));
check(
  `громкость выровнена, разброс ${spread.toFixed(1)} dB`,
  spread <= 2,
  levels.map((l) => `${l.name} ${l.db.toFixed(1)}`).join(", "),
);

console.log("\n=== хвост тишины у озвучки ===");
// Синтезатор дописывает тишину в конец реплики, и она складывалась с нашим
// запасом: в ролике набегало 10 секунд пауз (13% времени) против примерно 2%
// у референса.
{
  const os2 = await import("node:os");
  const fsp = await import("node:fs/promises");
  const dir = await fsp.mkdtemp(pathMod.join(os2.tmpdir(), "amg-trim-"));
  const file = pathMod.join(dir, "speech.mp3");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=200:duration=1.5",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.9",
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
    "-ar", "44100", "-b:a", "192k", file]);
  const dur = (f) =>
    Number(execFileSync("ffprobe", ["-v", "error", "-show_entries",
      "format=duration", "-of", "csv=p=0", f]).toString().trim());
  const before = dur(file);
  const { trimTrailingSilence } = await import("../src/pipeline/assets.ts");
  await trimTrailingSilence(file);
  const after = dur(file);
  check(
    `хвост тишины срезан: ${before.toFixed(2)} → ${after.toFixed(2)} с`,
    after < before - 0.6 && after > 1.4,
  );
  // Речь трогать нельзя: полторы секунды тона должны остаться целыми.
  check("сама речь не обрезана", after >= 1.5, `${after.toFixed(2)} с`);
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log("\n=== уровни слоёв в миксе ===");
const { MIX } = await import("../src/remotion/mix.ts");
check("музыка тише всего", MIX.music < MIX.hookSfx && MIX.music < MIX.sfx, `музыка ${MIX.music}`);
// Уровень подложки проверяем расчётом, а не «не больше 0.1». Раньше стоял
// именно такой предел, и он молча зависел от того, каким мастерингом трек отдал
// генератор: у Suno около −8 LUFS, у файла, положенного руками, могло быть и
// −20 — при одном множителе разница в подложке двенадцать децибел. Теперь треки
// приводятся к известной громкости, и множитель означает ровно одно: насколько
// подложка тише речи.
const { MUSIC_LUFS } = await import("../src/pipeline/prepareMusic.ts");
const VOICE_LUFS = -14.8; // замер присланного ролика: микс −14.6 и он почти весь речь
const bedUnderVoiceDb = VOICE_LUFS - (MUSIC_LUFS + 20 * Math.log10(MIX.music));
check(
  "подложка садится на 16-20 дБ ниже речи",
  bedUnderVoiceDb >= 16 && bedUnderVoiceDb <= 20,
  `${bedUnderVoiceDb.toFixed(1)} дБ (трек ${MUSIC_LUFS} LUFS, множитель ${MIX.music})`,
);
// Прилёт объекта — внутри сцены, а не на склейке. Громкий как стык, он бы
// читался как склейка там, где её нет; неслышный — не выполнял бы работу.
check(
  "звук объекта тише стыка, но слышен",
  MIX.overlaySfx < MIX.sfx && MIX.overlaySfx >= 0.4,
  `объект ${MIX.overlaySfx}, стык ${MIX.sfx}`,
);
check("стык слышен поверх озвучки", MIX.sfx >= 0.6, String(MIX.sfx));
check("но не перебивает её совсем", MIX.sfx <= 0.85, String(MIX.sfx));
check("звук хука не громче стыка", MIX.hookSfx <= MIX.sfx, `${MIX.hookSfx} vs ${MIX.sfx}`);
// Перекрытие — это и есть длительность анимации ухода. Оно должно оставаться
// в пределах запаса тишины после реплики (0.4-0.5 с).
check("резкий стык заметен", MIX.sharpTransitionSeconds >= 0.25, String(MIX.sharpTransitionSeconds));
check("мягкий стык длиннее резкого", MIX.softTransitionSeconds > MIX.sharpTransitionSeconds);
check("оба укладываются в паузу после реплики", MIX.softTransitionSeconds <= 0.5, String(MIX.softTransitionSeconds));

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);

console.log("\n=== акценты: в референсе их нет ===");
// Искры, звёзды, стрелки и кольца вокруг карточки были моей выдумкой, а не
// замером. Проверка по присланному референсу: полоса над карточкой (верхние
// 10% кадра) пуста на 259 кадрах всех семи частей, а редкие «непустые» кадры
// оказались зум-блюром на стыке, который закрывает кадр целиком.
//
// Код акцентов оставлен — приём рабочий, если однажды захочется отойти от
// референса, — но по умолчанию выключен.
const minimal = {
  title: "т", fps: 60, width: 1080, height: 1920,
  scenes: [{ caption: "c", voiceoverText: "v", audioFileName: "a.mp3", durationInFrames: 60 }],
};
const withoutAccents = videoDataSchema.parse(minimal);
check(
  "в данных ролика акцентов нет, пока их явно не включили",
  withoutAccents.accentsEnabled === undefined,
  String(withoutAccents.accentsEnabled),
);
check(
  "но включить можно",
  videoDataSchema.parse({ ...minimal, accentsEnabled: true }).accentsEnabled === true,
);

const sceneSource = readFileSync(path.resolve("src/remotion/Scene.tsx"), "utf-8");
check(
  "Scene рисует акценты только по флагу",
  /accentsEnabled\s*&&\s*\(\s*<Accents/.test(sceneSource.replace(/\s+/g, " ")),
);
const compSource = readFileSync(
  path.resolve("src/remotion/VideoComposition.tsx"), "utf-8",
);
check(
  "и по умолчанию флаг выключен",
  /accentsEnabled = false/.test(compSource),
);

process.exit(fails === 0 ? 0 : 1);
