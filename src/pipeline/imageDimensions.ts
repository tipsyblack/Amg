import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Читает размеры PNG из заголовка IHDR: подпись (8 байт), длина чанка (4),
 * тип "IHDR" (4), дальше ширина и высота по 4 байта.
 */
async function readPngSize(file: string): Promise<ImageSize | undefined> {
  const handle = await open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(24), 0, 24, 0);
    if (bytesRead < 24) return undefined;
    const isPng = buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    if (!isPng || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
      return undefined;
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

async function probeSize(file: string): Promise<ImageSize | undefined> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ]);
    const [width, height] = stdout.trim().split(",").map(Number);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // ffprobe может отсутствовать — не критично
  }
  return undefined;
}

/**
 * Размеры сгенерированной картинки. Нужны, чтобы карточка в кадре подстроилась
 * под пропорции изображения: модели иногда возвращают квадрат вместо
 * вертикали, и жёсткая рамка обрезала бы его по бокам.
 *
 * Если определить не удалось, вернёт undefined — тогда шаблон возьмёт
 * пропорции по умолчанию.
 */
export async function getImageSize(file: string): Promise<ImageSize | undefined> {
  return (await readPngSize(file)) ?? (await probeSize(file));
}
