// 더미 자전거 시뮬레이터.
// 실제 하드웨어를 붙일 때는 이 모듈을 서버(WebSocket 등)에서 위치를 받아오는 구현으로 교체하면 된다.
// 외부에 노출하는 인터페이스: bikes, stations, subscribe(), rent(), returnBike(), moveMyBike()

import { STATIONS, INITIAL_BIKES, SPEED } from './data.js';
import { nodeById, shortestPath, routePoints, pointAlong, totalLength } from './graph.js';

export const TIME_SCALE = 8; // 시뮬레이션 배속

const stationNode = (sid) => nodeById[STATIONS.find((s) => s.id === sid).node];

export const stations = STATIONS.map((s) => ({ ...s, x: nodeById[s.node].x, y: nodeById[s.node].y }));
export const stationById = Object.fromEntries(stations.map((s) => [s.id, s]));

// status: docked | in_use(다른 이용자) | mine(내가 대여)
export const bikes = INITIAL_BIKES.map((b) => {
  const n = stationNode(b.station);
  return { ...b, status: 'docked', x: n.x, y: n.y, updatedAt: Date.now(), trip: null };
});
export const bikeById = Object.fromEntries(bikes.map((b) => [b.id, b]));

export const dockedAt = (sid) => bikes.filter((b) => b.status === 'docked' && b.station === sid);
export const hasFreeDock = (sid) => dockedAt(sid).length < stationById[sid].capacity;

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(type, bike, message) {
  bike.updatedAt = Date.now();
  for (const fn of listeners) fn({ type, bike, message, at: new Date() });
}

// ---- 내 대여/반납 ----
export function rent(bikeId) {
  const b = bikeById[bikeId];
  if (!b || b.status !== 'docked') return false;
  const from = b.station;
  b.status = 'mine';
  b.station = null;
  emit('rent', b, `${b.id} 대여 (${stationById[from].name})`);
  return true;
}

export function returnBike(bikeId, sid) {
  const b = bikeById[bikeId];
  if (!b || b.status !== 'mine' || !hasFreeDock(sid)) return false;
  Object.assign(b, { status: 'docked', station: sid, x: stationById[sid].x, y: stationById[sid].y });
  emit('return', b, `${b.id} 반납 (${stationById[sid].name})`);
  return true;
}

// 내가 탄 자전거의 위치 갱신 (자전거 GPS 보고를 흉내냄)
export function moveMyBike(bikeId, x, y) {
  const b = bikeById[bikeId];
  if (!b || b.status !== 'mine') return;
  b.x = x;
  b.y = y;
  b.battery = Math.max(5, b.battery - 0.001);
  emit('gps', b);
}

// ---- 다른 이용자(더미) ----
function startRandomTrip() {
  const candidates = bikes.filter((b) => b.status === 'docked' && dockedAt(b.station).length > 1);
  if (!candidates.length) return;
  const b = candidates[Math.floor(Math.random() * candidates.length)];
  const targets = stations.filter((s) => s.id !== b.station && hasFreeDock(s.id));
  if (!targets.length) return;
  const to = targets[Math.floor(Math.random() * targets.length)];
  const route = shortestPath(stationById[b.station].node, to.node, 'bike');
  if (!route) return;
  const points = routePoints(route);
  b.trip = { from: b.station, to: to.id, points, length: totalLength(points), travelled: 0 };
  b.status = 'in_use';
  emit('rent', b, `${b.id} 다른 이용자 대여 (${stationById[b.station].name} → ${to.name})`);
  b.station = null;
}

let last = performance.now();
let gpsAcc = 0;
function tick(now) {
  const dt = Math.min(0.2, (now - last) / 1000) * TIME_SCALE;
  last = now;
  gpsAcc += dt;
  const report = gpsAcc >= TIME_SCALE; // 시뮬레이션 기준 약 1초(실시간 1/배속)마다 GPS 보고
  if (report) gpsAcc = 0;

  for (const b of bikes) {
    if (b.status !== 'in_use') continue;
    const t = b.trip;
    t.travelled += SPEED.bike * 0.85 * dt;
    const p = pointAlong(t.points, t.travelled);
    b.x = p.x;
    b.y = p.y;
    if (t.travelled >= t.length) {
      const sid = hasFreeDock(t.to) ? t.to : stations.find((s) => hasFreeDock(s.id)).id;
      Object.assign(b, { status: 'docked', station: sid, trip: null, x: stationById[sid].x, y: stationById[sid].y });
      emit('return', b, `${b.id} 다른 이용자 반납 (${stationById[sid].name})`);
    } else if (report) {
      b.battery = Math.max(5, b.battery - 0.05);
      emit('gps', b);
    }
  }
  // 실시간 약 6초에 한 번 새 대여 발생, 동시 이용은 최대 5대
  const riding = bikes.filter((b) => b.status === 'in_use').length;
  if (riding < 5 && Math.random() < dt / TIME_SCALE / 6) startRandomTrip();
  requestAnimationFrame(tick);
}

export function start() {
  // 처음부터 몇 대는 이동 중으로 시작
  for (let i = 0; i < 3; i++) startRandomTrip();
  requestAnimationFrame(tick);
}
