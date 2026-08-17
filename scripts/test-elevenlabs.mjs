import { createServer } from 'node:http';

const PORT = 45793;
let mode = 'voices';
let voicesMode = 'ok';
const server = createServer(async (req, res) => {
  if (req.url === '/voices') {
    if (voicesMode === 'no-permission') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"detail":{"message":"The API key you used is missing the permission voices_read to execute this operation.","status":"missing_permissions"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ voices: [
      { voice_id: '9BWtsMINqrJLrRacOk9x', name: 'Aria', category: 'premade' },
      { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade' },
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'professional' },
      { name: 'без id' },
    ] }));
    return;
  }
  // text-to-speech
  const errors = {
    perm: [401, '{"detail":{"message":"The API key you used is missing the permission text_to_speech"}}'],
    paid: [402, '{"detail":{"code":"paid_plan_required","message":"Free users cannot use library voices via the API."}}'],
    quota: [401, '{"detail":{"status":"quota_exceeded"}}'],
    other: [500, '{"detail":"boom"}'],
  };
  if (errors[mode]) {
    const [code, body] = errors[mode];
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  lastTtsBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  res.writeHead(200); res.end(Buffer.from('AUDIO'));
});
let lastTtsBody;
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

process.env.OPENROUTER_API_KEY = 'k';
process.env.KIE_API_KEY = 'k';
process.env.ELEVENLABS_API_KEY = 'el';

const el = await import('../src/pipeline/elevenlabs.ts');
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(
  String(url).replace('https://api.elevenlabs.io/v1', 'http://127.0.0.1:' + PORT), init);

let fails = 0;
const check = (n, ok, x='') => { console.log((ok?'  ok  ':' FAIL ')+n+(x?' — '+x:'')); if(!ok) fails++; };

console.log('=== список голосов ===');
const voices = await el.listVoices();
check('голоса разобраны, безымянный без id отброшен', voices.length === 3, String(voices.length));
check('premade помечены', voices.filter(v => v.category === 'premade').length === 2);
check('имя и id на месте', voices[0].name === 'Aria' && voices[0].voiceId === '9BWtsMINqrJLrRacOk9x');

console.log('=== список голосов без права voices_read ===');
voicesMode = 'no-permission';
try {
  await el.listVoices();
  check('должно было упасть', false);
} catch (e) {
  check('объяснено про право voices_read', e.message.includes('voices_read'), e.message.slice(0, 60));
  check('подсказан путь через сайт без прав', e.message.includes('Voice ID'));
}
voicesMode = 'ok';

console.log('=== расшифровка ошибок ===');
for (const [m, expect] of [
  ['perm', 'права text_to_speech'],
  ['paid', 'недоступен на вашем тарифе'],
  ['quota', 'лимит символов'],
  ['other', 'вернул ошибку 500'],
]) {
  mode = m;
  try {
    await el.synthesizeSpeechDirect('тест', '/tmp/x.mp3', 'Aria');
    check(m + ': должно было упасть', false);
  } catch (e) {
    check(m + ' объяснена понятно', e.message.includes(expect), e.message.slice(0, 90));
  }
}

console.log('=== настройки похожести голоса ===');
// Клон звучит ближе к исходнику при высоком similarity_boost, нулевом style и
// включённом speaker boost — поэтому эти поля обязаны уходить в запрос.
mode = 'ok';
const { config } = await import('../src/pipeline/config.ts');
await el.synthesizeSpeechDirect('тест', '/tmp/x.mp3', 'Aria');
const vs = lastTtsBody?.voice_settings ?? {};
check('similarity_boost из конфига', vs.similarity_boost === config.ttsSimilarityBoost, JSON.stringify(vs));
check('similarity высокий по умолчанию', config.ttsSimilarityBoost >= 0.85, String(config.ttsSimilarityBoost));
check('speaker boost включён', vs.use_speaker_boost === true);
check('style нулевой (не искажает тембр)', vs.style === 0);
check('stability оставляет живую интонацию', vs.stability === config.ttsStability && config.ttsStability < 0.5, String(vs.stability));
check('модель многоязычная (нужна для русского)', lastTtsBody?.model_id === 'eleven_multilingual_v2', String(lastTtsBody?.model_id));

console.log('=== предупреждение про клон через прокси Kie.ai ===');
// Клон живёт в аккаунте пользователя, а Kie.ai ходит в ElevenLabs со своего —
// на этом сочетании ролик озвучивается чужим голосом.
const { cloneViaProxyWarning } = await import('../src/pipeline/generateVoiceover.ts');
const cloneId = '21m00Tcm4TlvDq8ikWAM'; // в моке помечен как professional
const premadeId = '9BWtsMINqrJLrRacOk9x'; // Aria, premade
const warn = await cloneViaProxyWarning(cloneId, 'kie');
check('клон + kie: предупреждаем', typeof warn === 'string', String(warn).slice(0, 60));
check('в предупреждении есть имя голоса', warn?.includes('Rachel'));
check('подсказано переключение', warn?.includes('/tts elevenlabs'));
check('базовый голос + kie: молчим', (await cloneViaProxyWarning(premadeId, 'kie')) === undefined);
check('клон + elevenlabs: молчим', (await cloneViaProxyWarning(cloneId, 'elevenlabs')) === undefined);
check('неизвестный аккаунту голос: молчим', (await cloneViaProxyWarning('QQQQQQQQQQQQQQQQQQQQ', 'kie')) === undefined);
voicesMode = 'no-permission';
check('нет прав на список голосов — не мешаем работать', (await cloneViaProxyWarning(cloneId, 'kie')) === undefined);
voicesMode = 'ok';

console.log("\n=== каким способом сделан голос ===");
// Вопрос «у нас мгновенный клон или профессиональный» должен решаться из чата,
// а не по памяти о том, где голос создавали: наш /clone умеет только
// мгновенный, но голос могли завести и в кабинете ElevenLabs.
// Названия категорий — из официального SDK (VoiceCategory).
const { voiceKind } = await import("../src/pipeline/elevenlabs.ts");
check("cloned — это мгновенный клон", /мгновенный/.test(voiceKind("cloned")), voiceKind("cloned"));
check("professional — профессиональный", /профессиональный/.test(voiceKind("professional")), voiceKind("professional"));
check("premade — базовый", /базовый/.test(voiceKind("premade")));
check("generated узнаётся", /сгенерированн/.test(voiceKind("generated")));
check("библиотечные вместе", voiceKind("famous") === voiceKind("high_quality"));
check("незнакомая категория показывается как есть", voiceKind("что-то новое") === "что-то новое");

server.close();
console.log(fails === 0 ? '\nВсе проверки пройдены\n' : `\nПровалено: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
