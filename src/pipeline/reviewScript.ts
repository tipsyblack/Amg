import { config } from "./config";
import { extractJson } from "./extractJson";
import { readChecklist } from "./reviewChecklist";

// Тип описан структурно, а не импортирован из generateScript: тот зовёт
// критика, и обратный импорт замкнул бы модули друг на друга.
interface ReviewableScript {
  title: string;
  scenes: { caption: string; voiceoverText: string }[];
}

// Проверка сценария моделью-критиком.
//
// Зачем она вместо регулярок. Регулярка ловит формулировку, а не смысл:
// «непростая задача» она найдёт, а «ну, посмотрим, куда это всё вырулит» —
// нет, хотя это ровно та же пустая концовка. На одном сценарии список
// шаблонов дописать легко, на потоке — невозможно: каждая новая тема приносит
// свои обороты, и список либо отстаёт, либо начинает браковать здоровое.
//
// Поэтому структура (ритм, бюджет слов, длина хука, реклама не в финале)
// осталась в коде — она объективна и от темы не зависит, — а всё, что про
// смысл, ушло сюда. Критику дают чек-лист обычным текстом, и правит его
// редактор без программиста (см. reviewChecklist.ts).
//
// Критик отвечает списком проблем, а не переписанным сценарием: переписывание
// — работа сценариста, у него для этого есть весь контекст брифа и предыдущей
// версии. Критик только называет, что не так, и его претензии уходят в тот же
// механизм автоправки, что и структурные.

export interface ReviewProblem {
  /** Пункт чек-листа, к которому относится претензия. */
  rule: string;
  /** Что именно не так — этот текст уходит сценаристу. */
  problem: string;
  /** Номер сцены, если претензия к конкретной. */
  scene?: number;
}

const SYSTEM_PROMPT = `Ты — редактор коротких вертикальных видео. Тебе дают
сценарий и чек-лист. Твоя задача — найти нарушения чек-листа, и только их.

Отвечай СТРОГО валидным JSON без markdown-обёртки:
{"problems": [{"rule": "краткое название пункта", "problem": "что не так, одной фразой", "scene": номер сцены или null}]}

Правила ответа:
- Пиши только о РЕАЛЬНЫХ нарушениях. Если сценарий хорош — верни пустой
  массив. Придираться не надо: каждая претензия стоит переписывания, а
  переписывание может сделать текст хуже.
- Одна претензия на одно нарушение. Не дублируй одно и то же разными словами.
- problem пиши так, чтобы сценарист понял, что исправить, без твоего
  присутствия: не «слабый хук», а «хук говорит об отрасли, а не о зрителе —
  непонятно, чья это проблема».
- Не предлагай свой вариант текста и не переписывай сценарий.
- Не более четырёх претензий: если их больше, назови четыре самые важные.`;

interface ReviewResponse {
  problems?: { rule?: string; problem?: string; scene?: number | null }[];
}

/**
 * Просит модель проверить сценарий по чек-листу.
 *
 * Ошибку не бросает: критик — это улучшение, а не условие работы. Если
 * OpenRouter недоступен или ответил мусором, сценарий уходит дальше с одними
 * структурными проверками. Ронять из-за критика генерацию, где дальше идут
 * оплаченные картинки, нельзя.
 */
export async function reviewScript(
  script: ReviewableScript,
  brief: string,
  model: string = config.openRouterModel,
): Promise<{ problems: ReviewProblem[]; unavailable?: string }> {
  if (!config.scriptReview) return { problems: [] };

  const scenes = script.scenes
    .map(
      (scene, i) =>
        `${i + 1}. [${scene.caption}] ${scene.voiceoverText}`,
    )
    .join("\n");
  const user =
    `ЧЕК-ЛИСТ:\n${readChecklist()}\n\n` +
    `БРИФ (что за продукт и для кого): ${brief}\n\n` +
    `СЦЕНАРИЙ «${script.title}»:\n${scenes}`;

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
        }),
      },
    );

    if (!response.ok) {
      return {
        problems: [],
        unavailable: `критик не ответил (HTTP ${response.status})`,
      };
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { problems: [], unavailable: "критик вернул пустой ответ" };

    const parsed = JSON.parse(extractJson(content)) as ReviewResponse;
    const problems = (parsed.problems ?? [])
      .filter((item) => item?.problem)
      .map((item) => ({
        rule: (item.rule ?? "").trim() || "чек-лист",
        problem: item.problem!.trim(),
        scene:
          typeof item.scene === "number" && item.scene > 0
            ? item.scene
            : undefined,
      }));
    return { problems };
  } catch (error) {
    return {
      problems: [],
      unavailable: `критик не отработал: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Претензия критика в том же виде, в каком её понимает автоправка. */
export function formatReviewProblem(item: ReviewProblem): string {
  const where = item.scene ? ` (сцена ${item.scene})` : "";
  return `${item.rule}${where}: ${item.problem}`;
}
