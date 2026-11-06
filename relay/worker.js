// 경기도 버스정보(GBIS) API 중계 — Cloudflare Workers 용.
// server.py 의 /api/bus/* 와 같은 응답을 돌려준다. 정적 배포(GitHub Pages)된 앱이 이 주소를 부른다.
//
// 인증키는 브라우저에 노출되지 않도록 Worker 비밀값(BUS_API_KEY)으로만 보관한다:
//   npx wrangler secret put BUS_API_KEY
// 키가 없으면 예시 데이터를 돌려준다 (응답의 mock: true).
//
// API:
//   GET /api/bus/stops                  캠퍼스 주변 정류장 목록
//   GET /api/bus/arrivals?stationId=..  정류장 실시간 도착정보

const GBIS = 'https://apis.data.go.kr/6410000';

// 주변 정류장을 찾을 기준점 (위도, 경도) — server.py 의 SEARCH_POINTS 와 같게 유지
const SEARCH_POINTS = [
  [37.21381, 126.97982], // 정문
  [37.20990, 126.97650], // 캠퍼스 중심
  [37.21300, 126.97300], // 서쪽 (와우로34번길)
  [37.20560, 126.97900], // 남쪽
  [37.21150, 126.98150], // 동쪽 (효행로 방면)
];
const MAX_STOPS = 12;
const STOPS_TTL = 24 * 3600;
const ARRIVALS_TTL = 20;

// 남은 좌석 수가 의미 있는 노선 유형 (직행좌석·좌석·광역급행 등). 일반 시내버스는 0 으로 온다
const SEAT_ROUTE_TYPES = new Set([11, 12, 14, 16, 21, 22]);

// 이 출처에서 온 요청만 허용 (쉼표로 구분, wrangler.toml 의 ALLOWED_ORIGINS)
const DEFAULT_ORIGINS = 'https://daseru0702.github.io,http://localhost:5173,http://127.0.0.1:5173';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (obj, status = 200, ttl = 0) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` },
    });

    const key = normalizeKey(env.BUS_API_KEY);
    try {
      if (url.pathname === '/api/bus/stops') {
        if (!key) return json({ mock: true, stops: MOCK_STOPS });
        const stops = await cached(ctx, 'stops', STOPS_TTL, () => fetchStops(key));
        return json({ mock: false, stops }, 200, 3600);
      }
      if (url.pathname === '/api/bus/arrivals') {
        const sid = url.searchParams.get('stationId');
        if (!sid) return json({ error: 'stationId 가 필요합니다.' }, 400);
        const at = Math.floor(Date.now() / 1000);
        if (!key) return json({ mock: true, arrivals: mockArrivals(sid), at });
        const arrivals = await cached(ctx, `arr:${sid}`, ARRIVALS_TTL, () => fetchArrivals(key, sid));
        return json({ mock: false, arrivals, at }, 200, ARRIVALS_TTL);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) { // API 장애·키 오류 등은 화면에 그대로 알린다
      console.error('bus api:', e);
      return json({ error: `버스 정보를 가져오지 못했습니다: ${e.message}` }, 502);
    }
  },
};

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

// Encoding 키(%2B 등 포함)를 넣었으면 원래 값으로 되돌린다 (요청 시 다시 인코딩함)
function normalizeKey(key) {
  key = (key || '').trim();
  return key.includes('%') ? decodeURIComponent(key) : key;
}

// Workers 의 Cache API 로 결과를 잠깐 보관 (같은 데이터센터 안에서 공유)
async function cached(ctx, name, ttl, fn) {
  const req = new Request(`https://cache.internal/${encodeURIComponent(name)}`);
  const hit = await caches.default.match(req);
  if (hit) return hit.json();
  const value = await fn();
  ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify(value), {
    headers: { 'Cache-Control': `max-age=${ttl}` },
  })));
  return value;
}

// ---------------- GBIS 호출 ----------------
async function gbis(key, path, params) {
  const q = new URLSearchParams({ serviceKey: key, format: 'json', ...params });
  const r = await fetch(`${GBIS}/${path}?${q}`, { headers: { 'User-Agent': 'campus-bike' } });
  if (r.status === 401 || r.status === 403) {
    throw new Error('인증키가 올바르지 않거나 아직 사용할 수 없습니다. '
      + '활용신청한 API인지, 발급 직후라면 1~2시간 뒤 다시 확인해 주세요.');
  }
  const raw = (await r.text()).trim();
  // 키 오류 등은 format=json 이어도 XML 로 온다
  if (raw.startsWith('<')) {
    const tag = (t) => raw.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    const code = tag('resultCode') ?? tag('returnReasonCode') ?? '0';
    if (code === '4') return {};
    throw new Error(tag('resultMessage') || tag('returnAuthMsg') || tag('errMsg') || `API 오류 ${code}`);
  }
  const data = JSON.parse(raw);
  const resp = data.response || data.OpenAPI_ServiceResponse || data;
  const header = resp.msgHeader || resp.cmmMsgHeader || {};
  const code = String(header.resultCode ?? header.returnReasonCode ?? '0');
  if (code === '4') return {}; // 결과 없음
  if (code !== '0') throw new Error(header.resultMessage || header.returnAuthMsg || header.errMsg || `API 오류 ${code}`);
  return resp.msgBody || {};
}

const asList = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isNaN(n) ? null : n;
};
function distM(lat1, lon1, lat2, lon2) {
  const kx = 111320 * Math.cos(lat1 * Math.PI / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540);
}

async function fetchStops(key) {
  const found = new Map();
  const bodies = await Promise.all(SEARCH_POINTS.map(([lat, lon]) =>
    gbis(key, 'busstationservice/v2/getBusStationAroundListv2', { x: lon, y: lat })));
  for (const body of bodies) {
    for (const s of asList(body.busStationAroundList)) {
      const id = String(s.stationId ?? '');
      if (!id || found.has(id)) continue;
      const lat = Number(s.y), lon = Number(s.x);
      found.set(id, {
        id,
        name: s.stationName,
        mobileNo: String(s.mobileNo ?? '').trim(),
        lat,
        lon,
        region: s.regionName,
        d: Math.min(...SEARCH_POINTS.map(([a, b]) => distM(lat, lon, a, b))),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.d - b.d).slice(0, MAX_STOPS).map(({ d, ...s }) => s);
}

const routeNames = new Map(); // Worker 인스턴스가 살아 있는 동안만 유지
async function routeName(key, routeId) {
  if (!routeNames.has(routeId)) {
    let name = routeId;
    try {
      const body = await gbis(key, 'busrouteservice/v2/getBusRouteInfoItemv2', { routeId });
      name = String(body.busRouteInfoItem?.routeName || routeId);
    } catch { /* 노선 이름을 못 가져오면 번호 대신 ID 를 보여준다 */ }
    routeNames.set(routeId, name);
  }
  return routeNames.get(routeId);
}

async function fetchArrivals(key, stationId) {
  const body = await gbis(key, 'busarrivalservice/v2/getBusArrivalListv2', { stationId });
  const out = await Promise.all(asList(body.busArrivalList).map(async (a) => {
    const rid = String(a.routeId);
    const seated = SEAT_ROUTE_TYPES.has(num(a.routeTypeCd));
    const seats = (i) => {
      const n = num(a[`remainSeatCnt${i}`]);
      return seated && n != null && n >= 0 ? n : null;
    };
    // 이 정류장이 종점(회차)인 노선은 행선지가 정류장 자신으로 온다
    const terminal = String(a.routeDestId) === String(stationId);
    return {
      routeId: rid,
      routeName: String(a.routeName || await routeName(key, rid)),
      dest: terminal ? '' : (a.routeDestName || ''),
      terminal,
      buses: [1, 2]
        .map((i) => ({ min: num(a[`predictTime${i}`]), stops: num(a[`locationNo${i}`]), seats: seats(i), lowFloor: String(a[`lowPlate${i}`]) === '1' }))
        .filter((b) => b.min != null),
    };
  }));
  return out.sort((a, b) => (a.buses[0]?.min ?? 999) - (b.buses[0]?.min ?? 999));
}

// ---------------- 예시 데이터 (인증키 없을 때, server.py 와 같은 내용) ----------------
const MOCK_STOPS = [
  { id: 'mock-1', name: '수원대학교 정문 (예시)', mobileNo: '', lat: 37.21405, lon: 126.97955, region: '화성' },
  { id: 'mock-2', name: '수원대학교 정문 건너편 (예시)', mobileNo: '', lat: 37.21420, lon: 126.98000, region: '화성' },
  { id: 'mock-3', name: '와우리 입구 (예시)', mobileNo: '', lat: 37.21330, lon: 126.97330, region: '화성' },
];
const MOCK_ROUTES = [['예시1', '수원역'], ['예시2', '병점역'], ['예시3', '봉담읍'], ['예시4', '사당역']];

// 정류장·분 단위로 고정된 난수라 1분 동안은 같은 값이 나온다 (js/bus.js 와 같은 방식)
function seeded(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function mockArrivals(stationId) {
  const rnd = seeded(`${stationId}-${Math.floor(Date.now() / 60000)}`);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  return [...MOCK_ROUTES].sort(() => rnd() - 0.5).slice(0, 3).map(([name, dest]) => {
    const first = int(1, 15);
    return { routeId: name, routeName: name, dest, buses: [
      { min: first, stops: Math.max(1, first >> 1), seats: rnd() < 0.5 ? null : int(0, 40), lowFloor: rnd() < 0.4 },
      { min: first + int(8, 20), stops: (first >> 1) + 5, seats: null, lowFloor: false },
    ] };
  }).sort((a, b) => a.buses[0].min - b.buses[0].min);
}
