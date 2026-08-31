import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

/**
 * Временное размещение картинки, чтобы её увидела картиночная модель.
 *
 * Зачем это вообще нужно. Kie.ai принимает входные изображения ТОЛЬКО по
 * публичной ссылке — локальный файл ему не отдать. Для эталона персонажа это
 * решено ссылкой на файл в нашем репозитории, но со скриншотами так нельзя:
 * это чужие экраны с перепиской и настройками, и класть их в публичный
 * репозиторий недопустимо.
 *
 * Поэтому файл уходит во временное хранилище самого Kie.ai — тем же ключом,
 * которым мы и так пользуемся, и удаляется у них автоматически.
 *
 * ОТКУДА КОНТРАКТ. docs.kie.ai из среды разработки закрыт сетевой политикой,
 * поэтому эндпоинт и форма запроса взяты из их документации через поиск и
 * сверены по двум независимым описаниям (docs.kie.ai и старая версия тех же
 * доков). Живым ключом отсюда проверить нельзя, поэтому ответ разбирается
 * терпимо: берём fileUrl, если его нет — downloadUrl, и только потом ругаемся.
 */

const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";

/**
 * Предел на исходник. Base64 раздувает файл на треть, а скриншот телефона
 * весит меньше мегабайта — упереться в этот предел можно только фотографией
 * экрана в полном разрешении, и о ней лучше сказать сразу.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "image/png";
}

/** Кладёт картинку во временное хранилище Kie.ai и возвращает ссылку на неё. */
export async function uploadImageToKie(file: string): Promise<string> {
  const bytes = await readFile(file);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Картинка ${path.basename(file)} весит ` +
        `${Math.round(bytes.byteLength / 1024 / 1024)} МБ — многовато. ` +
        "Пришлите обычный скриншот, а не фотографию экрана.",
    );
  }

  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.kieApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64Data: `data:${mimeOf(file)};base64,${bytes.toString("base64")}`,
      uploadPath: "images",
      fileName: path.basename(file),
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    // Ключ в сообщение не попадает: оно уходит в чат.
    throw new Error(
      `Не удалось загрузить скриншот в Kie.ai (${response.status}). ` +
        `Ответ сервиса: ${text.slice(0, 200)}`,
    );
  }

  return fileUrlFrom(text);
}

/**
 * Ссылка из ответа. Отдельной функцией, чтобы разбор проверялся тестом: живым
 * ключом отсюда сходить некуда, и это единственное место, где можно ошибиться
 * молча.
 */
export function fileUrlFrom(body: string): string {
  let data: { data?: { fileUrl?: string; downloadUrl?: string }; msg?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      `Kie.ai ответил на загрузку не по формату: ${body.slice(0, 200)}`,
    );
  }
  const url = data.data?.fileUrl ?? data.data?.downloadUrl;
  if (!url) {
    throw new Error(
      "Kie.ai не вернул ссылку на загруженный скриншот" +
        (data.msg ? ` (${data.msg})` : "") +
        ". Без неё перерисовать экран нечем.",
    );
  }
  return url;
}
