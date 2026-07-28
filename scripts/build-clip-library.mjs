// Собирает библиотеку клипов с маскотом: десять коротких роликов, которые
// генерируются один раз и дальше переиспользуются во всех видео.
//
//   npm run clips:build           — сгенерировать недостающие
//   npm run clips:build -- --force — перегенерировать всё заново
//   npm run clips:build -- intro-lamp react-nod  — только эти
//
// Идемпотентно: уже готовые клипы пропускаются, потому что каждый стоит денег.
import "dotenv/config";

const { CLIP_LIBRARY, libraryFileName, readyClipIds, ensureLibraryDir } =
  await import("../src/pipeline/clipLibrary.ts");
const { generateLibraryClip } = await import("../src/pipeline/generateClip.ts");
const { getVideoModel } = await import("../src/pipeline/videoModels.ts");
const { config } = await import("../src/pipeline/config.ts");

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));

await ensureLibraryDir();
const ready = await readyClipIds();

const wanted = only.length
  ? CLIP_LIBRARY.filter((clip) => only.includes(clip.id))
  : CLIP_LIBRARY;

if (only.length && wanted.length !== only.length) {
  const known = CLIP_LIBRARY.map((clip) => clip.id).join(", ");
  console.error(`Неизвестный клип. Доступны: ${known}`);
  process.exit(1);
}

const todo = force ? wanted : wanted.filter((clip) => !ready.has(clip.id));

const spec = getVideoModel();
console.log(`Модель: ${spec.title} (${spec.model})`);
console.log(
  `Готово ${ready.size} из ${CLIP_LIBRARY.length}, к генерации ${todo.length}.`,
);
if (todo.length === 0) {
  console.log("Ничего делать не нужно.");
  process.exit(0);
}

// Цена — вслух и до начала: библиотека генерируется редко, и ошибиться в
// количестве легко.
const cost = todo.length * config.clipSeconds * 0.125;
console.log(
  `Примерная стоимость: ${todo.length} × ${config.clipSeconds} с ≈ $${cost.toFixed(2)}\n`,
);

let done = 0;
const failed = [];
for (const clip of todo) {
  process.stdout.write(`[${done + 1}/${todo.length}] ${clip.title}… `);
  try {
    await generateLibraryClip(clip);
    console.log(`готово → assets/clips/${libraryFileName(clip.id)}`);
    done++;
  } catch (error) {
    console.log("не вышло");
    failed.push([clip.id, error instanceof Error ? error.message : String(error)]);
  }
}

console.log(`\nСгенерировано ${done} из ${todo.length}.`);
if (failed.length) {
  console.log("Не получились:");
  for (const [id, message] of failed) console.log(`  ${id} — ${message}`);
  console.log(
    "\nПовторить только их: npm run clips:build -- " +
      failed.map(([id]) => id).join(" "),
  );
  // Ненулевой код: библиотека собрана не полностью, и это должно быть видно
  // в выводе systemd/CI, а не потеряться в логе.
  process.exit(1);
}
