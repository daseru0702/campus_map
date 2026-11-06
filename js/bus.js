// 캠퍼스 주변 버스 정류장 · 실시간 도착정보 (경기도 버스정보)
// 같은 서버의 api/bus 가 중계한다: 로컬은 server.py, 공개 사이트(Cloudflare)는 relay/worker.js.
// 중계가 없는 GitHub Pages(베타)는 공개 사이트의 중계를 빌려 쓴다.
// 중계 서버에 닿지 못하면 예시 데이터로 대신한다 (mock: 'offline').

const RELAY_URL = 'https://campus-map.daseru.workers.dev';
const API = location.hostname.endsWith('github.io') ? `${RELAY_URL}/api/bus` : 'api/bus';

class NoServer extends Error {}

async function getJSON(url) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    throw new NoServer();
  }
  // 정적 호스팅은 /api 경로에 HTML 404 를 돌려준다
  if (!(r.headers.get('content-type') || '').includes('json')) throw new NoServer();
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function withFallback(url, mock) {
  try {
    return await getJSON(url);
  } catch (e) {
    if (e instanceof NoServer) return { mock: 'offline', ...mock() };
    throw e;
  }
}

// { mock, stops: [{ id, name, mobileNo, lat, lon }] }
export const fetchStops = () => withFallback(`${API}/stops`, () => ({ stops: MOCK_STOPS }));

// { mock, at, arrivals: [{ routeName, dest, terminal, buses: [{ min, stops, seats, lowFloor }] }] }
export const fetchArrivals = (stationId) =>
  withFallback(`${API}/arrivals?stationId=${encodeURIComponent(stationId)}`,
    () => ({ at: Math.floor(Date.now() / 1000), arrivals: mockArrivals(stationId) }));

export function fmtBus(b) {
  const when = b.min <= 1 ? '곧 도착' : `${b.min}분`;
  const extra = [];
  if (b.stops != null) extra.push(`${b.stops}정거장 전`);
  if (b.seats != null) extra.push(b.seats > 0 ? `${b.seats}석` : '만석');
  if (b.lowFloor) extra.push('저상');
  return { when, extra: extra.join(' · ') };
}

// ---------------- 예시 데이터 (server.py 의 MOCK_* 와 같은 내용) ----------------
const MOCK_STOPS = [
  { id: 'mock-1', name: '수원대학교 정문 (예시)', mobileNo: '', lat: 37.21405, lon: 126.97955 },
  { id: 'mock-2', name: '수원대학교 정문 건너편 (예시)', mobileNo: '', lat: 37.21420, lon: 126.98000 },
  { id: 'mock-3', name: '와우리 입구 (예시)', mobileNo: '', lat: 37.21330, lon: 126.97330 },
];
const MOCK_ROUTES = [['예시1', '수원역'], ['예시2', '병점역'], ['예시3', '봉담읍'], ['예시4', '사당역']];

// 정류장·분 단위로 고정된 난수라 1분 동안은 같은 값이 나온다
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
  const routes = [...MOCK_ROUTES].sort(() => rnd() - 0.5).slice(0, 3);
  return routes.map(([name, dest]) => {
    const first = int(1, 15);
    return { routeId: name, routeName: name, dest, buses: [
      { min: first, stops: Math.max(1, first >> 1), seats: rnd() < 0.5 ? null : int(0, 40), lowFloor: rnd() < 0.4 },
      { min: first + int(8, 20), stops: (first >> 1) + 5, seats: null, lowFloor: false },
    ] };
  }).sort((a, b) => a.buses[0].min - b.buses[0].min);
}
