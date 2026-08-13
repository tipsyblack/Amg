// Проверяю, что команда без сущности bot_command всё равно попадает в
// bot.command() после нашего middleware — на настоящем grammY.
import { Bot } from 'grammy';

const bot = new Bot('123:FAKE', { botInfo: {
  id: 123, is_bot: true, first_name: 'T', username: 'testbot',
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false,
  has_main_web_app: false,
}});

// то же middleware, что в боте
bot.use(async (ctx, next) => {
  const message = ctx.message;
  if (message?.text?.startsWith('/')) {
    const alreadyMarked = message.entities?.some(
      (e) => e.type === 'bot_command' && e.offset === 0,
    );
    if (!alreadyMarked) {
      const length = message.text.split(/\s/, 1)[0].length;
      message.entities = [
        { type: 'bot_command', offset: 0, length },
        ...(message.entities ?? []),
      ];
    }
  }
  await next();
});

const hits = [];
bot.command('tts', (ctx) => { hits.push(['tts', ctx.match]); });
bot.command('clonemore', (ctx) => { hits.push(['clonemore', ctx.match]); });
bot.command('start', (ctx) => { hits.push(['start', ctx.match]); });
bot.command('model', (ctx) => { hits.push(['model', ctx.match]); });
bot.command('ttsmodel', (ctx) => { hits.push(['ttsmodel', ctx.match]); });
bot.command('vidmodel', (ctx) => { hits.push(['vidmodel', ctx.match]); });
bot.command('clips', (ctx) => { hits.push(['clips', ctx.match]); });
bot.command('clone', (ctx) => { hits.push(['clone', ctx.match]); });
bot.command('library', (ctx) => { hits.push(['library', ctx.match]); });
bot.command('rules', (ctx) => { hits.push(['rules', ctx.match]); });
bot.command('length', (ctx) => { hits.push(['length', ctx.match]); });
bot.command('stems', (ctx) => { hits.push(['stems', ctx.match]); });
bot.command('music', (ctx) => { hits.push(['music', ctx.match]); });
bot.command('addmusic', (ctx) => { hits.push(['addmusic', ctx.match]); });
bot.command('autopilot', (ctx) => { hits.push(['autopilot', ctx.match]); });
bot.on('message:text', (ctx) => { hits.push(['fallback', ctx.message.text]); });

const upd = (text, entities) => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: {
    message_id: 1, date: 0, chat: { id: 1, type: 'private' },
    from: { id: 1, is_bot: false, first_name: 'U' },
    text, ...(entities ? { entities } : {}),
  },
});

let fails = 0;
const check = (n, ok, x='') => { console.log((ok?'  ok  ':' FAIL ')+n+(x?' — '+x:'')); if(!ok) fails++; };

// 1) команда с форматированием (как при копировании из чата) — без bot_command
await bot.handleUpdate(upd('/tts elevenlabs', [{ type: 'code', offset: 0, length: 15 }]));
check('скопированная как код команда распознана', hits.at(-1)?.[0] === 'tts', JSON.stringify(hits.at(-1)));
check('аргумент разобран', hits.at(-1)?.[1] === 'elevenlabs', String(hits.at(-1)?.[1]));

// 2) вообще без сущностей
await bot.handleUpdate(upd('/tts kie'));
check('команда без сущностей распознана', hits.at(-1)?.[0] === 'tts' && hits.at(-1)?.[1] === 'kie');

// 3) обычная команда с правильной сущностью не сломалась
await bot.handleUpdate(upd('/start', [{ type: 'bot_command', offset: 0, length: 6 }]));
check('обычная команда работает', hits.at(-1)?.[0] === 'start');

// 4) обычный текст по-прежнему идёт в fallback
await bot.handleUpdate(upd('просто текст'));
check('обычный текст не считается командой', hits.at(-1)?.[0] === 'fallback');

// 5) команда с @упоминанием бота
await bot.handleUpdate(upd('/tts@testbot elevenlabs'));
check('команда с @username распознана', hits.at(-1)?.[0] === 'tts' && hits.at(-1)?.[1] === 'elevenlabs', JSON.stringify(hits.at(-1)));

// 6) /clonemore — команда с похожим префиксом не должна путаться с /clone
await bot.handleUpdate(upd('/clonemore', [{ type: 'bot_command', offset: 0, length: 10 }]));
check('/clonemore распознана как своя команда', hits.at(-1)?.[0] === 'clonemore', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/clonemore'));
check('/clonemore без сущностей тоже', hits.at(-1)?.[0] === 'clonemore');

// 7) /model и /ttsmodel — общий префикс, как у /clone и /clonemore.
// Порядок регистрации обратный (model раньше ttsmodel), поэтому проверяем
// обе: перепутать их нельзя, они означают разные модели.
await bot.handleUpdate(upd('/model'));
check('/model без аргумента распознана', hits.at(-1)?.[0] === 'model', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/model anthropic/claude-opus-5'));
check(
  '/model со слагом: аргумент разобран',
  hits.at(-1)?.[0] === 'model' && hits.at(-1)?.[1] === 'anthropic/claude-opus-5',
  JSON.stringify(hits.at(-1)),
);
await bot.handleUpdate(upd('/ttsmodel'));
check('/ttsmodel не путается с /model', hits.at(-1)?.[0] === 'ttsmodel', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/ttsmodel eleven_multilingual_v2'));
check(
  '/ttsmodel со слагом',
  hits.at(-1)?.[0] === 'ttsmodel' && hits.at(-1)?.[1] === 'eleven_multilingual_v2',
  JSON.stringify(hits.at(-1)),
);

// 8) Слаг модели содержит слэш — middleware не должен принять его за команду.
await bot.handleUpdate(upd('anthropic/claude-opus-5'));
check('слаг без ведущего слэша — обычный текст', hits.at(-1)?.[0] === 'fallback');

// 9) /vidmodel — третья команда на «model». Проверяем именно её, а не только
// пару /model + /ttsmodel: суффикс, а не префикс, и перепутать их дороже
// всего — это три разных счёта за генерацию.
await bot.handleUpdate(upd('/vidmodel'));
check('/vidmodel не путается с /model', hits.at(-1)?.[0] === 'vidmodel', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/vidmodel probe'));
check(
  '/vidmodel probe: аргумент разобран',
  hits.at(-1)?.[0] === 'vidmodel' && hits.at(-1)?.[1] === 'probe',
  JSON.stringify(hits.at(-1)),
);
await bot.handleUpdate(upd('/model'));
check('/model после /vidmodel по-прежнему своя', hits.at(-1)?.[0] === 'model');

// 10) /clips и /clone: общий префикс «cl», и /clips ещё и похожа на /clone
// глазами. Проверяем все три команды семейства.
await bot.handleUpdate(upd('/clips'));
check('/clips распознана', hits.at(-1)?.[0] === 'clips', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/clips 2'));
check(
  '/clips с числом: аргумент разобран',
  hits.at(-1)?.[0] === 'clips' && hits.at(-1)?.[1] === '2',
  JSON.stringify(hits.at(-1)),
);
await bot.handleUpdate(upd('/clone'));
check('/clone не путается с /clips', hits.at(-1)?.[0] === 'clone', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/clonemore'));
check('/clonemore не путается с /clips', hits.at(-1)?.[0] === 'clonemore');

// 11) /library — подкоманды идут аргументом, а не отдельными командами.
await bot.handleUpdate(upd('/library'));
check('/library без аргумента', hits.at(-1)?.[0] === 'library' && hits.at(-1)?.[1] === '');
await bot.handleUpdate(upd('/library build'));
check(
  '/library build: подкоманда пришла аргументом',
  hits.at(-1)?.[0] === 'library' && hits.at(-1)?.[1] === 'build',
  JSON.stringify(hits.at(-1)),
);
await bot.handleUpdate(upd('/library intro-lamp'));
check(
  '/library <id> с дефисом в аргументе',
  hits.at(-1)?.[0] === 'library' && hits.at(-1)?.[1] === 'intro-lamp',
  JSON.stringify(hits.at(-1)),
);
// 12) /rules: чек-лист присылают вставкой, иногда прямо в команде — аргумент
// может быть многострочным и длинным.
await bot.handleUpdate(upd('/rules'));
check('/rules без аргумента', hits.at(-1)?.[0] === 'rules' && hits.at(-1)?.[1] === '');
await bot.handleUpdate(upd('/rules reset'));
check('/rules reset', hits.at(-1)?.[0] === 'rules' && hits.at(-1)?.[1] === 'reset');
await bot.handleUpdate(upd('/rules # Чек-лист\n\n## 1. Пункт\nТекст правила.'));
check(
  '/rules с многострочным текстом: перевод строки не обрезал аргумент',
  hits.at(-1)?.[0] === 'rules' && hits.at(-1)?.[1].includes('## 1. Пункт'),
  JSON.stringify(hits.at(-1)?.[1]?.slice(0, 40)),
);

// /library и /length начинаются на «l» — проверяем, что не слиплись.
await bot.handleUpdate(upd('/length 75'));
check('/length не путается с /library', hits.at(-1)?.[0] === 'length' && hits.at(-1)?.[1] === '75');

// 13) /stems: режим приходит аргументом, и команда начинается на «st» — как и
// /start, поэтому проверяем обе.
await bot.handleUpdate(upd('/stems'));
check('/stems без аргумента', hits.at(-1)?.[0] === 'stems' && hits.at(-1)?.[1] === '');
await bot.handleUpdate(upd('/stems six'));
check('/stems six', hits.at(-1)?.[0] === 'stems' && hits.at(-1)?.[1] === 'six');
await bot.handleUpdate(upd('/start'));
check('/stems не перехватил /start', hits.at(-1)?.[0] === 'start', JSON.stringify(hits.at(-1)));

// 14) /addmusic и /music: одна команда — начало другой, проверяем, что не
// слиплись (у grammY это уже ломалось на /library и /length).
await bot.handleUpdate(upd('/addmusic'));
check('/addmusic', hits.at(-1)?.[0] === 'addmusic', JSON.stringify(hits.at(-1)));
await bot.handleUpdate(upd('/music'));
check('/music не перехвачен /addmusic', hits.at(-1)?.[0] === 'music', JSON.stringify(hits.at(-1)));

// 15) /autopilot: у него есть аргумент on/off, и он начинается на «a» — как и
// /addmusic. Проверяем обе, чтобы не слиплись.
await bot.handleUpdate(upd('/autopilot'));
check('/autopilot без аргумента', hits.at(-1)?.[0] === 'autopilot' && hits.at(-1)?.[1] === '');
await bot.handleUpdate(upd('/autopilot off'));
check('/autopilot off', hits.at(-1)?.[0] === 'autopilot' && hits.at(-1)?.[1] === 'off');
await bot.handleUpdate(upd('/addmusic'));
check('/addmusic не перехвачен /autopilot', hits.at(-1)?.[0] === 'addmusic', JSON.stringify(hits.at(-1)));

// 16) Логика автопилота: продолжать цепочку или нет. Два условия, и оба
// неочевидны — withGeneration ошибки не выбрасывает, а шаг сценария может
// остановить автопилот сам.
const { autopilotContinues, parseAutopilotArg } = await import(
  '../src/bot/autopilot.ts'
);
const S = (autopilot, step) => ({ autopilot, step });
check(
  'идёт дальше: шаг прошёл, автопилот включён, диалог свободен',
  autopilotContinues({ ok: true, session: S(true, 'idle') }) === true,
);
check(
  'НЕ идёт после сбоя шага',
  autopilotContinues({ ok: false, session: S(true, 'idle') }) === false,
);
check(
  'НЕ идёт при выключенном автопилоте',
  autopilotContinues({ ok: true, session: S(false, 'idle') }) === false,
);
check(
  'НЕ идёт, если автопилот не настроен вовсе',
  autopilotContinues({ ok: true, session: S(undefined, 'idle') }) === false,
);
check(
  'НЕ идёт, если диалог ждёт правок сценария',
  autopilotContinues({ ok: true, session: S(true, 'awaiting_script_feedback') }) === false,
);
check(
  'НЕ идёт, если шаг ещё занят',
  autopilotContinues({ ok: true, session: S(true, 'busy') }) === false,
);

// Аргумент команды: пусто — переключить, слово — выставить явно.
check('пустой аргумент переключает выключенный', parseAutopilotArg('', false) === true);
check('пустой аргумент переключает включённый', parseAutopilotArg('', true) === false);
check('undefined тоже переключает', parseAutopilotArg(undefined, true) === false);
check('«off» выключает даже у выключенного', parseAutopilotArg('off', false) === false);
check('«on» включает', parseAutopilotArg('on', false) === true);
check('«вкл» включает', parseAutopilotArg('вкл', false) === true);
check('«ON» с заглавными включает', parseAutopilotArg('ON', false) === true);
check('мусор трактуется как выключить', parseAutopilotArg('пиво', true) === false);

process.exit(fails === 0 ? 0 : 1);
