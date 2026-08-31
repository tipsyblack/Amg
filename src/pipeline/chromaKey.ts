import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Прозрачный фон для объектов, которые «прилетают» в кадр поверх картинки
// сцены.
//
// Картиночные модели Kie.ai не гарантируют альфа-канал: у nano-banana его нет
// вовсе, у gpt-image параметры прозрачности не описаны. Поэтому объект
// генерируется на однотонном ярко-зелёном фоне, а прозрачность делаем сами
// ffmpeg — способ полностью под нашим контролем и не зависит от того, что
// поддерживает конкретная модель.
//
// Зелёный выбран не случайно: палитра сцен пастельная, чистого #00FF00 в ней
// не бывает, поэтому вырезание не съедает части объекта.
export const KEY_COLOR = "0x00FF00";

// Насколько цвет угла может отличаться от чистого зелёного, чтобы считаться
// зелёным экраном. 0.18 по нормированному расстоянию RGB — модель редко даёт
// ровно #00FF00, но и не путает зелёный с чем-то ещё.
const GREEN_TOLERANCE = 0.18;
// Насколько углы должны совпадать между собой, чтобы считать фон однотонным.
const CORNER_TOLERANCE = 0.08;
// Доля кадра, выше которой считаем, что фон не вырезался вовсе. Промпт просит
// рисовать предмет С ОТСТУПОМ ОТ КРАЁВ, поэтому объект во весь кадр — это не
// большой объект, а невырезанный фон.
const FULL_FRAME_SHARE = 0.92;
// Насколько далеко от эталонного цвета считать пиксель фоном, и насколько
// плавно уводить края. Подобрано так, чтобы не оставалось зелёной каймы, но и
// не выгрызались тени.
const SIMILARITY = 0.28;
const BLEND = 0.12;

/**
 * Вырезает зелёный фон и обрезает прозрачные поля, чтобы остался только сам
 * объект — тогда позиционирование в кадре предсказуемо.
 */
export async function keyOutBackground(
  inFile: string,
  outFile: string,
): Promise<{ width: number; height: number }> {
  // Вырезаем НЕ обязательно зелёный, а тот цвет, который модель реально
  // положила в фон.
  //
  // Промпт требует зелёный экран, но модель его не всегда слушает. В готовом
  // ролике объект «рука с жестом ок» приехал на ЧЁРНОМ фоне: зелёного в кадре
  // не было, вырезать было нечего, и чёрный прямоугольник уехал в видео как
  // есть. Раньше код умел ловить только обратный случай — когда весь кадр
  // залит зелёным и объекта нет вовсе.
  //
  // Поэтому смотрим на углы картинки. Совпали между собой — это фон, и
  // вырезаем именно его. Зелёный при этом остаётся предпочтительным: despill
  // снимает зелёный отсвет с краёв объекта, и для других цветов такого шага
  // нет.
  const corner = await cornerColor(inFile);
  const green = corner === undefined || isGreen(corner);
  const key = green ? KEY_COLOR : hex(corner);

  const keyed = `${outFile}.keyed.png`;
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", inFile,
    // Порядок важен: сначала colorkey делает фон прозрачным, и только потом
    // despill снимает зелёный отсвет с краёв объекта. Наоборот не работает —
    // despill перекрашивает сам фон, и colorkey уже не находит зелёный.
    "-vf",
    `colorkey=${key}:${SIMILARITY}:${BLEND}` +
      (green ? ",despill=type=green:mix=0.4:expand=0" : "") +
      ",format=rgba",
    keyed,
  ]);

  const box = await alphaBoundingBox(keyed);
  if (!box) {
    // Совсем прозрачная картинка означает, что модель залила фоном весь
    // кадр — объекта нет, и накладывать нечего.
    await rm(keyed, { force: true });
    throw new Error(
      "После вырезания фона не осталось изображения: модель, видимо, нарисовала " +
        "один фон без предмета. Попробуйте перегенерировать объект.",
    );
  }

  // Обратная беда: не вырезалось НИЧЕГО. Промпт просит предмет с отступом от
  // краёв, поэтому непрозрачный кадр целиком — это не большой предмет, а фон,
  // который остался на месте. Раньше такой кадр молча уезжал в ролик чёрным
  // прямоугольником; теперь это ошибка, и бот предложит перерисовать.
  const size = await imageSize(keyed);
  if (
    size &&
    box.width >= size.width * FULL_FRAME_SHARE &&
    box.height >= size.height * FULL_FRAME_SHARE
  ) {
    await rm(keyed, { force: true });
    throw new Error(
      `Фон объекта не вырезался: после обработки непрозрачен весь кадр ` +
        `(${box.width}×${box.height} из ${size.width}×${size.height}). ` +
        "Модель нарисовала предмет на фоне, который не удалось отделить. " +
        "Попробуйте перегенерировать объект.",
    );
  }

  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", keyed,
    "-vf", `crop=${box.width}:${box.height}:${box.x}:${box.y}`,
    outFile,
  ]);
  await rm(keyed, { force: true });
  return { width: box.width, height: box.height };
}

/**
 * Границы непрозрачной части. Считаем в Node по сырым пикселям: ffmpeg-фильтра
 * «обрежь по альфе» нет, а cropdetect работает по яркости и на прозрачном фоне
 * даёт мусор.
 */
export async function alphaBoundingBox(
  file: string,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  const { stdout: sizeOut } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    file,
  ]);
  const [width, height] = sizeOut.trim().split(",").map(Number);
  if (!width || !height) return undefined;

  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v", "error",
      "-i", file,
      "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ],
    { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
  );
  const pixels = stdout as unknown as Buffer;

  // Порог, а не «альфа > 0»: у мягких краёв остаётся почти прозрачный шлейф,
  // и по нему рамка выходит на весь кадр.
  const OPAQUE = 40;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha > OPAQUE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;

  // Небольшой запас по краям, чтобы не срезать обводку объекта.
  const pad = 4;
  const x = Math.max(minX - pad, 0);
  const y = Math.max(minY - pad, 0);
  return {
    x,
    y,
    width: Math.min(maxX + pad, width - 1) - x + 1,
    height: Math.min(maxY + pad, height - 1) - y + 1,
  };
}

/** Размер картинки в пикселях. */
async function imageSize(
  file: string,
): Promise<{ width: number; height: number } | undefined> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]);
  const [width, height] = stdout.trim().split(",").map(Number);
  return width && height ? { width, height } : undefined;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Нормированное расстояние между цветами: 0 — совпали, 1 — чёрный и белый. */
export function colorDistance(a: Rgb, b: Rgb): number {
  return (
    Math.sqrt(
      (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2,
    ) / (255 * Math.sqrt(3))
  );
}

export function isGreen(color: Rgb): boolean {
  return colorDistance(color, { r: 0, g: 255, b: 0 }) <= GREEN_TOLERANCE;
}

export function hex(color: Rgb): string {
  const part = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `0x${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/**
 * Цвет фона по углам картинки.
 *
 * Берём по одному пикселю из каждого угла с небольшим отступом внутрь: точно
 * в углу у некоторых моделей встречается кайма от сжатия. Если четыре угла
 * совпали между собой — это однотонный фон, и его цвет возвращаем. Не
 * совпали — фон неоднородный, вырезать по цвету нечего, и решение остаётся за
 * зелёным по умолчанию.
 */
export async function cornerColor(file: string): Promise<Rgb | undefined> {
  const size = await imageSize(file);
  if (!size) return undefined;
  const { width, height } = size;

  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
  );
  const pixels = stdout as unknown as Buffer;

  const inset = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  const at = (x: number, y: number): Rgb => {
    const i = (y * width + x) * 4;
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
  };
  const corners = [
    at(inset, inset),
    at(width - 1 - inset, inset),
    at(inset, height - 1 - inset),
    at(width - 1 - inset, height - 1 - inset),
  ];

  for (let i = 1; i < corners.length; i++) {
    if (colorDistance(corners[0], corners[i]) > CORNER_TOLERANCE) return undefined;
  }
  return {
    r: corners.reduce((s, c) => s + c.r, 0) / corners.length,
    g: corners.reduce((s, c) => s + c.g, 0) / corners.length,
    b: corners.reduce((s, c) => s + c.b, 0) / corners.length,
  };
}
