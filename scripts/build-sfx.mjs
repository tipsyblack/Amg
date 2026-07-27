// Синтез звуков переходов в public/sfx через ffmpeg. Звуки именно
// синтезируются, а не скачиваются: лицензировать нечего, и набор
// воспроизводим — этот скрипт даёт те же файлы, что лежат в репозитории.
//
// Задача звука на стыке — резкий акцент: атака в пределах нескольких
// миллисекунд. Хвост при этом нужен слышимый — с совсем коротким спадом звук
// на фоне озвучки и музыки проскакивал незаметно, поэтому спады растянуты, а
// атака осталась мгновенной. Проверяет это npm run test:timing — по файлам.
//
// Формат — wav, а не mp3: у mp3 в начале файла остаётся задержка кодировщика
// (у LAME это ~570 сэмплов, ~13 мс), и Remotion берёт дорожку с нулевой
// позиции вместе с ней. Для щелчка на стыке такая погрешность лишняя, а файлы
// короткие — разница в размере несущественная.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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
      "+0.2*sin(2*PI*1300*t)*exp(-14*t)",
    filters: "highpass=f=700,volume=0dB",
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
    filters: "bandpass=f=1900:width_type=h:width=2200,volume=6dB",
  },
  // Снап: самый звонкий из набора, с коротким «шипящим» послезвучием.
  snap: {
    duration: 0.24,
    expr:
      "(random(4)*2-1)*exp(-70*t)" +
      "+0.35*(random(7)*2-1)*exp(-18*t)",
    filters: "bandpass=f=4200:width_type=h:width=3000,volume=6dB",
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

function synth(name, { duration, expr, filters }) {
  const out = path.join(OUT_DIR, `${name}.wav`);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `aevalsrc='${expr}':d=${duration}:s=44100`,
      // Уровни выравниваем до ~-20 dB RMS: иначе один стык звучит ударом, а
      // другой еле слышно. Лимитер стоит последним и держит пики под 0 dB.
      "-af", `${filters},alimiter=limit=0.95,aformat=sample_fmts=s16:channel_layouts=mono`,
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

console.log("Синтезирую звуки в public/sfx:");
for (const [name, spec] of Object.entries(SOUNDS)) synth(name, spec);
synthHook();
console.log("Готово.");
