import { buildVideoData } from "./buildVideoData";

async function main() {
  const brief = process.argv.slice(2).join(" ").trim();
  if (!brief) {
    console.error(
      'Использование: npm run generate -- "Краткое описание продукта и посыла видео"',
    );
    process.exit(1);
  }

  console.log("Генерирую сценарий и озвучку...");
  const videoData = await buildVideoData(brief);
  console.log(`Готово: "${videoData.title}", сцен: ${videoData.scenes.length}`);
  console.log("Данные сохранены в data/video-data.json, аудио — в public/audio/");
  console.log("Дальше: npm run render");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
