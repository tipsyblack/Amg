// Готовит присланные звуки из assets/sfx для библиотеки public/sfx.
//
// Чем это отличается от build-sfx.mjs: тот СИНТЕЗИРУЕТ звуки с нуля, здесь же
// они записанные — их приносят готовыми. В репозитории лежат и исходники, и
// результат, так что запускать импорт на новой машине не нужно; он нужен,
// когда добавляют или заменяют звук. Про происхождение файлов и права — в
// assets/sfx/README.md.
//
// Что делает подготовка:
//
//  1. Приводит к моно 44.1 кГц wav — как у синтезированных: у mp3 в начале
//     остаётся задержка кодировщика (~13 мс), а на стыке она лишняя.
//  2. Срезает тишину в начале, чтобы «начало файла» означало «начало звука».
//  3. Обрезает хвост, если он длиннее нужного (у бамбукового вуша 6 секунд,
//     из них 5.5 — реверберация, которая легла бы на следующую сцену).
//  4. Выравнивает громкость по САМОМУ ГРОМКОМУ ОКНУ 300 мс, а не по всему
//     файлу. Для импульса и для протяжного вуша это единственная общая мера:
//     RMS по всему файлу у длинного звука размазывается тишиной, и подгонка
//     под неё загнала бы вуш в клиппинг.
//  5. Меряет, где у готового файла пик — это и есть задержка, с которой звук
//     надо ставить ДО стыка, чтобы удар пришёлся на склейку. Значения идут в
//     SFX_LEAD_MS (src/remotion/transitions.ts), а test:timing сверяет их с
//     файлами, чтобы таблица не разошлась со звуками.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve("assets/sfx");
const OUT_DIR = path.resolve("public/sfx");
const SR = 44100;

// Уровни выведены из синтезированного набора, а не подобраны на глаз. У наших
// стыков самое громкое окно 300 мс лежит в пределах -18.3 (click) … -14.2 дБ
// (impact), у объекта -16.8 (pop), у хука -13.8.
//
// Вушам даём -18, то есть тихий край стыков. Причина: вуш занимает 0.5-1 с
// против 0.24 с у снапа, и при равном уровне окна он звучит тяжелее просто
// потому, что длится дольше. Это отправная точка, её стоит проверить ушами на
// первом ролике.
const SWOOSH_DB = -18;
// Потолок пика. 0.95 у лимитера — это -0.45 дБ; берём -0.6, чтобы подъём не
// упирался в сам лимитер.
const CEILING_DB = -0.6;

const SOURCES = {
  // Короткий средний вуш — рабочая лошадка стыков.
  swoosh: { targetDb: SWOOSH_DB },
  // Светлый и воздушный: низа почти нет (0.3%), хорошо ложится под шторку.
  "swoosh-air": { targetDb: SWOOSH_DB },
  // Тяжёлый: 57% энергии ниже 300 Гц. Под крупное движение.
  "swoosh-deep": { targetDb: SWOOSH_DB },
  // Сухой, с деревянным призвуком. Хвост 6 с обрезаем: работает только начало.
  "swoosh-wood": { targetDb: SWOOSH_DB, maxSeconds: 1.4, fadeSeconds: 0.3 },
  // Длинный кинематографичный: разгон 0.6 с. Для стыка слишком долгий — на
  // такой разгон он залез бы в речь предыдущей сцены. Держим для концовки.
  "swoosh-long": { targetDb: SWOOSH_DB, maxSeconds: 1.8, fadeSeconds: 0.3 },
  // Подъём с вушем — по построению то же, что наш синтезированный hook.
  riser: { targetDb: -14 },
  // Уведомление: мгновенная атака, чистый тон. Альтернатива pop для объекта.
  ding: { targetDb: -17 },
  // Клик мышью. Настоящий, записанный — центр 5450 Гц, низа нет вовсе.
  mouse: { targetDb: -17 },
};

/** Моно 44.1 кГц в память — на этом считаем всё остальное. */
function samples(file) {
  const raw = path.join(OUT_DIR, ".probe.pcm");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", file,
    "-ac", "1", "-ar", String(SR), "-f", "s16le", raw,
  ]);
  const b = readFileSync(raw);
  rmSync(raw, { force: true });
  const x = new Float64Array(b.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(2 * i) / 32768;
  return x;
}

/** Громкость самого громкого окна 300 мс, дБ. */
export function windowDb(x, seconds = 0.3) {
  const win = Math.round(seconds * SR);
  if (x.length <= win) {
    let s = 0;
    for (const v of x) s += v * v;
    return 10 * Math.log10(Math.max(s / win, 1e-12));
  }
  let sum = 0;
  for (let i = 0; i < win; i++) sum += x[i] * x[i];
  let best = sum;
  for (let i = win; i < x.length; i++) {
    sum += x[i] * x[i] - x[i - win] * x[i - win];
    if (sum > best) best = sum;
  }
  return 10 * Math.log10(Math.max(best / win, 1e-12));
}

/** Где пик огибающей, мс от начала файла. Окно 5 мс — как в test:timing. */
export function peakOffsetMs(x) {
  const win = Math.round(0.005 * SR);
  let best = 0;
  let bestIndex = 0;
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) s += x[i + j] * x[i + j];
    if (s > best) { best = s; bestIndex = i; }
  }
  return Math.round((bestIndex / SR) * 1000);
}

function prepare(name, { targetDb, maxSeconds, fadeSeconds }) {
  const source = path.join(SRC_DIR, `${name}.mp3`);
  if (!existsSync(source)) {
    console.log(`  ${name}: источника нет, пропускаю`);
    return null;
  }
  const out = path.join(OUT_DIR, `${name}.wav`);
  const stage = path.join(OUT_DIR, `.${name}.stage.wav`);

  // Порог -60 дБ, а не -45: вуш начинается с еле слышного разгона, и более
  // высокий порог срезал бы сам звук, а не тишину перед ним.
  const filters = ["silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.005"];
  if (maxSeconds !== undefined && fadeSeconds !== undefined) {
    filters.push(`afade=t=out:st=${(maxSeconds - fadeSeconds).toFixed(3)}:d=${fadeSeconds}`);
  }
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", source,
    "-af", filters.join(","),
    ...(maxSeconds !== undefined ? ["-t", String(maxSeconds)] : []),
    "-ac", "1", "-ar", String(SR), "-codec:a", "pcm_s16le", stage,
  ]);

  // Подъём ограничен запасом до потолка, а не только целью по громкости.
  // Первая версия этого не делала, и у резких звуков лимитер съедал разницу:
  // клику мыши для -17 дБ по окну нужно было +8 дБ, пики уходили за 0, и на
  // выходе получалось -22.2 — то есть тише, чем если бы его не трогали вовсе.
  // У щелчка крест-фактор большой по природе: короткий пик и почти ничего
  // вокруг. Такой звук просто не может быть громким по RMS, и честнее
  // остановиться у потолка, чем плющить его лимитером.
  const staged = samples(stage);
  let peak = 0;
  for (const v of staged) if (Math.abs(v) > peak) peak = Math.abs(v);
  const headroom = CEILING_DB - 20 * Math.log10(Math.max(peak, 1e-9));
  const wanted = targetDb - windowDb(staged);
  const gain = Math.min(wanted, headroom);

  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", stage,
    // Лимитер здесь страховка, а не инструмент: подъём уже посчитан так, что
    // пик остаётся под потолком. level=disabled обязателен — по умолчанию
    // alimiter домножает выход на 1/limit и сам же отменяет заданный потолок.
    "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:level=disabled`,
    "-codec:a", "pcm_s16le", out,
  ]);
  rmSync(stage, { force: true });

  const x = samples(out);
  return {
    name,
    lengthMs: Math.round((x.length / SR) * 1000),
    peakMs: peakOffsetMs(x),
    db: windowDb(x),
    // Насколько не дотянули до цели из-за потолка. Ноль — дотянули.
    short: Math.max(0, wanted - gain),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Готовлю звуки из ${SRC_DIR}:`);
  const done = [];
  for (const [name, spec] of Object.entries(SOURCES)) {
    const result = prepare(name, spec);
    if (result) done.push(result);
  }
  if (done.length === 0) {
    console.log("\nНечего импортировать: положите файлы в assets/sfx (см. README там).");
  } else {
    console.log("\nГотово. Задержка до стыка (SFX_LEAD_MS в transitions.ts):");
    for (const r of done) {
      console.log(
        `  ${r.name.padEnd(12)} длина ${String(r.lengthMs).padStart(4)} мс | ` +
          `пик на ${String(r.peakMs).padStart(3)} мс | окно ${r.db.toFixed(1)} дБ` +
          (r.short > 0.3 ? ` (уперлись в потолок, ${r.short.toFixed(1)} дБ не добрали)` : ""),
      );
    }
  }
}
