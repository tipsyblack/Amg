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
check('nb2: image_input + aspect_ratio', nb2.image_input === urls && nb2.aspect_ratio === '9:16' && !('image_urls' in nb2));
check('nb2: слаг', byKey.nb2.model === 'nano-banana-2');

const lite = byKey.nb2lite.buildInput('промпт', urls);
check('lite: как nb2', lite.image_input === urls && byKey.nb2lite.model === 'nano-banana-2-lite');

const gpt = byKey.gpt2.buildInput('промпт', urls);
check('gpt2: input_urls + nsfw_checker', gpt.input_urls === urls && gpt.nsfw_checker === false && !('image_urls' in gpt), JSON.stringify(gpt));
check('gpt2: слаг', byKey.gpt2.model === 'gpt-image-2-image-to-image');

check('неизвестный ключ -> дефолт', getImageModel('чушь').key === DEFAULT_IMAGE_MODEL_KEY);
check('пустой ключ -> дефолт', getImageModel(undefined).key === 'nb');

process.exit(fails === 0 ? 0 : 1);
