import { writeFile } from "node:fs/promises";
import { config } from "./config";

// Kie.ai работает асинхронно: сначала создаём задачу, потом опрашиваем её
// статус, пока не появится результат. Ссылки на готовые файлы приходят в
// resultJson.
type TaskState = "waiting" | "queuing" | "generating" | "success" | "fail";

interface CreateTaskResponse {
  code?: number;
  msg?: string;
  data?: { taskId?: string };
}

interface RecordInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    state?: TaskState;
    resultJson?: string | { resultUrls?: string[] };
    failCode?: string | number;
    failMsg?: string;
    progress?: number;
  };
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.kieApiKey}`,
    "Content-Type": "application/json",
  };
}

async function createTask(
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${config.kieApiBase}/createTask`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model, input }),
  });

  if (!response.ok) {
    console.error("Kie.ai createTask payload:", JSON.stringify({ model, input }));
    throw new Error(
      `Kie.ai createTask (${model}) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as CreateTaskResponse;
  if (body.code !== 200 || !body.data?.taskId) {
    console.error("Kie.ai createTask payload:", JSON.stringify({ model, input }));
    throw new Error(
      `Kie.ai createTask (${model}) не создал задачу: code=${body.code}, msg=${body.msg}`,
    );
  }

  return body.data.taskId;
}

function extractResultUrls(
  resultJson: string | { resultUrls?: string[] } | undefined,
): string[] {
  if (!resultJson) return [];
  // По документации это JSON-строка, но на всякий случай поддерживаем и
  // уже разобранный объект.
  const parsed =
    typeof resultJson === "string"
      ? (JSON.parse(resultJson) as { resultUrls?: string[] })
      : resultJson;
  return parsed.resultUrls ?? [];
}

// Таймаут ожидания не ретраим: каждая попытка длится до kieTimeoutMs, и
// повторы растянули бы одну зависшую сцену на десятки минут.
class KieTimeoutError extends Error {}

async function waitForTask(taskId: string, label: string): Promise<string[]> {
  const deadline = Date.now() + config.kieTimeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${config.kieApiBase}/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: authHeaders() },
    );

    if (!response.ok) {
      throw new Error(
        `Kie.ai recordInfo (${label}) вернул ошибку ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as RecordInfoResponse;
    const state = body.data?.state;

    if (state === "success") {
      const urls = extractResultUrls(body.data?.resultJson);
      if (urls.length === 0) {
        throw new Error(
          `Kie.ai (${label}) завершил задачу без результата (resultUrls пуст)`,
        );
      }
      return urls;
    }

    if (state === "fail") {
      throw new Error(
        `Kie.ai (${label}) не смог выполнить задачу: ${body.data?.failMsg ?? "причина не указана"} ` +
          `(код ${body.data?.failCode ?? "—"})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, config.kiePollIntervalMs));
  }

  throw new KieTimeoutError(
    `Kie.ai (${label}) не ответил за ${Math.round(config.kieTimeoutMs / 1000)} с — ` +
      "задача слишком долгая или зависла. Можно увеличить KIE_TIMEOUT_SECONDS.",
  );
}

async function downloadToFile(url: string, outFile: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Не удалось скачать результат ${url}: HTTP ${response.status}`,
    );
  }
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
}

/**
 * Запускает задачу в Kie.ai, ждёт результат и сохраняет первый файл на диск.
 * Возвращает ссылку на результат — её можно передать следующей задаче как
 * входное изображение (Kie.ai принимает картинки только по URL).
 *
 * Сбои Kie.ai (ошибка создания задачи, state=fail, пустой результат, сбой
 * скачивания) ретраятся до config.kieMaxAttempts раз с растущей паузой.
 */
export async function runKieTask({
  model,
  input,
  outFile,
  label,
}: {
  model: string;
  input: Record<string, unknown>;
  outFile: string;
  label: string;
}): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.kieMaxAttempts; attempt++) {
    try {
      const taskId = await createTask(model, input);
      const [resultUrl] = await waitForTask(taskId, label);
      await downloadToFile(resultUrl, outFile);
      return resultUrl;
    } catch (error) {
      if (error instanceof KieTimeoutError) throw error;
      lastError = error;
      if (attempt === config.kieMaxAttempts) break;

      const delayMs = config.kieRetryBaseMs * 2 ** (attempt - 1);
      console.error(
        `Kie.ai (${label}): попытка ${attempt} из ${config.kieMaxAttempts} не удалась, ` +
          `повтор через ${Math.round(delayMs / 1000)} с: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.error(
    `Kie.ai (${label}): все попытки исчерпаны, запрос был:`,
    JSON.stringify({ model, input }),
  );
  throw lastError;
}
