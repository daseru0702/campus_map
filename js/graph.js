import { NODES, EDGES, SPEED, STEPS_PENALTY } from './data.js';

export const nodeById = Object.fromEntries(NODES.map((n) => [n.id, n]));

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const geomLength = (g) => g.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - g[i - 1][0], p[1] - g[i - 1][1]) : 0), 0);

// 인접 리스트: nodeId -> [{ to, edge }]
const adj = {};
export const edges = EDGES.map((src) => {
  const e = { ...src, length: geomLength(src.geom) };
  (adj[e.a] ??= []).push({ to: e.b, edge: e });
  (adj[e.b] ??= []).push({ to: e.a, edge: e });
  return e;
});

// 이동 수단별 간선 소요시간(초). 자전거는 보행로·계단을 쓸 수 없다.
function edgeTime(e, mode) {
  if (mode === 'bike' && !e.bike) return Infinity;
  const penalty = mode === 'walk' && e.kind === 'steps' ? STEPS_PENALTY : 1;
  return (e.length / SPEED[mode]) * penalty;
}

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

// 다익스트라. 반환: { path: [nodeId], edges: [edge], length(m), time(s) } 또는 null
export function shortestPath(from, to, mode) {
  if (from === to) return { path: [from], edges: [], length: 0, time: 0 };
  const best = { [from]: 0 };
  const prev = {};
  const done = new Set();
  const queue = new Heap();
  queue.push([0, from]);
  while (queue.size) {
    const [t, u] = queue.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const { to: v, edge } of adj[u] ?? []) {
      const nt = t + edgeTime(edge, mode);
      if (nt < (best[v] ?? Infinity)) {
        best[v] = nt;
        prev[v] = { u, edge };
        queue.push([nt, v]);
      }
    }
  }
  if (!(to in prev)) return null;
  const path = [to];
  const used = [];
  for (let v = to; v !== from; v = prev[v].u) {
    used.unshift(prev[v].edge);
    path.unshift(prev[v].u);
  }
  return { path, edges: used, length: used.reduce((s, e) => s + e.length, 0), time: best[to] };
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
