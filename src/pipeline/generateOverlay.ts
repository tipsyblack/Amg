import path from "node:path";
import { rm } from "node:fs/promises";
import { keyOutBackground } from "./chromaKey";
import { config } from "./config";
import { STYLE_PROMPT } from "./generateImage";
import { getImageModel } from "./imageModels";
import { runKieTask } from "./kie";

// Дополнительный объект для сцены: генерируется отдельно и накладывается на ту
// же картинку, не заменяя её. Так кадр оживает, а зритель не теряет контекст —
// фон остаётся прежним.
//
// Прозрачность получается не от модели, а вырезанием зелёного фона (chromaKey):
// у nano-banana альфа-канала нет вовсе, у gpt-image параметры прозрачности не
// описаны, а зелёный экран работает с любой моделью.

export const GREEN = "#00FF00";

/**
 * Промпт объекта. Требование зелёного фона идёт последним и повторяется: это
 * главное условие, без него вырезать нечего.
 */
export function buildOverlayPrompt(
  object: string,
  styleNotes?: string,
): string {
  const styleAddition = styleNotes
    ? `\n\nЗаметки о стиле из референса: ${styleNotes}`
    : "";
  return (
    `${STYLE_PROMPT}${styleAddition}\n\n` +
    `НУЖЕН ОДИН ПРЕДМЕТ, А НЕ СЦЕНА: ${object}\n\n` +
    `КРИТИЧНО: фон — сплошной ярко-зелёный ${GREEN}, без оттенков, ` +
    "без градиента, без тени на фоне. Никакого окружения, пола, стен и рамок. " +
    "Персонажа не рисуй — только сам предмет, целиком в кадре, с отступом от " +
    "краёв. Никакого текста и подписей.\n\n" +
    `Повторю: всё, что не предмет, должно быть залито ${GREEN}.`
  );
}

/**
 * Рисует объект и сохраняет PNG с прозрачным фоном в public/overlays/.
 * Возвращает имя файла и размеры вырезанного объекта.
 */
export async function generateSceneOverlay(
  index: number,
  object: string,
  styleNotes?: string,
  modelKey?: string,
): Promise<{ fileName: string; width: number; height: number }> {
  const spec = getImageModel(modelKey);
  const fileName = `scene-${index}.png`;
  const outFile = path.join(path.resolve("public/overlays"), fileName);
  // Сырой кадр с зелёным фоном — промежуточный файл, после вырезания не нужен.
  const rawFile = `${outFile}.green.png`;

  await runKieTask({
    model: spec.model,
    // Модели edit-типа требуют входную картинку, поэтому передаём эталон
    // персонажа: он задаёт манеру рисунка. В промпте прямо сказано персонажа
    // не рисовать — если модель всё же нарисует его, это видно на согласовании
    // в боте, и объект можно перегенерировать.
    input: spec.buildInput(buildOverlayPrompt(object, styleNotes), [
      config.characterReferenceUrl,
    ]),
    outFile: rawFile,
    label: `объект для сцены ${index + 1}, модель ${spec.model}`,
  });

  try {
    const box = await keyOutBackground(rawFile, outFile);
    return { fileName, ...box };
  } finally {
    await rm(rawFile, { force: true });
  }
}

// Куда ставить объект: по номеру сцены, чтобы соседние сцены не показывали его
// в одном и том же месте. Центр не используем — он перекрыл бы главное в
// картинке.
const ANCHORS = [
  "topRight",
  "bottomLeft",
  "topLeft",
  "bottomRight",
] as const;

export function overlayAnchor(index: number): (typeof ANCHORS)[number] {
  return ANCHORS[index % ANCHORS.length];
}

// Доля ширины карточки. Объект должен читаться, но не закрывать сцену.
export const OVERLAY_WIDTH_PERCENT = 38;
