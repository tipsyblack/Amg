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
bot.command('start', (ctx) => { hits.push(['start', ctx.match]); });
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

process.exit(fails === 0 ? 0 : 1);
