import { writeFile } from "node:fs/promises";

// Скачивание публичного файла с Google Drive по обычной ссылке "Поделиться".
// Для больших файлов Google сначала отдаёт HTML-страницу "не удалось
// проверить на вирусы" с формой подтверждения — проходим её автоматически.

export function extractDriveFileId(link: string): string | undefined {
  return (
    link.match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1] ??
    link.match(/[?&]id=([A-Za-z0-9_-]{10,})/)?.[1]
  );
}

export async function downloadDriveFile(
  link: string,
  outFile: string,
): Promise<void> {
  const fileId = extractDriveFileId(link);
  if (!fileId) {
    throw new Error(
      "Не удалось найти ID файла в ссылке. Пришлите обычную ссылку " +
        "«Поделиться» из Google Drive (в ней есть /d/... или ?id=...).",
    );
  }

  let response = await fetch(
    `https://drive.google.com/uc?export=download&id=${fileId}`,
  );

  if ((response.headers.get("content-type") ?? "").includes("text/html")) {
    const html = await response.text();
    const action =
      html.match(/action="([^"]+)"/)?.[1] ??
      "https://drive.usercontent.google.com/download";
    const params = new URLSearchParams();
    for (const m of html.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)) {
      params.set(m[1], m[2]);
    }
    if (!params.has("id")) {
      params.set("id", fileId);
      params.set("export", "download");
      params.set("confirm", "t");
    }
    response = await fetch(`${action}?${params.toString()}`);
  }

  if (!response.ok) {
    throw new Error(`Google Drive ответил ошибкой HTTP ${response.status}`);
  }
  if ((response.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error(
      "Google Drive не отдал файл. Проверьте, что доступ открыт " +
        "«всем, у кого есть ссылка».",
    );
  }

  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}
