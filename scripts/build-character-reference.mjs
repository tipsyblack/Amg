// Собирает эталон внешности маскота для генерации из исходного стикера.
//
//   python3 scripts/build-character-reference.py   (см. ниже — логика на Python)
//   npm run character:ref
//
// Зачем. Исходник assets/characters/shamil.png — рекламный стикер на
// ФОТОГРАФИИ офиса, с лампой и надписью PRO NEIRO внизу. Как эталон для
// image-to-video он плох сразу по трём причинам:
//
//   1. Лицо занимает 19% высоты кадра. При выводе в 720p это меньше шестидесяти
//      пикселей на лицо — сохранять нечего, и модель рисует его заново. Ровно
//      это и выглядит как «лицо не похоже».
//   2. Фон — фотография, а промпт просит однотонный светлый. Модель обязана
//      перерисовать фон, а вместе с ним перерисовывает и персонажа.
//   3. В кадре надпись PRO NEIRO — при том, что текст в кадре мы сами
//      запрещаем отдельным правилом.
//
// Что делает скрипт. Стикер отделён от фотографии сплошной белой обводкой,
// поэтому фон — это связная область не-белых пикселей, дотягивающаяся до края
// кадра: находим её разметкой связных компонент и заливаем белым. Лампу
// отрезаем по дымному хвосту (самое узкое место силуэта). Оставшегося
// персонажа кадрируем в 3:4 с полями — лицо становится 34% высоты.
//
// Результат — assets/characters/shamil-clip.png. Исходник не трогаем.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Разметка связных компонент — это scipy, поэтому тело на Python. Держим его
// здесь же, а не отдельным файлом: скрипт разовый и читать его удобнее целиком.
const PYTHON = `
import sys
import numpy as np
from scipy import ndimage
from PIL import Image

SRC = "assets/characters/shamil.png"
OUT = "assets/characters/shamil-clip.png"
# Дымный хвост под персонажем; ниже начинается лампа с надписью.
CUT = 1150
MARGIN = 0.06
ASPECT = 0.75
SIZE = (1080, 1440)

a = np.array(Image.open(SRC).convert("RGB")).astype(int)

# Фон — связная область НЕ-белых пикселей, доходящая до края кадра. Стикер от
# неё отделён белой обводкой, поэтому в эту область он не попадает.
nonwhite = ~((a > 235).all(axis=2))
labels, _ = ndimage.label(nonwhite)
edge = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
edge.discard(0)
background = np.isin(labels, list(edge))
if background.mean() < 0.3:
    sys.exit("Фон не распознан: связная область по краю занимает меньше 30% кадра")

clean = a.copy()
clean[background] = 255

body = ~background
body[CUT:, :] = False
ys, xs = np.nonzero(body)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()

cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
w, h = (x1 - x0) * (1 + 2 * MARGIN), (y1 - y0) * (1 + 2 * MARGIN)
if w / h > ASPECT:
    h = w / ASPECT
else:
    w = h * ASPECT

canvas = Image.fromarray(clean.astype("uint8"))
left, top = int(cx - w / 2), int(cy - h / 2)
crop = canvas.crop((left, top, left + int(w), top + int(h))).resize(SIZE, Image.LANCZOS)
crop.save(OUT)

head = 340  # высота головы с причёской, измерена по силуэту
print(f"{OUT}: {SIZE[0]}x{SIZE[1]}, лицо занимает {100 * head / h:.0f}% высоты")
print(f"(в исходнике было {100 * head / a.shape[0]:.0f}%)")
`;

try {
  const out = execFileSync("python3", ["-c", PYTHON], {
    cwd: path.resolve(here, ".."),
    encoding: "utf-8",
  });
  process.stdout.write(out);
} catch (error) {
  console.error(
    "Не вышло. Нужны numpy, scipy и pillow: pip install numpy scipy pillow",
  );
  process.exit(1);
}
