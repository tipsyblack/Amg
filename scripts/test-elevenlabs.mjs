import { createServer } from 'node:http';

const PORT = 45793;
let mode = 'voices';
const server = createServer(async (req, res) => {
  if (req.url === '/voices') {
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
  res.writeHead(200); res.end(Buffer.from('AUDIO'));
});
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

server.close();
process.exit(fails === 0 ? 0 : 1);
