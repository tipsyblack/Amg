import { writeFile } from "node:fs/promises";

// Скачивание публичного файла с Google Drive по обычной ссылке "Поделиться".
// Тонкостей две: для больших файлов Google сначала отдаёт HTML-страницу
// "не удалось проверить на вирусы" с формой подтверждения, а для закрытых
// файлов — страницу входа в аккаунт. Первую проходим, про вторую сообщаем
// понятным текстом.

export function extractDriveFileId(link: string): string | undefined {
  return (
    link.match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1] ??
    link.match(/[?&]id=([A-Za-z0-9_-]{10,})/)?.[1]
  );
}

const NOT_PUBLIC_MESSAGE =
  "Google Drive потребовал вход в аккаунт — значит файл открыт не для всех.\n\n" +
  "Откройте его на Drive → «Поделиться» → в разделе «Общий доступ» " +
  "выберите «Все, у кого есть ссылка» → скопируйте ссылку заново.\n\n" +
  "Либо пришлите файл прямо в чат (до 20 МБ — для звуковой дорожки хватает).";

function isSignInPage(url: string, html: string): boolean {
  return (
    /accounts\.google\.com|\/v3\/signin|ServiceLogin/.test(url) ||
    /\/v3\/signin|ServiceLogin|Sign in|Войдите/.test(html)
  );
}

function isHtml(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html");
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

  if (isHtml(response)) {
    const html = await response.text();
    if (isSignInPage(response.url, html)) {
      throw new Error(NOT_PUBLIC_MESSAGE);
    }

    // Страница подтверждения: забираем адрес формы и её скрытые поля.
    const action = html.match(/action="([^"]+)"/)?.[1];
    const params = new URLSearchParams();
    for (const m of html.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)) {
      params.set(m[1], m[2]);
    }
    if (!params.has("id")) {
      params.set("id", fileId);
      params.set("export", "download");
      params.set("confirm", "t");
    }

    // Адрес формы у Google бывает относительным ("/v3/..."), поэтому
    // разрешаем его относительно страницы, а не подставляем как есть —
    // иначе fetch падает с "Failed to parse URL".
    const base = action
      ? new URL(action, response.url)
      : new URL("https://drive.usercontent.google.com/download");
    for (const [key, value] of params) base.searchParams.set(key, value);

    if (isSignInPage(base.toString(), "")) {
      throw new Error(NOT_PUBLIC_MESSAGE);
    }

    response = await fetch(base.toString());
  }

  if (!response.ok) {
    throw new Error(`Google Drive ответил ошибкой HTTP ${response.status}`);
  }
  if (isHtml(response)) {
    const html = await response.text().catch(() => "");
    throw new Error(
      isSignInPage(response.url, html)
        ? NOT_PUBLIC_MESSAGE
        : "Google Drive вернул страницу вместо файла. Проверьте, что доступ " +
          "открыт «всем, у кого есть ссылка», и что ссылка ведёт на файл, а " +
          "не на папку.",
    );
  }

  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}
