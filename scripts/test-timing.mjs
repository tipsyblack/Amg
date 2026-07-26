// Проверка ограничения длины ролика и набора вариантов анимации.
process.env.OPENROUTER_API_KEY = "k";
process.env.KIE_API_KEY = "k";

const { fitToBudget } = await import("../src/pipeline/assets.ts");
const { config } = await import("../src/pipeline/config.ts");
const { sceneMotion } = await import("../src/remotion/transitions.ts");

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
const short = [scene(300), scene(300)]; // 20 с
const shortFit = fitToBudget(short);
check("длительности не изменились", shortFit.scenes.every((s, i) => s.durationInFrames === short[i].durationInFrames));
check("превышения нет", shortFit.overBudgetSeconds === 0);
check("итог 20 с", Math.round(shortFit.totalSeconds) === 20, String(shortFit.totalSeconds));

console.log("\n=== чуть длиннее лимита: сжимаем паузы ===");
// 15 сцен по 125 кадров = 1875 кадров = 62.5 с, лимит 1800
const slightly = Array.from({ length: 15 }, () => scene(125));
const slightlyFit = fitToBudget(slightly);
check("уложились в лимит", slightlyFit.overBudgetSeconds === 0, `осталось лишних ${slightlyFit.overBudgetSeconds} с`);
check("итог не больше 60 с", slightlyFit.totalSeconds <= 60.01, String(slightlyFit.totalSeconds));
check("сцены стали короче", slightlyFit.scenes[0].durationInFrames < 125, String(slightlyFit.scenes[0].durationInFrames));

console.log("\n=== сильно длиннее: паузы не спасают, честно сообщаем ===");
const long = Array.from({ length: 15 }, () => scene(200)); // 100 с
const longFit = fitToBudget(long);
check("превышение не скрыто", longFit.overBudgetSeconds > 5, `${Math.round(longFit.overBudgetSeconds)} с сверх лимита`);
check("паузы всё равно сжаты", longFit.scenes[0].durationInFrames < 200, String(longFit.scenes[0].durationInFrames));
check("сцены не выброшены", longFit.scenes.length === 15);
check("ни одна сцена не обнулилась", longFit.scenes.every((s) => s.durationInFrames > 0));

console.log("\n=== варианты анимации ===");
const motions = Array.from({ length: 15 }, (_, i) => sceneMotion(i));
const entries = new Set(motions.map((m) => m.entry));
const exits = new Set(motions.map((m) => m.exit));
const sfx = new Set(motions.map((m) => m.sfx));
check("несколько видов появления", entries.size >= 4, [...entries].join(", "));
check("есть смятие на уходе", exits.has("crumple"));
check("есть наложение на входе", entries.has("overlay"));
check("несколько разных звуков", sfx.size >= 3, [...sfx].join(", "));
check("подряд идущие сцены разные", motions.slice(0, 5).every((m, i, arr) => i === 0 || m.entry !== arr[i - 1].entry));
check("выбор детерминирован", sceneMotion(3).entry === sceneMotion(3).entry && sceneMotion(9).entry === sceneMotion(3).entry);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
