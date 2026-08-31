import { inflateRawSync } from "node:zlib";

/**
 * Разбор ZIP-архива без внешних зависимостей.
 *
 * Нужен ровно для одного ответа: разделение дорожки на стемы ElevenLabs
 * отдаёт zip-архивом. Ставить ради этого библиотеку не хочется, а полагаться на
 * системный unzip нельзя: на сервере его может не быть, и падение вылезет уже в
 * рантайме на живом ключе. Формат тут нужен в минимальном объёме — оглавление
 * плюс два способа хранения (без сжатия и deflate), это всё, чем пользуются
 * генераторы архивов.
 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Смещение оглавления: ищем сигнатуру конца архива с хвоста. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  // Комментарий архива не длиннее 65535 байт, дальше искать смысла нет.
  const from = Math.max(0, buffer.length - 65535 - 22);
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Это не zip-архив: не нашёлся конец оглавления");
}

export function unzip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Повреждённое оглавление zip на записи ${i + 1}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf-8");
    offset += 46 + nameLength + extraLength + commentLength;

    // Папки внутри архива нам не нужны.
    if (name.endsWith("/")) continue;

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Повреждённая запись zip: ${name}`);
    }
    // Длину имени и extra берём из ЛОКАЛЬНОГО заголовка: extra в нём обычно
    // другой длины, чем в оглавлении, и по чужой длине данные читаются со
    // сдвигом.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.push({ name, data: Buffer.from(raw) });
    } else if (method === 8) {
      entries.push({ name, data: inflateRawSync(raw) });
    } else {
      throw new Error(`Неизвестный способ сжатия zip (${method}) у ${name}`);
    }
  }
  return entries;
}
