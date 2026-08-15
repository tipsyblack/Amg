// Скорость речи: разбор команды, пределы, и главное — доходит ли она до
// запроса синтезатора.
//
// Последнее и есть суть: настройка KIE_TTS_SPEED в проекте была давно, но
// уходила ТОЛЬКО через прокси Kie.ai. Единая озвучка идёт прямым ElevenLabs,
// и там скорость не отправлялась вовсе — то есть в .env её можно было
// поставить, а на роликах это не отражалось никак.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "el-test";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const { parseSpeed, clampSpeed, describeSpeed, setSpeechSpeed, speechSpeed, MIN_SPEED, MAX_SPEED } =
  await import("../src/pipeline/speech.ts");
const { config } = await import("../src/pipeline/config.ts");

console.log("=== значение по умолчанию выведено замером ===");
// Наш ролик: 2.06 слова в секунду. Референс: 2.33. Отношение 1.13.
check("по умолчанию 1.13", Math.abs(config.ttsSpeed - 1.13) < 0.001, String(config.ttsSpeed));
check(
  "это и есть отношение к референсу",
  Math.abs(2.06 * config.ttsSpeed - 2.33) < 0.02,
  `2.06 × ${config.ttsSpeed} = ${(2.06 * config.ttsSpeed).toFixed(2)} слов/с`,
);

console.log("\n=== разбор команды ===");
check("дробное число", parseSpeed("1.15") === 1.15);
check("запятая вместо точки", parseSpeed("1,15") === 1.15);
check("проценты", parseSpeed("115%") === 1.15);
check("проценты с пробелом", parseSpeed("115 %") === 1.15);
check("обычная скорость", parseSpeed("1") === 1);
check("пустой аргумент — не ошибка, а показ текущей", parseSpeed("").error === "");
check("мусор объяснён примерами", /Примеры/.test(parseSpeed("быстрее").error));
check("ноль отклонён", typeof parseSpeed("0") === "object");
check("отрицательное отклонено", typeof parseSpeed("-1") === "object");

console.log("\n=== пределы ===");
check(`слишком быстро (${MAX_SPEED + 0.3}) отклонено`, /за пределами/.test(parseSpeed(String(MAX_SPEED + 0.3)).error));
check(`слишком медленно (${MIN_SPEED - 0.2}) отклонено`, /за пределами/.test(parseSpeed(String(MIN_SPEED - 0.2)).error));
check("в отказе объяснено, почему", /плыть/.test(parseSpeed("2").error));
check("граница сверху допустима", parseSpeed(String(MAX_SPEED)) === MAX_SPEED);
check("граница снизу допустима", parseSpeed(String(MIN_SPEED)) === MIN_SPEED);
check("clamp режет выше предела", clampSpeed(5) === MAX_SPEED);
check("clamp режет ниже предела", clampSpeed(0.1) === MIN_SPEED);
check("мусор в clamp — обычная скорость", clampSpeed(NaN) === 1 && clampSpeed(0) === 1);

console.log("\n=== описание для чата ===");
check("ускорение в процентах", /на 13% быстрее/.test(describeSpeed(1.13)), describeSpeed(1.13));
check("замедление тоже", /на 10% медленнее/.test(describeSpeed(0.9)), describeSpeed(0.9));
check("единица названа обычной", /обычная/.test(describeSpeed(1)), describeSpeed(1));

console.log("\n=== скорость прогона перекрывает .env ===");
setSpeechSpeed(undefined);
check("без переопределения берётся .env", speechSpeed(1.13) === 1.13);
setSpeechSpeed(1.2);
check("переопределение действует", speechSpeed(1.13) === 1.2);
setSpeechSpeed(9);
check("и оно тоже в пределах", speechSpeed(1.13) === MAX_SPEED);
setSpeechSpeed(undefined);
check("сброс возвращает .env", speechSpeed(1.13) === 1.13);

console.log("\n=== доходит ли до синтезатора ===");
// Прямой ElevenLabs: тот самый путь, где скорости не было вовсе.
let sent;
globalThis.fetch = async (url, init = {}) => {
  sent = { url: String(url), body: JSON.parse(init.body) };
  return new Response(
    JSON.stringify({ audio_base64: Buffer.from("x").toString("base64"), alignment: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
const { synthesizeSpeechDirect } = await import("../src/pipeline/elevenlabs.ts");
setSpeechSpeed(1.15);
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const dir = mkdtempSync(path.join(tmpdir(), "amg-speed-"));
await synthesizeSpeechDirect("текст", path.join(dir, "a.mp3"), undefined, undefined, true);
check("прямой путь шлёт speed", sent.body.voice_settings?.speed === 1.15, JSON.stringify(sent.body.voice_settings));
check("остальные настройки голоса на месте", typeof sent.body.voice_settings?.stability === "number");

// Путь через прокси Kie.ai — там настройка была и раньше, но теперь общая.
const { buildTtsInput } = await import("../src/pipeline/generateVoiceover.ts");
check("путь Kie.ai шлёт ту же скорость", buildTtsInput("текст", "voice").speed === 1.15, String(buildTtsInput("т", "v").speed));

console.log("\n=== бюджет слов растёт вместе со скоростью ===");
// Ускорили речь и не тронули бюджет — ролик выйдет короче лимита, и мы просто
// потеряем секунды, за которые могли бы что-то рассказать.
const { wordBudget, minSceneCount } = await import("../src/pipeline/generateScript.ts");
setSpeechSpeed(1);
const normal = wordBudget(60);
setSpeechSpeed(1.13);
const faster = wordBudget(60);
check("на обычной скорости 126 слов", normal === 126, String(normal));
check("на ускоренной больше", faster > normal, `${faster} против ${normal}`);
check(
  "ровно во столько же раз",
  Math.abs(faster / normal - 1.13) < 0.02,
  `${(faster / normal).toFixed(3)}`,
);
check("сцен тоже становится больше", minSceneCount(60) >= Math.ceil(normal / 14));
setSpeechSpeed(undefined);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
