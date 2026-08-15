import { zonedParts, zonedTimeToUtc } from "../pipeline/zernioPost";

/**
 * Календарь для планирования публикации.
 *
 * Кнопками, а не текстом: набирать «завтра 09:30» каждый раз неудобно, а
 * промахнуться в дате легко. Заодно видно занятые дни — те, на которые уже
 * что-то запланировано.
 *
 * Всё, что здесь считается, считается В ПОЯСЕ КАНАЛА. «Сегодня» на сервере и
 * «сегодня» у человека — разные дни: сервер живёт по UTC, и в полночь по
 * Москве он ещё во вчера. Подсветка текущего дня и отсев прошедших часов
 * должны идти по часам того, кто смотрит.
 */

export const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export const MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

// Неделя начинается с понедельника: у нас так принято, а Date.getDay()
// считает с воскресенья — отсюда сдвиг ниже.
export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export interface DayCell {
  /** null — пустая клетка до начала или после конца месяца. */
  day: number | null;
  isToday: boolean;
  /** День уже прошёл: запланировать на него нельзя. */
  isPast: boolean;
  /** На этот день уже что-то запланировано. */
  hasPosts: boolean;
}

/** Сколько дней в месяце. Месяц человеческий: 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Номер дня недели с понедельника: Пн=0 … Вс=6. */
export function weekdayIndex(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/**
 * Сетка месяца по неделям.
 *
 * `today` — сегодняшняя дата В ПОЯСЕ КАНАЛА, а не на сервере.
 * `marked` — дни этого месяца, на которые уже что-то запланировано.
 */
export function monthGrid(
  year: number,
  month: number,
  today: { year: number; month: number; day: number },
  marked: Set<number> = new Set(),
): DayCell[][] {
  const total = daysInMonth(year, month);
  const lead = weekdayIndex(year, month, 1);
  const cells: DayCell[] = [];

  for (let i = 0; i < lead; i++) {
    cells.push({ day: null, isToday: false, isPast: false, hasPosts: false });
  }
  for (let day = 1; day <= total; day++) {
    const isToday =
      year === today.year && month === today.month && day === today.day;
    const isPast =
      year < today.year ||
      (year === today.year && month < today.month) ||
      (year === today.year && month === today.month && day < today.day);
    cells.push({ day, isToday, isPast, hasPosts: marked.has(day) });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ day: null, isToday: false, isPast: false, hasPosts: false });
  }

  const weeks: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * Подпись клетки.
 *
 * Сегодняшний день в скобках, занятый — с конвертом. Прошедшие дни не прячем:
 * по ним видно, что уже сделано, и пустой первой половиной месяца календарь
 * выглядел бы сломанным.
 */
export function dayLabel(cell: DayCell): string {
  if (cell.day === null) return " ";
  const mark = cell.hasPosts ? "✉" : "";
  return cell.isToday ? `${mark}[${cell.day}]` : `${mark}${cell.day}`;
}

export function monthTitle(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** Дата человеческими словами: «16 авг. 2026 г.». */
export function humanDate(year: number, month: number, day: number): string {
  return `${day} ${MONTHS_SHORT[month - 1]}. ${year} г.`;
}

export interface HourCell {
  hour: number;
  /** Час на сегодня уже прошёл — запланировать на него нельзя. */
  isPast: boolean;
}

/**
 * Сетка часов. Прошедшие часы показываем, но помечаем: убирать их — значит
 * рвать привычную сетку, а молча принимать — значит планировать в прошлое.
 */
export function hourCells(
  isToday: boolean,
  currentHour: number,
  currentMinute = 0,
): HourCell[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    // Текущий час считаем прошедшим: «запланировать на 21:00» в 21:31 — это
    // прошлое, и площадка такую задачу отвергнет.
    isPast: isToday && (hour < currentHour || (hour === currentHour && currentMinute > 0)),
  }));
}

export function hourLabel(cell: HourCell): string {
  const time = `${String(cell.hour).padStart(2, "0")}:00`;
  return cell.isPast ? `· ${time}` : time;
}

/**
 * Разбор даты и времени, набранных руками.
 *
 * Форматы: «15-08-2026, 21:31», «15-08-2026 21:31», «15.08.2026 21:31».
 * Нужен, потому что кнопки дают только целые часы, а иногда нужно 21:31.
 */
export function parseDateTime(
  input: string,
  timeZone: string,
  now: Date = new Date(),
): { scheduledFor: string; timezone: string } | { error: string } {
  const text = input.trim().replace(",", " ").replace(/\s+/g, " ");
  const match = text.match(
    /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})\s+(\d{1,2})[:.](\d{2})$/,
  );
  if (!match) {
    return {
      error:
        "Не разобрал. Формат: 15-08-2026, 21:31 — или выберите кнопками.",
    };
  }
  const [, d, m, y, h, min] = match.map(Number) as unknown as number[];
  if (m < 1 || m > 12) return { error: `Месяца ${m} не бывает.` };
  if (d < 1 || d > daysInMonth(y, m)) {
    return { error: `В этом месяце нет ${d}-го числа.` };
  }
  if (h > 23 || min > 59) return { error: `Такого времени не бывает: ${h}:${match[5]}` };

  const when = zonedTimeToUtc(
    { year: y, month: m, day: d, hours: h, minutes: min },
    timeZone,
  );
  if (when.getTime() <= now.getTime()) {
    return { error: "Это время уже прошло. Выберите будущее." };
  }
  return { scheduledFor: when.toISOString(), timezone: timeZone };
}

/**
 * Момент публикации из выбранных кнопками дня и часа.
 *
 * Отдельно от разбора текста: тут нечего парсить, но проверить прошлое надо
 * так же — между показом календаря и нажатием кнопки могло пройти время.
 */
export function pickedMoment(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
  now: Date = new Date(),
): { scheduledFor: string; timezone: string } | { error: string } {
  const when = zonedTimeToUtc(
    { year, month, day, hours: hour, minutes: 0 },
    timeZone,
  );
  if (when.getTime() <= now.getTime()) {
    return {
      error:
        `${humanDate(year, month, day)}, ${String(hour).padStart(2, "0")}:00 — ` +
        "это время уже прошло. Выберите другое.",
    };
  }
  return { scheduledFor: when.toISOString(), timezone: timeZone };
}

/** Сегодняшняя дата в поясе канала. */
export function todayIn(timeZone: string, now: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
} {
  return zonedParts(now, timeZone);
}

/**
 * Какие дни месяца заняты — из списка уже запланированных публикаций.
 *
 * Считаем в поясе канала: пост на 00:30 по Москве в UTC приходится на
 * предыдущий день, и без пересчёта конверт встал бы не на ту клетку.
 */
export function markedDays(
  scheduled: string[],
  year: number,
  month: number,
  timeZone: string,
): Set<number> {
  const days = new Set<number>();
  for (const iso of scheduled) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) continue;
    const parts = zonedParts(at, timeZone);
    if (parts.year === year && parts.month === month) days.add(parts.day);
  }
  return days;
}
