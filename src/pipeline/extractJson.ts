/**
 * Достаёт JSON из ответа модели.
 *
 * Модель то оборачивает ответ в ```json, то дописывает пояснение до или после
 * — и то и другое ломает JSON.parse. Поэтому сначала снимаем ограду, потом
 * берём кусок от первой фигурной скобки до последней.
 *
 * Лежит отдельным модулем, а не в generateScript, чтобы не заводить цикл:
 * критик (reviewScript) разбирает ответ тем же способом, а generateScript
 * зовёт критика.
 */
export function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : content).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + 1);
}
