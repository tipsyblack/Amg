// Синтез звуков переходов в public/sfx через ffmpeg. Звуки именно
// синтезируются, а не скачиваются: лицензировать нечего, и набор
// воспроизводим — этот скрипт даёт те же файлы, что лежат в репозитории.
//
// Задача звука на стыке — резкий акцент: атака в пределах нескольких
// миллисекунд. Хвост при этом нужен слышимый — с совсем коротким спадом звук
// на фоне озвучки и музыки проскакивал незаметно, поэтому спады растянуты, а
// атака осталась мгновенной. Проверяет это npm run test:timing — по файлам.
//
// ПРО НИЗ. Первая версия звуков была тонкой и «пластиковой»: у click стоял
// highpass=700, у clap и snap — полосовые фильтры от 1900 и 4200 Гц, то есть
// низ вырезался целиком. Измерение присланного референса показало обратное: у
// его акцентов 9-37% энергии лежит ниже 300 Гц, а спектральный центр в среднем
// 2400 Гц против наших 5600-9600. Именно это основание и отличает солидный
// стингер от щелчка мышью, поэтому каждому звуку добавлена короткая низкая
// составляющая (поле body). Сам референс при этом не заимствован — только
// измерен: звуки по-прежнему синтезируются с нуля.
//
// Формат — wav, а не mp3: у mp3 в начале файла остаётся задержка кодировщика
// (у LAME это ~570 сэмплов, ~13 мс), и Remotion берёт дорожку с нулевой
// позиции вместе с ней. Для щелчка на стыке такая погрешность лишняя, а файлы
// короткие — разница в размере несущественная.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("public/sfx");
mkdirSync(OUT_DIR, { recursive: true });

// random(n) в eval-выражениях ffmpeg даёт шум; exp(-k*t) — спад. Чем больше
// k, тем жёстче звук.
const SOUNDS = {
  // Щелчок: жёсткая атака и звенящий хвост, как клик с призвуком.
  click: {
    duration: 0.28,
    expr:
      "0.9*(random(0)*2-1)*exp(-60*t)" +
      "+0.4*sin(2*PI*2600*t)*exp(-22*t)" +
      "+0.2*sin(2*PI*1300*t)*exp(-14*t)" +
      "",
    // Было highpass=700 — низ срезался целиком.
    filters: "highpass=f=110,lowpass=f=9000:poles=2,volume=0dB",
    body: { freq: 95, decay: 55, gain: 1.0, cutoff: 220 },
  },
  // Хлопок: несколько очень близких всплесков шума (ладонь) плюс затухающий
  // хвост, чтобы хлопок читался поверх озвучки.
  clap: {
    duration: 0.4,
    expr:
      "1.1*(random(1)*2-1)*exp(-45*t)" +
      "+0.6*(random(2)*2-1)*exp(-45*(t-0.014))*gt(t,0.014)" +
      "+0.45*(random(3)*2-1)*exp(-40*(t-0.03))*gt(t,0.03)" +
      "+0.3*(random(6)*2-1)*exp(-14*(t-0.05))*gt(t,0.05)",
    filters: "bandpass=f=1900:width_type=h:width=2200,lowpass=f=7000:poles=2,volume=2dB",
    // Полоса вокруг 1900 Гц задаёт характер хлопка, но низа в ней нет —
    // подмешиваем его отдельной дорожкой, уже после фильтра.
    body: { freq: 110, decay: 55, gain: 7.0, cutoff: 240 },
  },
  // Снап: самый звонкий из набора, с коротким «шипящим» послезвучием.
  snap: {
    duration: 0.24,
    expr:
      "(random(4)*2-1)*exp(-70*t)" +
      "+0.35*(random(7)*2-1)*exp(-18*t)",
    filters: "bandpass=f=4200:width_type=h:width=3000,lowpass=f=8000:poles=2,volume=6dB",
    body: { freq: 130, decay: 90, gain: 5.0, cutoff: 260 },
    // У snap низа чуть меньше расчётной нормы (8.4% против 9-37%), и это
    // осознанно: он самый резкий в наборе, а низ и резкость тянут в разные
    // стороны — низкая волна физически не успевает набрать энергию за
    // несколько миллисекунд. Попытка добрать низ уводила атаку с 10 мс на 20,
    // то есть за порог «звук читается как резкий»,
  },
  // Удар: низ с жёсткой атакой и длинным гулом — под смятие карточки.
  impact: {
    duration: 0.6,
    expr:
      "0.8*sin(2*PI*72*t)*exp(-8*t)" +
      "+0.35*sin(2*PI*150*t)*exp(-14*t)" +
      "+0.7*(random(5)*2-1)*exp(-90*t)",
    filters: "volume=-6dB",
  },
};

function synth(name, { duration, expr, filters, body }) {
  const out = path.join(OUT_DIR, `${name}.wav`);
  const tail =
    "alimiter=limit=0.95,aformat=sample_fmts=s16:channel_layouts=mono";

  // Без низа — один источник, как было.
  if (!body) {
    execFileSync(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `aevalsrc='${expr}':d=${duration}:s=44100`,
        // Уровни выравниваем до ~-20 dB RMS: иначе один стык звучит ударом, а
        // другой еле слышно. Лимитер стоит последним и держит пики под 0 dB.
        "-af", `${filters},${tail}`,
        "-codec:a", "pcm_s16le",
        out,
      ],
      { stdio: "inherit" },
    );
    console.log(`  ${name}.wav`);
    return;
  }

  // Низ подмешиваем ПОСЛЕ полосового фильтра: пропусти мы его через ту же
  // полосу, от него ничего бы не осталось — она для того и стоит, чтобы
  // задать характер в середине спектра.
  //
  // Основание — ШУМ под фильтром, а не чистый синус. Первая попытка была
  // синусом, и низ почти не прибавился: синус занимает несколько бинов
  // спектра, а в референсе низ широкополосный — то есть это удар, а не тон.
  // Поэтому шумовой всплеск, срезанный лоупассом, плюс синус для высоты.
  const bodyExpr =
    `${body.gain}*(random(11)*2-1)*exp(-${body.decay}*t)` +
    `+${body.gain}*0.8*sin(2*PI*${body.freq}*t)*exp(-${body.decay * 0.8}*t)`;
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `aevalsrc='${expr}':d=${duration}:s=44100`,
      "-f", "lavfi", "-i", `aevalsrc='${bodyExpr}':d=${duration}:s=44100`,
      "-filter_complex",
      `[1:a]lowpass=f=${body.cutoff ?? 220}:poles=2[low];` +
        `[0:a]${filters}[top];` +
        `[top][low]amix=inputs=2:duration=longest:normalize=0,${tail}[out]`,
      "-map", "[out]",
      "-codec:a", "pcm_s16le",
      out,
    ],
    { stdio: "inherit" },
  );
  console.log(`  ${name}.wav`);
}

// Звук хука в начале ролика: подъём, переходящий в удар. Он единственный
// длинный — его задача не акцент на стыке, а «остановить палец».
function synthHook() {
  const out = path.join(OUT_DIR, "hook.wav");
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i",
      "aevalsrc='0.32*sin(2*PI*(200*t+1500*t*t))':d=0.5:s=44100",
      "-f", "lavfi", "-i",
      "aevalsrc='0.7*sin(2*PI*85*t)*exp(-9*t)+0.25*sin(2*PI*220*t)*exp(-16*t)':d=0.45:s=44100",
      "-filter_complex",
      "[0:a]afade=t=in:st=0:d=0.12,afade=t=out:st=0.44:d=0.06[riser];" +
        "[1:a]adelay=460|460,afade=t=out:st=0.82:d=0.08[hit];" +
        "[riser][hit]amix=inputs=2:duration=longest:normalize=0," +
        "alimiter=limit=0.9,aformat=sample_fmts=s16:channel_layouts=mono[out]",
      "-map", "[out]", "-t", "0.92",
      "-codec:a", "pcm_s16le",
      out,
    ],
    { stdio: "inherit" },
  );
  console.log("  hook.wav");
}

// Выравнивание громкости — отдельным проходом по готовым файлам.
//
// Раньше уровни держались на подобранных вручную volume= в каждом звуке, и
// стоило тронуть фильтры, как они разъезжались: после добавления низа разброс
// дошёл до 5 dB, то есть один стык бил, а другой еле шелестел. Теперь уровень
// меряется у файла и подгоняется под общий, так что подстройка тембра больше
// не тянет за собой громкость.
const TARGET_RMS_DB = -17;

function measureRms(file) {
  const buf = readFileSync(file);
  // Заголовок wav от ffmpeg — 44 байта, дальше моно 16 бит.
  let sum = 0;
  const n = (buf.length - 44) / 2;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(44 + 2 * i) / 32768;
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / n));
}

function normalize(name) {
  const file = path.join(OUT_DIR, `${name}.wav`);
  const gain = TARGET_RMS_DB - measureRms(file);
  if (Math.abs(gain) < 0.2) return;
  const tmp = path.join(OUT_DIR, `${name}.tmp.wav`);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error", "-i", file,
      "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.97`,
      "-codec:a", "pcm_s16le", tmp,
    ],
    { stdio: "inherit" },
  );
  renameSync(tmp, file);
}

console.log("Синтезирую звуки в public/sfx:");
for (const [name, spec] of Object.entries(SOUNDS)) synth(name, spec);
synthHook();

console.log(`Выравниваю громкость к ${TARGET_RMS_DB} dB RMS:`);
for (const name of [...Object.keys(SOUNDS), "hook"]) {
  normalize(name);
  console.log(`  ${name}: ${measureRms(path.join(OUT_DIR, `${name}.wav`)).toFixed(1)} dB`);
}
console.log("Готово.");
