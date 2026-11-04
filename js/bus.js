// 캠퍼스 주변 버스 정류장 · 실시간 도착정보 (경기도 버스정보, server.py 가 중계)

async function getJSON(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// { mock, stops: [{ id, name, mobileNo, lat, lon }] }
export const fetchStops = () => getJSON('/api/bus/stops');

// { mock, at, arrivals: [{ routeName, dest, terminal, buses: [{ min, stops, seats, lowFloor }] }] }
export const fetchArrivals = (stationId) => getJSON(`/api/bus/arrivals?stationId=${encodeURIComponent(stationId)}`);

export function fmtBus(b) {
  const when = b.min <= 1 ? '곧 도착' : `${b.min}분`;
  const extra = [];
  if (b.stops != null) extra.push(`${b.stops}정거장 전`);
  if (b.seats != null) extra.push(b.seats > 0 ? `${b.seats}석` : '만석');
  if (b.lowFloor) extra.push('저상');
  return { when, extra: extra.join(' · ') };
}
