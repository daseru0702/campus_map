import { NODES, EDGES, SPEED, STEPS_PENALTY, STAIR, walkSpeed, bikeSpeed } from './data.js';

export const nodeById = Object.fromEntries(NODES.map((n) => [n.id, n]));

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const geomLength = (g) => g.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - g[i - 1][0], p[1] - g[i - 1][1]) : 0), 0);

// 피해 갈 구역(대운동장 등)의 길은 경로를 고를 때만 이만큼 오래 걸리는 것으로 친다 (표시 시간은 실제 그대로)
const AVOID_PENALTY = 5;
// 오르막은 시간보다 더 힘들게 느껴진다: 경로를 고를 때만 1m 오를 때마다 이만큼(초) 더 걸리는 것으로 친다.
// 시간이 비슷하면 덜 오르는 길을 고른다 (예: 정문 → ACE교육관은 체육대학 위 급경사 대신 대운동장 서쪽 도로)
export const CLIMB_PENALTY = { walk: 3, bike: 3 };
const MAX_GRADE = 0.3; // 높이 자료 오차로 튀는 경사를 이 안으로 제한 (계단 제외)

// 간선을 높이 단면(z, 같은 간격)을 따라 한 방향으로 지날 때의 { walk, bike 소요시간(초), climb 오르는 높이(m) }
// 자전거는 보행로·계단을 쓸 수 없다. 계단은 평지보다 느린 걸음과 칸 수로 센 시간 중 긴 쪽.
function traverse(e, z) {
  const piece = e.length / (z.length - 1);
  let walk = 0, bike = 0, climb = 0, stairs = 0;
  for (let i = 1; i < z.length; i++) {
    const dz = z[i] - z[i - 1];
    const grade = piece ? Math.max(-MAX_GRADE, Math.min(MAX_GRADE, dz / piece)) : 0;
    walk += piece / walkSpeed(grade);
    bike += piece / bikeSpeed(grade);
    climb += Math.max(0, dz);
    stairs += (Math.abs(dz) / STAIR.rise) * (dz > 0 ? STAIR.up : STAIR.down);
  }
  if (e.kind === 'steps') walk = Math.max((e.length / SPEED.walk) * STEPS_PENALTY, stairs);
  return { walk, bike: e.bike ? bike : Infinity, climb };
}

// 인접 리스트: nodeId -> [{ to, edge, dir }] — dir 0: a→b, 1: b→a
const adj = {};
export const edges = EDGES.map((src) => {
  const e = { ...src, length: geomLength(src.geom) };
  const z = src.z ?? [0, 0]; // 높이 자료가 없으면 평지로 본다
  e.cost = [traverse(e, z), traverse(e, [...z].reverse())];
  (adj[e.a] ??= []).push({ to: e.b, edge: e, dir: 0 });
  (adj[e.b] ??= []).push({ to: e.a, edge: e, dir: 1 });
  return e;
});

// 최소 힙
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// 다익스트라. from/to 는 노드 하나 또는 여러 개(건물 출입 지점들) — 그중 가장 빠른 조합을 고른다.
// 반환: { path: [nodeId], edges: [edge], length(m), time(s), climb(m) } 또는 null
export function shortestPath(from, to, mode) {
  const sources = [].concat(from);
  const targets = new Set([].concat(to));
  const same = sources.find((n) => targets.has(n));
  if (same) return { path: [same], edges: [], length: 0, time: 0, climb: 0 };
  const best = {};
  const prev = {};
  const done = new Set();
  const queue = new Heap();
  for (const s of sources) {
    best[s] = 0;
    queue.push([0, s]);
  }
  let reached = null;
  while (queue.size) {
    const [t, u] = queue.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (targets.has(u)) {
      reached = u;
      break;
    }
    for (const { to: v, edge, dir } of adj[u] ?? []) {
      const c = edge.cost[dir];
      const nt = t + c[mode] * (edge.avoid ? AVOID_PENALTY : 1) + c.climb * CLIMB_PENALTY[mode];
      if (nt < (best[v] ?? Infinity)) {
        best[v] = nt;
        prev[v] = { u, edge, dir };
        queue.push([nt, v]);
      }
    }
  }
  if (!reached) return null;
  const path = [reached];
  const used = [];
  let time = 0, climb = 0;
  for (let v = reached; prev[v]; v = prev[v].u) {
    const { u, edge, dir } = prev[v];
    used.unshift(edge);
    path.unshift(u);
    time += edge.cost[dir][mode];
    climb += edge.cost[dir].climb;
  }
  return { path, edges: used, length: used.reduce((s, e) => s + e.length, 0), time, climb };
}

// 경로를 실제 길 모양(간선 geom)을 따라가는 좌표 목록으로 펼친다
export function routePoints(route) {
  const first = nodeById[route.path[0]];
  const pts = [{ x: first.x, y: first.y }];
  route.edges.forEach((e, i) => {
    const g = e.a === route.path[i] ? e.geom : [...e.geom].reverse();
    for (const [x, y] of g.slice(1)) pts.push({ x, y });
  });
  return pts;
}

// 좌표 목록을 따라 distance(m)만큼 진행했을 때의 위치
export function pointAlong(points, distance) {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (left <= seg) {
      const r = seg === 0 ? 0 : left / seg;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * r,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * r,
      };
    }
    left -= seg;
  }
  const last = points[points.length - 1];
  return { ...last, done: true };
}

export const totalLength = (points) =>
  points.reduce((s, p, i) => (i ? s + dist(points[i - 1], p) : 0), 0);

// 지도에서 탭한 지점과 가장 가까운 노드
export const nearestNode = (x, y) =>
  NODES.reduce((b, n) => (Math.hypot(n.x - x, n.y - y) < Math.hypot(b.x - x, b.y - y) ? n : b));
