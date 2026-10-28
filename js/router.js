// 대여 여부에 따른 경로 안내
//  - 미대여: 도보 최적경로 (도보 전용 지름길 포함)
//  - 대여 중: 자전거 최적경로(도로만) → 목적지에서 가장 유리한 대여소에 반납 → 도보로 마무리

import { shortestPath } from './graph.js';
import { stations, dockedAt, hasFreeDock } from './sim.js';

const leg = (mode, from, to) => {
  const r = shortestPath(from, to, mode);
  return r && { mode, ...r };
};
const summarize = (legs) => ({
  legs: legs.filter((l) => l.edges.length),
  time: legs.reduce((s, l) => s + l.time, 0),
  length: legs.reduce((s, l) => s + l.length, 0),
});

export function planWalk(from, to) {
  const w = leg('walk', from, to);
  return w && { kind: 'walk', ...summarize([w]) };
}

// 자전거를 탄 상태에서: 반납 대여소를 골라 자전거+도보 합산 시간이 최소가 되도록
export function planRide(from, to) {
  let best = null;
  for (const s of stations) {
    if (!hasFreeDock(s.id)) continue;
    const ride = leg('bike', from, s.node);
    const walk = leg('walk', s.node, to);
    if (!ride || !walk) continue;
    const plan = { kind: 'ride', returnStation: s, ...summarize([ride, walk]) };
    if (!best || plan.time < best.time) best = plan;
  }
  return best;
}

// 미대여 상태에서 "자전거를 빌리면 얼마나 걸리는지" 비교용
export function planWalkToBike(from, to) {
  let best = null;
  for (const s of stations) {
    if (!dockedAt(s.id).length) continue;
    const toStation = leg('walk', from, s.node);
    const rest = planRide(s.node, to);
    if (!toStation || !rest) continue;
    const time = toStation.time + rest.time;
    if (!best || time < best.time) best = { rentStation: s, returnStation: rest.returnStation, time };
  }
  return best;
}

export const fmtTime = (sec) => {
  const m = Math.round(sec / 60);
  return m < 1 ? '1분 미만' : `${m}분`;
};
export const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);
