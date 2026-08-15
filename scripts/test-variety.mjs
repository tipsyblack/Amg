// Разнообразие картинок: тон и план кадра, описание сцены, проверка повторов.
//
// Откуда взялась вся эта часть — из замера готового ролика против присланного
// референса (кадры 16x16 по области карточки, замер лежит в sceneLook.ts):
//   наш ролик: 12 картинок из 15 в одном секторе тона 30-45°;
//   референс:  в самом частом секторе 8 из 17.
// Композиция при этом у обоих одинаковая — центр тяжести кадра ровно в
// середине, так что дело было именно в цвете и плотности.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  sceneLook,
  lookPrompt,
  lookLabel,
  seedFromTitle,
  SCENE_TONES,
  SCENE_SHOTS,
} = await import("../src/pipeline/sceneLook.ts");
const { buildImagePrompt } = await import("../src/pipeline/assets.ts");
const { frameProblem } = await import("../src/pipeline/scriptRepeat.ts");
const { STYLE_EXAMPLE, isSoftProblem } = await import("../src/pipeline/generateScript.ts");

console.log("=== набор тонов покрывает круг, а не один сектор ===");
const sectors = new Set(SCENE_TONES.map((t) => Math.floor(t.hue / 60)));
check("тона разнесены минимум по четырём секторам", sectors.size >= 4, `${sectors.size} секторов`);
check("есть тёмный тон", SCENE_TONES.some((t) => t.light === "dark"));
check("есть светлый тон", SCENE_TONES.some((t) => t.light === "bright"));
check("есть пустой план", SCENE_SHOTS.some((s) => s.density === "airy"));
check("есть плотный план", SCENE_SHOTS.some((s) => s.density === "busy"));

console.log("\n=== соседние сцены заведомо разные ===");
let sameTone = 0;
let sameShot = 0;
for (let seed = 0; seed < 12; seed++) {
  for (let i = 0; i < 20; i++) {
    const a = sceneLook(i, { seed });
    const b = sceneLook(i + 1, { seed });
    if (a.tone.id === b.tone.id) sameTone++;
    if (a.shot.id === b.shot.id) sameShot++;
  }
}
check("ни одной пары соседей с одним тоном", sameTone === 0, String(sameTone));
check("ни одной пары соседей с одним планом", sameShot === 0, String(sameShot));

console.log("\n=== за ролик набирается весь набор ===");
const twelve = Array.from({ length: 12 }, (_, i) => sceneLook(i, { seed: 0 }));
check(
  "все тона использованы",
  new Set(twelve.map((l) => l.tone.id)).size === SCENE_TONES.length,
  [...new Set(twelve.map((l) => l.tone.id))].join(", "),
);
check(
  "все планы использованы",
  new Set(twelve.map((l) => l.shot.id)).size === SCENE_SHOTS.length,
);
// Главное, ради чего всё затевалось: в ролике должен быть и тёмный кадр, и
// светлый, и пустой, и плотный — у референса это чередование даёт разброс
// светлоты 0.13 против наших 0.09.
check("в ролике есть тёмный кадр", twelve.some((l) => l.tone.light === "dark"));
check("и светлый", twelve.some((l) => l.tone.light === "bright"));
check("и пустой", twelve.some((l) => l.shot.density === "airy"));
check("и плотный", twelve.some((l) => l.shot.density === "busy"));

console.log("\n=== задание повторяемо и зависит от ролика ===");
check(
  "тот же номер даёт то же задание",
  lookLabel(sceneLook(3, { seed: 7 })) === lookLabel(sceneLook(3, { seed: 7 })),
);
// Иначе хук каждого ролика был бы одного цвета, и ролики завода стали бы
// похожи друг на друга так же, как сцены внутри одного.
const firstTones = new Set(
  ["Почему нейросеть рисует шесть пальцев", "Как считают токены", "Зачем модели вода", "Кто пишет музыку"].map(
    (title) => sceneLook(0, { seed: seedFromTitle(title) }).tone.id,
  ),
);
check("разные ролики начинаются с разных тонов", firstTones.size >= 3, [...firstTones].join(", "));
check("номер по названию устойчив", seedFromTitle("абв") === seedFromTitle("абв"));

console.log("\n=== сцены с маскотом ===");
// Джин синий. На холодном фоне он сливается — в замере три «синие» картинки
// нашего ролика оказались как раз его сценами.
for (let i = 0; i < 20; i++) {
  const look = sceneLook(i, { withCharacter: true, seed: i });
  if (look.tone.hue > 90 && look.tone.hue < 300) {
    check(`сцена ${i}: тон не холодный`, false, `${look.tone.id} (${look.tone.hue}°)`);
  }
}
check("у маскота только тёплые и нейтральные тона", true);
check(
  "и планы, где его видно целиком",
  Array.from({ length: 20 }, (_, i) => sceneLook(i, { withCharacter: true, seed: i }).shot.id).every(
    (id) => id === "mid" || id === "close",
  ),
);

console.log("\n=== перерисовка даёт другое задание ===");
// Картинку просят перерисовать, потому что она не понравилась: повторять то же
// задание бессмысленно. И новый тон не должен совпасть с соседями.
let clash = 0;
for (let i = 1; i < 20; i++) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const again = sceneLook(i, { attempt });
    if (again.tone.id === sceneLook(i, {}).tone.id) clash++;
    if (again.tone.id === sceneLook(i - 1, {}).tone.id) clash++;
    if (again.tone.id === sceneLook(i + 1, {}).tone.id) clash++;
  }
}
check("новый тон не совпадает ни с прежним, ни с соседями", clash === 0, String(clash));
// У сцен с маскотом список тонов сужен до трёх, безопасных сдвигов там нет
// вовсе — но перерисовка обязана менять задание и здесь, иначе кнопка
// «перегенерировать» на хуке и финале работала бы вхолостую.
check(
  "у сцены с маскотом задание тоже меняется",
  lookLabel(sceneLook(0, { withCharacter: true, attempt: 1 })) !==
    lookLabel(sceneLook(0, { withCharacter: true })),
  `${lookLabel(sceneLook(0, { withCharacter: true }))} → ${lookLabel(sceneLook(0, { withCharacter: true, attempt: 1 }))}`,
);

console.log("\n=== задание доходит до промпта картинки ===");
const scene = {
  caption: "ШЕСТЬ ПАЛЬЦЕВ",
  voiceoverText: "Казалось бы, рука проще лица.",
  visual: "художник уверенно ведёт линию портрета, под столом скомканы листы",
};
const look = sceneLook(1, { seed: 0 });
const prompt = buildImagePrompt(scene, undefined, false, look);
check("тон кадра в промпте", prompt.includes(look.tone.prompt));
check("план кадра в промпте", prompt.includes(look.shot.prompt));
check("рисуем описание кадра", prompt.includes(scene.visual));
// Реплика в роли описания кадра — это и была причина одинаковых картинок:
// половина фраз ничего не показывает.
check("а не реплику", !prompt.includes(scene.voiceoverText));
check("подпись сцены в промпт не идёт", !prompt.includes(scene.caption));
// Запрет надписей должен оставаться последним словом: модели любят подписывать
// картинку сами.
check(
  "запрет надписей всё ещё последний",
  prompt.lastIndexOf("Экраны устройств") > prompt.lastIndexOf(look.tone.prompt),
);
const noVisual = buildImagePrompt({ caption: "К", voiceoverText: "Реплика без кадра." }, undefined, false, look);
check("без описания кадра берётся реплика", noVisual.includes("Реплика без кадра."));
check("без задания промпт всё равно собирается", buildImagePrompt(scene).includes(scene.visual));
check("в задании оба куска", lookPrompt(look).includes("ТОН КАДРА") && lookPrompt(look).includes("ПЛАН"));
// Цвет содержанию противоречить не может, а план может: «конвейер везёт
// огромные портреты» и «деталей минимум» исключают друг друга. Поэтому у
// плана есть выход, а у тона нет.
check("тон объявлен обязательным", /Тон кадра обязателен/.test(lookPrompt(look)));
check("у плана есть выход", /ближайшим подходящим/.test(lookPrompt(look)));

console.log("\n=== проверка сценария: кадры не должны повторяться ===");
const example = JSON.parse(STYLE_EXAMPLE);
check("у каждой сцены примера есть кадр", example.scenes.every((s) => s.visual));
check("пример проходит проверку", frameProblem(example) === undefined, String(frameProblem(example)));

const noFrames = {
  title: "т",
  scenes: [
    { caption: "A", voiceoverText: "Раз." },
    { caption: "B", voiceoverText: "Два.", visual: "кот на подоконнике" },
    { caption: "C", voiceoverText: "Три." },
  ],
};
check("сцены без кадра названы поимённо", /сцен: 1, 3/.test(String(frameProblem(noFrames))), String(frameProblem(noFrames)));

const sameFrame = {
  title: "т",
  scenes: [
    { caption: "A", voiceoverText: "Раз.", visual: "человек за столом смотрит в ноутбук и хмурится" },
    { caption: "B", voiceoverText: "Два.", visual: "человек за столом смотрит в ноутбук и улыбается" },
    { caption: "C", voiceoverText: "Три.", visual: "конвейер везёт коробки мимо окна" },
  ],
};
check("одинаковые кадры пойманы", /одна и та же картинка/.test(String(frameProblem(sameFrame))), String(frameProblem(sameFrame)));
check("названы номера сцен", /сцен 1 и 2/.test(String(frameProblem(sameFrame))));

// В отличие от речи, у картинок соседство не оправдание: два соседних кадра с
// одним предметом — это ролик, стоящий на месте.
const farApart = {
  title: "т",
  scenes: [
    { caption: "A", voiceoverText: "Раз.", visual: "человек за столом смотрит в ноутбук и хмурится" },
    { caption: "B", voiceoverText: "Два.", visual: "конвейер везёт коробки мимо окна" },
    { caption: "C", voiceoverText: "Три.", visual: "человек за столом смотрит в ноутбук и улыбается" },
  ],
};
check("и далёкие сцены тоже", frameProblem(farApart) !== undefined);

// Предмет ролика законно встречается в разных кадрах — это не повтор.
const sameTopic = {
  title: "Нейросеть рисует руки",
  scenes: [
    { caption: "A", voiceoverText: "Раз.", visual: "нейросеть рисует ладонь на планшете художника" },
    { caption: "B", voiceoverText: "Два.", visual: "нейросеть рисует ладонь на витрине магазина перчаток" },
  ],
};
check("слова темы не считаются повтором", frameProblem(sameTopic) === undefined, String(frameProblem(sameTopic)));
check("пустой сценарий не роняет проверку", frameProblem({ title: "", scenes: [] }) === undefined);

console.log("\n=== что останавливает автопилот, а что нет ===");
// Модель, не осилившая новое поле сценария, не должна класть завод: картинку
// тогда рисуют по реплике — как раньше, хуже задуманного, но не брак.
check("нет описания кадра — не повод останавливаться", isSoftProblem(String(frameProblem(noFrames))));
// А вот одинаковые кадры — дефект содержания, дальше пошли бы деньги.
check("одинаковые кадры останавливают", !isSoftProblem(String(frameProblem(sameFrame))));
check("повтор речи останавливает", !isSoftProblem("ролик повторяется: сцены 1 и 3 говорят одно и то же"));

console.log("\n=== замер разнообразия на настоящих картинках ===");
// Замер должен отличать ролик, где все кадры одного цвета, от ролика, где они
// разные. Проверяем на нарисованных картинках, а не на числах: считает его
// ffmpeg, и ошибка в кропе или в порядке каналов иначе не видна.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const nodePath = (await import("node:path")).default;
const run = promisify(execFile);
const { measureImages, varietyReport, varietyLines } = await import(
  "../src/pipeline/variety.ts"
);

const dir = mkdtempSync(nodePath.join(tmpdir(), "amg-variety-"));
const draw = async (name, color) =>
  run("ffmpeg", [
    "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=64x64`,
    "-frames:v", "1", nodePath.join(dir, name),
  ]);

// Ровно та беда, которую нашли замером: все картинки в песочном беже.
const SAND = ["0xC8A87A", "0xD2B48C", "0xBFA06B", "0xC9AE83", "0xD8BE95", "0xB99C6E"];
for (const [i, c] of SAND.entries()) await draw(`same-${i}.png`, c);
const same = varietyReport(await measureImages(dir));
check("одинаковые по тону картинки пойманы", same.failed.length > 0, `не дотянуло: ${same.failed.length}`);
check(
  "и названы числом: все в одном секторе",
  same.measured.sector === 1,
  `${Math.round(same.measured.sector * 100)}% в секторе ${same.topSector.from}°`,
);
check("в тексте для чата сказано, что похожи", /похожи друг на друга/.test(varietyLines(same)[0]), varietyLines(same)[0]);

rmSync(dir, { recursive: true, force: true });
const dir2 = mkdtempSync(nodePath.join(tmpdir(), "amg-variety2-"));
const draw2 = async (name, color) =>
  run("ffmpeg", [
    "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=64x64`,
    "-frames:v", "1", nodePath.join(dir2, name),
  ]);
// А так выглядит набор тонов из sceneLook: песочный, стальной, мятный,
// ночной, бумажный, закатный.
const VARIED = ["0xD2B48C", "0x7E97A8", "0x8FCFC0", "0x2B2A5E", "0xF2F0E8", "0xE08A6A"];
for (const [i, c] of VARIED.entries()) await draw2(`mix-${i}.png`, c);
const mixed = varietyReport(await measureImages(dir2));
check("разные тона проходят замер", mixed.failed.length === 0, mixed.failed.map((f) => f.title).join(", "));
check("разброс тона вырос", mixed.measured.hue > same.measured.hue, `${mixed.measured.hue.toFixed(0)}° против ${same.measured.hue.toFixed(0)}°`);
check("разброс светлоты вырос", mixed.measured.light > same.measured.light, `${mixed.measured.light.toFixed(2)} против ${same.measured.light.toFixed(2)}`);
check("в тексте для чата сказано, что хватает", /хватает/.test(varietyLines(mixed)[0]), varietyLines(mixed)[0]);
check("пустая папка не роняет замер", (await measureImages(nodePath.join(dir2, "нет-такой"))).length === 0);
// Папка между роликами не чистится: от прошлого ролика остаются лишние
// картинки, если сцен в нём было больше. В замер они попадать не должны.
const onlyTwo = await measureImages(dir2, ["mix-0.png", "mix-3.png"]);
check("замеряются только картинки этого ролика", onlyTwo.length === 2, `${onlyTwo.length} из 6`);
check("список несуществующих файлов даёт пусто", (await measureImages(dir2, ["чужой.png"])).length === 0);
rmSync(dir2, { recursive: true, force: true });

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
