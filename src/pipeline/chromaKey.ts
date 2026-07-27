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
  const keyed = `${outFile}.keyed.png`;
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", inFile,
    // Порядок важен: сначала colorkey делает фон прозрачным, и только потом
    // despill снимает зелёный отсвет с краёв объекта. Наоборот не работает —
    // despill перекрашивает сам фон, и colorkey уже не находит зелёный.
    "-vf",
    `colorkey=${KEY_COLOR}:${SIMILARITY}:${BLEND},despill=type=green:mix=0.4:expand=0,format=rgba`,
    keyed,
  ]);

  const box = await alphaBoundingBox(keyed);
  if (!box) {
    // Совсем прозрачная картинка означает, что модель залила зелёным весь
    // кадр — объекта нет, и накладывать нечего.
    await rm(keyed, { force: true });
    throw new Error(
      "После вырезания фона не осталось изображения: модель, видимо, нарисовала " +
        "один зелёный фон. Попробуйте перегенерировать объект.",
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
