// Календарь публикации: сетка месяца, отметки, прошедшее время.
//
// Вся арифметика тут чистая — сеть не нужна. Проверять надо именно её:
// ошибка в сетке даёт съехавшие дни недели, ошибка в поясе — публикацию не в
// тот день, и оба случая замечаются уже по факту.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.KIE_API_KEY = "test-key";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const {
  monthGrid, dayLabel, daysInMonth, weekdayIndex, monthTitle, humanDate,
  prevMonth, nextMonth, hourCells, hourLabel, parseDateTime, pickedMoment,
  todayIn, markedDays, WEEKDAYS,
} = await import("../src/bot/calendar.ts");

console.log("=== длина месяцев ===");
check("август — 31", daysInMonth(2026, 8) === 31);
check("февраль обычного года — 28", daysInMonth(2026, 2) === 28);
check("февраль високосного — 29", daysInMonth(2024, 2) === 29);
check("2100 не високосный", daysInMonth(2100, 2) === 28);
check("2000 високосный", daysInMonth(2000, 2) === 29);

console.log("\n=== дни недели с понедельника ===");
// 1 августа 2026 — суббота. Если сетка съедет, все числа встанут не под теми
// заголовками, и это самая заметная ошибка в календаре.
check("1 авг 2026 — суббота", weekdayIndex(2026, 8, 1) === 5, String(weekdayIndex(2026, 8, 1)));
check("заголовков семь и начинаются с Пн", WEEKDAYS.length === 7 && WEEKDAYS[0] === "Пн");

console.log("\n=== сетка августа 2026 ===");
const today = { year: 2026, month: 8, day: 15 };
const grid = monthGrid(2026, 8, today, new Set([3, 4, 6, 8]));
check("недели по семь клеток", grid.every((w) => w.length === 7), grid.map((w) => w.length).join(","));
check("первая неделя пустая до субботы", grid[0].slice(0, 5).every((c) => c.day === null) && grid[0][5].day === 1, grid[0].map((c) => c.day).join(","));
check("1 августа стоит под «Сб»", WEEKDAYS[grid[0].findIndex((c) => c.day === 1)] === "Сб");
const all = grid.flat().filter((c) => c.day !== null).map((c) => c.day);
check("все 31 день на месте и по порядку", all.length === 31 && all[0] === 1 && all[30] === 31);
check("хвост добит пустыми клетками", grid.at(-1).length === 7);

console.log("\n=== подписи ===");
const cell = (day) => grid.flat().find((c) => c.day === day);
check("сегодняшний день в скобках", dayLabel(cell(15)) === "[15]", dayLabel(cell(15)));
check("занятый день с конвертом", dayLabel(cell(3)) === "✉3", dayLabel(cell(3)));
check("обычный день просто числом", dayLabel(cell(20)) === "20");
check("пустая клетка не пустая строка", dayLabel({ day: null }) === " ");
check("занятый и сегодняшний разом", dayLabel({ day: 15, isToday: true, hasPosts: true }) === "✉[15]");

console.log("\n=== прошлое не выбрать ===");
check("14 августа — прошлое", cell(14).isPast === true);
check("15 августа — не прошлое", cell(15).isPast === false);
check("16 августа — будущее", cell(16).isPast === false);
// Прошлые месяцы целиком закрыты, будущие целиком открыты.
check("июль весь в прошлом", monthGrid(2026, 7, today).flat().filter((c) => c.day).every((c) => c.isPast));
check("сентябрь весь открыт", monthGrid(2026, 9, today).flat().filter((c) => c.day).every((c) => !c.isPast));
check("прошлый год тоже закрыт", monthGrid(2025, 12, today).flat().filter((c) => c.day).every((c) => c.isPast));

console.log("\n=== перелистывание ===");
check("назад из января — декабрь прошлого года", JSON.stringify(prevMonth(2026, 1)) === '{"year":2025,"month":12}');
check("вперёд из декабря — январь следующего", JSON.stringify(nextMonth(2026, 12)) === '{"year":2027,"month":1}');
check("обычный шаг назад", JSON.stringify(prevMonth(2026, 8)) === '{"year":2026,"month":7}');
check("название месяца с годом", monthTitle(2026, 8) === "Август 2026");
check("дата словами", humanDate(2026, 8, 16) === "16 авг. 2026 г.", humanDate(2026, 8, 16));

console.log("\n=== часы ===");
const hoursToday = hourCells(true, 21, 31);
check("часов 24", hoursToday.length === 24);
check("09:00 сегодня уже прошёл", hoursToday[9].isPast === true);
check("21:00 в 21:31 — тоже прошёл", hoursToday[21].isPast === true);
check("22:00 ещё впереди", hoursToday[22].isPast === false);
check("на другой день ничего не прошло", hourCells(false, 21, 31).every((c) => !c.isPast));
check("прошедший час помечен точкой", hourLabel({ hour: 9, isPast: true }) === "· 09:00", hourLabel({ hour: 9, isPast: true }));
check("обычный час без пометки", hourLabel({ hour: 22, isPast: false }) === "22:00");
// Ровно в начале часа он ещё не прошёл: 21:00 в 21:00 — это сейчас.
check("ровно в начале часа он не прошёл", hourCells(true, 21, 0)[21].isPast === false);

console.log("\n=== выбор кнопками ===");
const now = new Date("2026-08-15T09:00:00Z"); // 12:00 МСК
const picked = pickedMoment(2026, 8, 16, 9, "Europe/Moscow", now);
check("16 авг 09:00 МСК = 06:00 UTC", picked.scheduledFor === "2026-08-16T06:00:00.000Z", picked.scheduledFor);
check("пояс приложен", picked.timezone === "Europe/Moscow");
const late = pickedMoment(2026, 8, 15, 9, "Europe/Moscow", now);
check("прошедший час отклонён", "error" in late && /уже прошло/.test(late.error), JSON.stringify(late));
check("и в отказе названы дата и час", "error" in late && /15 авг/.test(late.error) && /09:00/.test(late.error), late.error);

console.log("\n=== ввод текстом ===");
const typed = parseDateTime("16-08-2026, 21:31", "Europe/Moscow", now);
check("формат из подсказки понят", typed.scheduledFor === "2026-08-16T18:31:00.000Z", JSON.stringify(typed));
check("без запятой тоже", parseDateTime("16-08-2026 21:31", "Europe/Moscow", now).scheduledFor === typed.scheduledFor);
check("через точку тоже", parseDateTime("16.08.2026 21:31", "Europe/Moscow", now).scheduledFor === typed.scheduledFor);
check("прошедшая дата отклонена", /уже прошло/.test(parseDateTime("14-08-2026 10:00", "Europe/Moscow", now).error));
check("31 февраля отклонено", /нет 31/.test(parseDateTime("31-02-2026 10:00", "Europe/Moscow", now).error));
check("13-й месяц отклонён", /Месяца 13/.test(parseDateTime("01-13-2026 10:00", "Europe/Moscow", now).error));
check("25 часов отклонены", /не бывает/.test(parseDateTime("16-08-2026 25:00", "Europe/Moscow", now).error));
check("мусор объяснён форматом", /Формат/.test(parseDateTime("когда-нибудь", "Europe/Moscow", now).error));

console.log("\n=== пояс канала, а не сервера ===");
// Сервер по UTC ещё во вчера, когда у канала уже завтра. Подсветка «сегодня»
// должна идти по часам того, кто смотрит.
const nightInMoscow = new Date("2026-08-15T21:30:00Z"); // 00:30 16 авг МСК
const tMoscow = todayIn("Europe/Moscow", nightInMoscow);
const tUtc = todayIn("UTC", nightInMoscow);
check("в Москве уже 16-е", tMoscow.day === 16, JSON.stringify(tMoscow));
check("а по UTC ещё 15-е", tUtc.day === 15, JSON.stringify(tUtc));
check("«сегодня» подсветится по поясу канала", monthGrid(2026, 8, tMoscow).flat().find((c) => c.isToday).day === 16);

console.log("\n=== отметки занятых дней ===");
// Пост на 00:30 по Москве в UTC приходится на предыдущий день — конверт
// должен встать на московскую клетку.
const marks = markedDays(
  ["2026-08-15T21:30:00Z", "2026-08-20T09:00:00Z", "2026-09-01T09:00:00Z"],
  2026, 8, "Europe/Moscow",
);
check("ночной пост отмечен следующим днём", marks.has(16), [...marks].join(","));
check("обычный день отмечен", marks.has(20));
check("чужой месяц не попал", !marks.has(1) && marks.size === 2, [...marks].join(","));
check("мусор в датах не роняет", markedDays(["не дата", ""], 2026, 8, "Europe/Moscow").size === 0);
check("пустой список — пустые отметки", markedDays([], 2026, 8, "Europe/Moscow").size === 0);

console.log(fails === 0 ? "\nВсе проверки пройдены\n" : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
