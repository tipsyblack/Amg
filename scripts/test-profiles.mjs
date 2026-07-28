// Проверка профилей и хранилища состояния бота. Работает на временной папке,
// реальный data/bot-state.json не трогает.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

// state.ts пишет в data/bot-state.json относительно cwd — подменяем cwd.
const workDir = mkdtempSync(path.join(tmpdir(), "amg-profiles-"));
mkdirSync(path.join(workDir, "data"));
process.chdir(workDir);

// Старый формат файла: просто карта сессий, без profiles.
writeFileSync(
  path.join(workDir, "data/bot-state.json"),
  JSON.stringify({ "111": { step: "awaiting_brief", brief: "старый бриф" } }),
);

const state = await import("../src/bot/state.ts");

console.log("=== перенос старого формата состояния ===");
check(
  "сессия из старого файла прочитана",
  state.getSession(111).brief === "старый бриф",
  JSON.stringify(state.getSession(111)),
);
check("профилей пока нет", state.listProfiles(111).length === 0);

console.log("\n=== создание профилей ===");
const tg = state.saveProfile(111, {
  name: "Телеграм-бот",
  brief: "Ты маркетолог. Продукт: нейросети в Телеграм.",
  styleNotes: "плоская векторная иллюстрация",
  referenceLink: "https://drive.google.com/file/d/abc/view",
});
const vk = state.saveProfile(111, { name: "VK", brief: "Продукт для VK." });
check("id короткие и разные", tg.id === "p1" && vk.id === "p2", `${tg.id}, ${vk.id}`);
check("профилей стало два", state.listProfiles(111).length === 2);
check("стиль сохранён", state.getProfile(111, "p1").styleNotes === "плоская векторная иллюстрация");
check("профиль без стиля допустим", state.getProfile(111, "p2").styleNotes === undefined);
check("дата создания записана", typeof tg.createdAt === "string" && tg.createdAt.includes("T"));

console.log("\n=== профили не путаются между чатами ===");
state.saveProfile(222, { name: "Чужой", brief: "b" });
check("у другого чата свой список", state.listProfiles(222).length === 1);
check("свои профили не затронуты", state.listProfiles(111).length === 2);
check("id могут повторяться в разных чатах", state.listProfiles(222)[0].id === "p1");

console.log("\n=== профили переживают сброс сессии ===");
state.updateSession(111, {
  step: "busy",
  brief: "черновик",
  voice: "abc",
  scriptModel: "opus",
});
state.resetSession(111);
check("шаг сброшен", state.getSession(111).step === "idle");
check("бриф очищен", state.getSession(111).brief === undefined);
check("голос сохранён (это настройка)", state.getSession(111).voice === "abc");
// Настройку /model выбирают один раз, а не под каждый ролик — /new её не трёт.
check(
  "модель сценария сохранена (это настройка)",
  state.getSession(111).scriptModel === "opus",
);
check("профили на месте", state.listProfiles(111).length === 2);

console.log("\n=== удаление ===");
check("удаление существующего", state.deleteProfile(111, "p2") === true);
check("остался один", state.listProfiles(111).length === 1);
check("удаление несуществующего не падает", state.deleteProfile(111, "нет") === false);
const reused = state.saveProfile(111, { name: "Снова", brief: "b" });
check("освободившийся id переиспользуется", reused.id === "p2", reused.id);

console.log("\n=== сбор сэмплов для клонирования ===");
// Баг, который это ловит: страховка в withGeneration сбрасывала шаг в "idle"
// после каждого принятого файла, и /done перестаёт распознаваться.
state.updateSession(111, { step: "awaiting_clone_links", cloneName: "Шамиль2" });
state.updateSession(111, { cloneSamples: ["/tmp/s0.mp3"], step: "awaiting_clone_links" });
check("шаг сбора сохранился", state.getSession(111).step === "awaiting_clone_links", state.getSession(111).step);
state.updateSession(111, { cloneSamples: ["/tmp/s0.mp3", "/tmp/s1.mp3"], step: "awaiting_clone_links" });
check("сэмплы накапливаются", state.getSession(111).cloneSamples.length === 2);
check("имя клона держится", state.getSession(111).cloneName === "Шамиль2");
// Даже если шаг сбился, сэмплы остаются — /done как команда их подхватит.
state.updateSession(111, { step: "idle" });
check("сэмплы живы при сбросе шага", (state.getSession(111).cloneSamples ?? []).length === 2);

console.log("\n=== запись на диск в новом формате ===");
const onDisk = JSON.parse(readFileSync(path.join(workDir, "data/bot-state.json"), "utf-8"));
check("есть разделы sessions и profiles", "sessions" in onDisk && "profiles" in onDisk);
check("профили сохранены на диск", onDisk.profiles["111"].length === 2);

process.chdir(tmpdir());
rmSync(workDir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
