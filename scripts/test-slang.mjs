// Говор Шамиля: список словечек, потолок на ролик и разбор команды.
//
// Главное здесь — потолок. Жаргон работает пока он редкий: два слова на
// минуту это характер, десять — пародия на кавказца, и фирменный ролик
// становится неловким. Промпт про это просит, а счётчик сторожит.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  DEFAULT_SLANG,
  SLANG_LIMIT,
  countSlang,
  parseSlangCommand,
  slangPrompt,
  slangProblem,
  readSlang,
  writeSlang,
  SLANG_FILE,
} = await import("../src/pipeline/slang.ts");

const on = (words) => ({ words, on: true });
const sc = (voiceoverText) => ({ caption: "К", voiceoverText, visual: "кадр" });

console.log("=== список по умолчанию ===");
for (const word of ["лее", "моросишь", "чальянка", "родничок", "внатуре", "беспредел", "суета"]) {
  check(`есть «${word}»`, DEFAULT_SLANG.includes(word));
}

console.log("\n=== счёт словечек ===");
check("простое совпадение", countSlang("Лее, что за беспредел", DEFAULT_SLANG) === 2);
// Слова склоняются: «моросишь» в реплике станет «моросит».
check("склонённая форма тоже считается", countSlang("он там моросит", DEFAULT_SLANG) === 1, String(countSlang("он там моросит", DEFAULT_SLANG)));
check("братан от брата", countSlang("слушай, брату скажи", DEFAULT_SLANG) === 1);
check("обычная речь не считается", countSlang("нейросеть рисует картинку", DEFAULT_SLANG) === 0);
check("регистр не важен", countSlang("ЛЕЕ", DEFAULT_SLANG) === 1);
check("пустой список — ноль", countSlang("лее брат", []) === 0);

console.log("\n=== потолок на ролик ===");
const fine = {
  title: "т",
  scenes: [
    sc("Лее, Gemini закрыли для России."),
    sc("Доступ отрезали по адресу, без предупреждения."),
    sc("Внатуре обидно, но выход есть."),
    sc("Открой бота по ссылке в профиле и попробуй бесплатно."),
  ],
};
check("два слова на ролик проходят", slangProblem(fine, on(DEFAULT_SLANG)) === undefined, String(slangProblem(fine, on(DEFAULT_SLANG))));

const overdone = {
  title: "т",
  scenes: [
    sc("Лее, брат, что за беспредел."),
    sc("Внатуре моросят."),
    sc("Суета сплошная, брат."),
    sc("Заходи в бота."),
  ],
};
check("перебор пойман", slangProblem(overdone, on(DEFAULT_SLANG)) !== undefined, String(slangProblem(overdone, on(DEFAULT_SLANG))));
// Отдельно — счёт по всему ролику: в каждой сцене по одному слову, а на
// ролик их уже четыре.
const spread = {
  title: "т",
  scenes: [sc("Лее, вот так."), sc("Внатуре так."), sc("Суета кругом."), sc("Полный беспредел."), sc("Заходи в бота.")],
};
check("счёт по всему ролику", /на ролик 4 при потолке 3/.test(String(slangProblem(spread, on(DEFAULT_SLANG)))), String(slangProblem(spread, on(DEFAULT_SLANG))));
// Два слова в одной реплике слышны как передразнивание даже при малом общем
// счёте, поэтому это отдельная причина.
const crowded = {
  title: "т",
  scenes: [sc("Лее, брат, вот такие дела."), sc("Дальше по делу.")],
};
check("два слова в одной сцене — отдельная беда", /в одной сцене/.test(String(slangProblem(crowded, on(DEFAULT_SLANG)))), String(slangProblem(crowded, on(DEFAULT_SLANG))));
check("названа сцена", /\(1\)/.test(String(slangProblem(crowded, on(DEFAULT_SLANG)))));
check("потолок ровно на границе допустим", slangProblem({
  title: "т",
  scenes: [sc("Лее, вот так."), sc("Внатуре так."), sc("Суета."), sc("Заходи в бота.")],
}, on(DEFAULT_SLANG)) === undefined);
check("пустой список ничего не проверяет", slangProblem(overdone, on([])) === undefined);

console.log("\n=== перебор не должен класть завод ===");
const { isSoftProblem } = await import("../src/pipeline/generateScript.ts");
check("перебор жаргона — мягкое замечание", isSoftProblem(String(slangProblem(overdone, on(DEFAULT_SLANG)))));

console.log("\n=== кусок промпта ===");
const prompt = slangPrompt(on(["лее", "брат"]));
check("слова перечислены", prompt.includes("лее, брат"));
check("потолок назван числом", prompt.includes(String(SLANG_LIMIT)));
check("сказано, что это реакция, а не объяснение", /РЕАКЦИЯ/.test(prompt));
check("в призыве говора нет", /призыве/.test(prompt));
check("выключенный говор ничего не добавляет", slangPrompt({ words: ["лее"], on: false }) === "");
check("пустой список — тоже", slangPrompt(on([])) === "");

console.log("\n=== разбор команды ===");
const base = on(["лее", "брат"]);
check("без аргумента — просто показать", parseSlangCommand("", base).message === "");
check("add добавляет", parseSlangCommand("add суета", base).state.words.includes("суета"));
check("add через запятую", parseSlangCommand("add суета, родничок", base).state.words.length === 4);
check("add не плодит дубли", parseSlangCommand("add лее", base).state.words.length === 2);
check("add без слов — подсказка", "error" in parseSlangCommand("add", base));
check("del убирает", !parseSlangCommand("del лее", base).state.words.includes("лее"));
check("del чужого слова не ломает список", parseSlangCommand("del нет-такого", base).state.words.length === 2);
check("off выключает", parseSlangCommand("off", base).state.on === false);
check("on включает", parseSlangCommand("on", { ...base, on: false }).state.on === true);
check("русские варианты тоже", parseSlangCommand("выкл", base).state.on === false);
check("reset возвращает список", parseSlangCommand("reset", on(["лее"])).state.words.length === DEFAULT_SLANG.length);
check("мусор объяснён", "error" in parseSlangCommand("сделай красиво", base));
check("исходное состояние не портится", base.words.length === 2 && base.on === true);

console.log("\n=== файл ===");
// Список правится из чата, значит переживает перезапуск бота.
const projectDir = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), "amg-slang-"));
process.chdir(dir);
try {
  // Свежий экземпляр модуля: путь к файлу считается от текущей папки, и так
  // проверка не трогает настоящий data/slang.json.
  const fresh = await import(`../src/pipeline/slang.ts?rev=${Date.now()}`);
  check("без файла берётся список по умолчанию", fresh.readSlang().words.length === DEFAULT_SLANG.length);
  fresh.writeSlang({ words: ["лее", "родничок"], on: false });
  const back = fresh.readSlang();
  check("список пережил запись и чтение", back.words.join(",") === "лее,родничок", back.words.join(","));
  check("выключатель тоже", back.on === false);
  // Испорченный файл не должен ронять генерацию.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(fresh.SLANG_FILE, "{ это не json", "utf-8");
  check("испорченный файл не роняет", fresh.readSlang().words.length === DEFAULT_SLANG.length);
} finally {
  process.chdir(projectDir);
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
