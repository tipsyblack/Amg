process.env.OPENROUTER_API_KEY = 'k';
process.env.KIE_API_KEY = 'k';
const { IMAGE_MODELS, getImageModel, DEFAULT_IMAGE_MODEL_KEY } =
  await import('../src/pipeline/imageModels.ts');

let fails = 0;
const check = (n, ok, x='') => { console.log((ok?'  ok  ':' FAIL ')+n+(x?' — '+x:'')); if(!ok) fails++; };

const urls = ['https://ref/shamil.png', 'https://prev/scene.png'];

const byKey = Object.fromEntries(IMAGE_MODELS.map(m => [m.key, m]));

const nb = byKey.nb.buildInput('промпт', urls);
check('nb: image_urls + image_size', JSON.stringify(Object.keys(nb).sort()) === JSON.stringify(['image_size','image_urls','output_format','prompt']), JSON.stringify(nb));
check('nb: слаг из конфига', byKey.nb.model === 'google/nano-banana-edit');

const nb2 = byKey.nb2.buildInput('промпт', urls);
check('nb2: image_input + aspect_ratio', nb2.image_input === urls && nb2.aspect_ratio === '3:4' && !('image_urls' in nb2));
check('nb2: слаг', byKey.nb2.model === 'nano-banana-2');

const lite = byKey.nb2lite.buildInput('промпт', urls);
check('lite: как nb2', lite.image_input === urls && byKey.nb2lite.model === 'nano-banana-2-lite');

const pro = byKey.nbpro.buildInput('промпт', urls);
check('pro: image_input + aspect_ratio', pro.image_input === urls && pro.aspect_ratio === '3:4' && !('image_urls' in pro));
check('pro: слаг', byKey.nbpro.model === 'nano-banana-pro');

// Пропорции просим у всех моделей одинаковые: карточка в кадре повторяет их, а
// 9:16 растягивала её на строку субтитров.
const ratios = IMAGE_MODELS.map(m => { const i = m.buildInput('промпт', urls); return i.aspect_ratio ?? i.image_size; });
check('все модели просят 3:4', ratios.every(r => r === '3:4'), ratios.join(','));

const gpt = byKey.gpt2.buildInput('промпт', urls);
check('gpt2: input_urls + nsfw_checker', gpt.input_urls === urls && gpt.nsfw_checker === false && !('image_urls' in gpt), JSON.stringify(gpt));
check('gpt2: слаг', byKey.gpt2.model === 'gpt-image-2-image-to-image');

check('неизвестный ключ -> дефолт', getImageModel('чушь').key === DEFAULT_IMAGE_MODEL_KEY);
check('пустой ключ -> дефолт', getImageModel(undefined).key === 'nb');

// Текст на картинке дублировал подпись, которую рисует Remotion, поэтому
// надписи запрещены — и подпись сцены в промпт больше не попадает: увидев
// готовую фразу, модель норовит её нарисовать.
console.log('\n=== промпт картинки: без текста в кадре ===');
const { buildImagePrompt } = await import('../src/pipeline/assets.ts');
const scene = { caption: 'ХВАТИТ ПЛАТИТЬ ПЯТЬ РАЗ', voiceoverText: 'Джин разводит руками возле пяти счетов.' };
const prompt = buildImagePrompt(scene);
check('подписи сцены в промпте нет', !prompt.includes(scene.caption), prompt.slice(-80));
check('контекст озвучки передан', prompt.includes(scene.voiceoverText));
check('запрет текста есть', prompt.includes('НИКАКОГО текста'));
check('перечислены типовые места надписей', ['речевые пузыри', 'вывески', 'логотипы'].every(w => prompt.includes(w)));
check('запрет идёт последним', prompt.trimEnd().endsWith('без букв.'), prompt.trimEnd().slice(-40));

const withNotes = buildImagePrompt(scene, 'в референсе есть подписи на английском');
check('заметки из референса не перебивают запрет', withNotes.indexOf('НИКАКОГО текста') > withNotes.indexOf('референсе есть подписи'));

console.log('\n=== маскот не в каждой сцене ===');
// Это и был перекос: эталон внешности прикладывался к КАЖДОМУ запросу, и джин
// лез в кадр даже там, где сцена про серверы или про космос. Теперь он в хуке
// и в финале, а середина — про содержание истории.
const { sceneWithCharacter } = await import('../src/pipeline/assets.ts');
check('в хуке маскот есть', sceneWithCharacter(0, 7) === true);
check('в финале маскот есть', sceneWithCharacter(6, 7) === true);
check('в середине маскота нет', [1, 2, 3, 4, 5].every((i) => sceneWithCharacter(i, 7) === false));
check('ролик из одной сцены — с маскотом', sceneWithCharacter(0, 1) === true);

const { CHARACTER_PROMPT, NO_CHARACTER_PROMPT } = await import('../src/pipeline/generateImage.ts');
const withChar = buildImagePrompt(scene, undefined, true);
const noChar = buildImagePrompt(scene, undefined, false);
check('в сцене с маскотом есть его описание', withChar.includes(CHARACTER_PROMPT));
check('в сцене без маскота описания нет', !noChar.includes('Шамиль'), noChar.slice(0, 60));
check('и есть прямой запрет персонажей', noChar.includes(NO_CHARACTER_PROMPT));
check('стиль одинаковый в обоих', withChar.includes('flat-cartoon') && noChar.includes('flat-cartoon'));
check('запрет текста остаётся последним и там, и там', withChar.trimEnd().endsWith('без букв.') && noChar.trimEnd().endsWith('без букв.'));

// Промпт объекта-оверлея вообще не должен упоминать персонажа: нужен предмет,
// а упоминание джина провоцирует нарисовать джина.
const { buildOverlayPrompt } = await import('../src/pipeline/generateOverlay.ts');
check('в промпте объекта маскота нет', !buildOverlayPrompt('красный чемодан').includes('Шамиль'));

process.exit(fails === 0 ? 0 : 1);
