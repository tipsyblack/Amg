import { parseFile } from "music-metadata";

export async function getAudioDurationInSeconds(
  filePath: string,
): Promise<number> {
  const metadata = await parseFile(filePath);
  const duration = metadata.format.duration;
  if (!duration) {
    throw new Error(`Не удалось определить длительность файла ${filePath}`);
  }
  return duration;
}
