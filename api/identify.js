/* 어종 판별 프록시
 *
 * 왜 서버에 두는가 — 이 앱은 공개 정적 사이트다. index.html 에 API 키를 넣으면
 * 브라우저 개발자 도구를 여는 누구나 가져다 쓸 수 있다. 그래서 키는 Vercel
 * 환경변수(ANTHROPIC_API_KEY)에만 두고, 브라우저는 이 함수만 부른다.
 *
 * 이 함수가 없거나 실패해도 앱은 멀쩡하다 — 브라우저가 기존 색·형태 추정으로
 * 되돌아간다. 그러니 배포에 실패해도 서비스가 죽지는 않는다.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

/* 우리 사이트에서 온 요청만 받는다.
   Origin 은 브라우저 밖(curl 등)에서 위조할 수 있으니 완전한 방어가 아니다.
   진짜 마지막 방어선은 Anthropic 콘솔의 지출 한도(Spend limit)다. */
const ALLOW_ORIGIN = [
  'https://fish-people.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
];

/* 같은 인스턴스가 살아 있는 동안만 세는 간이 제한.
   콜드 스타트마다 초기화되고 인스턴스끼리 공유도 안 되지만,
   한 사람이 스크립트로 연타하는 정도는 걸러 준다. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map();

function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) hits.clear();          // 메모리 무한 증식 방지
  return list.length > MAX_PER_WINDOW;
}

/* 어종 목록은 브라우저(index.html 의 FISH)가 보낸다.
   서버에 한 번 더 적어 두면 도감에 어종을 추가할 때마다 두 곳이 어긋난다.
   대신 형식을 엄격히 검사해서, 목록에 지시문 같은 걸 실어 보내지 못하게 한다. */
function cleanSpecies(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 120) return null;
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') return null;
    const id = f.id;
    if (typeof id !== 'string' || !/^[a-z0-9_]{1,24}$/.test(id)) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    /* 도감의 어종 이름은 전부 공백 없는 한 덩어리다(가장 긴 것이 '흰꼴뚜기(무늬오징어)').
       그래서 공백을 아예 막아 두면, 이름 칸에 문장 모양의 지시문을 실어 보낼 수 없다. */
    const name = f.name;
    if (typeof name !== 'string' || !/^[가-힣A-Za-z0-9()·\-]{1,24}$/.test(name)) return null;
    if (f.water !== '민물' && f.water !== '바다') return null;
    out.push({ id, name, water: f.water });
  }
  return out;
}

const SYSTEM_HEAD =
`너는 한국 낚시 앱의 어종 판별기다. 사진 한 장을 보고 아래 도감 목록 안에서만 어종을 고른다.

규칙
- 반드시 목록에 있는 id 만 쓴다. 목록에 없는 물고기로 보이면 가장 가까운 후보를 낮은 확신도로 낸다.
- 후보는 가능성이 높은 순서로 최대 3개. confidence 는 0~100 정수다.
- 확실하지 않으면 확신도를 낮게 준다. 이 앱은 판별 결과로 금어기·금지체장·보호종을 안내하므로,
  틀린 어종을 높은 확신도로 내면 사람이 잡으면 안 되는 물고기를 가져가게 된다. 모르면 모른다고 하는 편이 낫다.
- 물고기·오징어·게가 사진에 없으면 isFish 를 false 로 하고 후보는 빈 배열로 둔다.
- reason 은 한국어 한 문장으로, 사진에서 실제로 보이는 근거(무늬·지느러미·체형·색)만 적는다. 30자 안팎.

도감 목록 (id · 이름 · 서식)`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  const origin = req.headers.origin || '';
  if (origin && !ALLOW_ORIGIN.includes(origin)) {
    return res.status(403).json({ ok: false, error: 'origin' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) {
    return res.status(429).json({ ok: false, error: 'rate' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    /* 키를 아직 안 넣었을 때. 브라우저는 이걸 받고 조용히 기존 추정으로 돌아간다. */
    return res.status(503).json({ ok: false, error: 'nokey' });
  }

  const body = req.body || {};
  const species = cleanSpecies(body.species);
  if (!species) return res.status(400).json({ ok: false, error: 'species' });

  /* data:image/jpeg;base64,... 형태로 온다. 앞머리를 떼고 알맹이만 쓴다. */
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
  if (!m) return res.status(400).json({ ok: false, error: 'image' });
  const [, kind, b64] = m;
  if (b64.length > 2_000_000) return res.status(413).json({ ok: false, error: 'toobig' });

  const water = body.water === '민물' || body.water === '바다' ? body.water : null;

  const system = [
    SYSTEM_HEAD,
    species.map(f => `${f.id} · ${f.name} · ${f.water}`).join('\n'),
  ].join('\n');

  const ask = water
    ? `${water} 낚시터에서 잡은 물고기다. 이 사진의 어종을 판별해라.`
    : '이 사진의 어종을 판별해라. 낚시터 정보는 없다.';

  const client = new Anthropic();

  try {
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',                       // 사진 한 장 분류라 깊게 생각할 일이 없다
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              isFish: { type: 'boolean' },
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    /* enum 으로 묶어 두면 목록 밖의 값이 아예 나올 수 없다 */
                    id: { type: 'string', enum: species.map(f => f.id) },
                    confidence: { type: 'integer' },
                    reason: { type: 'string' },
                  },
                  required: ['id', 'confidence', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['isFish', 'candidates'],
            additionalProperties: false,
          },
        },
      },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: `image/${kind}`, data: b64 } },
          { type: 'text', text: ask },
        ],
      }],
    });

    /* 안전 분류기가 요청을 거절하면 content 가 비어 있다. 먼저 확인한다. */
    if (r.stop_reason === 'refusal') {
      return res.status(200).json({ ok: false, error: 'refusal' });
    }

    const text = r.content.find(b => b.type === 'text')?.text;
    if (!text) return res.status(200).json({ ok: false, error: 'empty' });

    const parsed = JSON.parse(text);
    const known = new Set(species.map(f => f.id));
    const candidates = (parsed.candidates || [])
      .filter(c => known.has(c.id))
      .slice(0, 3)
      .map(c => ({
        id: c.id,
        confidence: Math.max(0, Math.min(100, Math.round(Number(c.confidence) || 0))),
        reason: String(c.reason || '').slice(0, 80),
      }));

    return res.status(200).json({
      ok: true,
      isFish: !!parsed.isFish,
      candidates,
      usage: {
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
        cacheRead: r.usage.cache_read_input_tokens || 0,
      },
    });
  } catch (e) {
    /* 429·5xx·타임아웃 등. 브라우저가 기존 추정으로 되돌아가면 되므로 조용히 끝낸다. */
    console.error('identify failed:', e?.status || '', e?.message || e);
    return res.status(200).json({ ok: false, error: 'upstream' });
  }
}
