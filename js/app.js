/* global L */
import { CAMPUS, BUILDINGS, SPEED, toLatLng, fromLatLng } from './data.js';
import { nodeById, edges, routePoints, pointAlong, totalLength, nearestNode } from './graph.js';
import {
  bikes, stations, stationById, dockedAt, hasFreeDock,
  subscribe, rent, returnBike, moveMyBike, start as startSim, TIME_SCALE,
} from './sim.js';
import { planWalk, planRide, planWalkToBike, fmtTime, fmtDist } from './router.js';

const $ = (s) => document.querySelector(s);
const ll = (p) => toLatLng(p.x, p.y);

// ---------------- 상태 ----------------
const gate = BUILDINGS.find((b) => b.name === '정문');
const startNode = nodeById[gate.node];
const state = {
  me: { node: startNode.id, x: startNode.x, y: startNode.y },
  myBike: null, // 대여 중인 자전거 id
  dest: null,   // 목적지 노드 id
  destName: null,
  plan: null,
  nav: null,    // 안내(이동) 진행 상태
  locating: false,
  openStation: null,
};

const stationAtNode = (nodeId) => stations.find((s) => s.node === nodeId);

// ---------------- 지도 ----------------
const map = L.map('map', { zoomControl: false, attributionControl: true });
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const boundary = CAMPUS.boundary.map(([x, y]) => toLatLng(x, y));
L.polygon(boundary, { className: 'campus-boundary', interactive: false }).addTo(map);
const fitCampus = () => map.fitBounds(L.latLngBounds(boundary), { padding: [10, 10] });
fitCampus();
// 레이아웃(그리드)이 확정된 뒤 크기를 다시 계산해야 처음 확대 수준이 맞는다
requestAnimationFrame(() => {
  map.invalidateSize();
  fitCampus();
});

// 도보 전용 길(보행로·계단) 표시 — 자전거로는 못 가는 지름길
const shortcutLayer = L.layerGroup().addTo(map);
for (const e of edges) {
  if (e.bike) continue;
  L.polyline(e.geom.map(([x, y]) => toLatLng(x, y)), {
    className: e.kind === 'steps' ? 'net-steps' : 'net-footway', interactive: false,
  }).addTo(shortcutLayer);
}

const routeLayer = L.layerGroup().addTo(map);

// 목적지(건물)
const buildingMarkers = {};
for (const b of BUILDINGS) {
  const m = L.circleMarker(ll(b), { radius: 6, className: 'bld' })
    .bindTooltip(b.name, { direction: 'top', offset: [0, -6], className: 'bld-tip' })
    .on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (state.locating) return setMyLocation(b.node);
      setDest(b.node, b.name);
    })
    .addTo(map);
  buildingMarkers[b.node] = m;
}

// 대여소
const stationMarkers = {};
for (const s of stations) {
  const m = L.marker(ll(s), {
    icon: L.divIcon({ className: 'stn-wrap', html: '<div class="stn"><b></b></div>', iconSize: [30, 30] }),
    zIndexOffset: 500,
  })
    .bindTooltip(s.name, { direction: 'top', offset: [0, -14] })
    .on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (state.locating) return setMyLocation(s.node);
      openStation(s.id);
    })
    .addTo(map);
  stationMarkers[s.id] = m;
}

// 이동 중인 자전거(다른 이용자)와 나
const bikeMarkers = {};
const meHalo = L.circleMarker(ll(state.me), { radius: 18, className: 'me-halo', interactive: false }).addTo(map);
const meDot = L.circleMarker(ll(state.me), { radius: 8, className: 'me', interactive: false }).addTo(map);

map.on('click', (ev) => {
  if (!state.locating) return;
  const p = fromLatLng(ev.latlng.lat, ev.latlng.lng);
  setMyLocation(nearestNode(p.x, p.y).id);
});

function updateMarkers() {
  for (const s of stations) {
    const n = dockedAt(s.id).length;
    const el = stationMarkers[s.id].getElement()?.querySelector('.stn');
    if (!el) continue;
    el.classList.toggle('empty', !n);
    el.firstChild.textContent = n;
  }
  for (const b of bikes) {
    const show = b.status === 'in_use';
    if (show && !bikeMarkers[b.id]) {
      bikeMarkers[b.id] = L.circleMarker(ll(b), { radius: 6, className: 'bk in_use', interactive: false })
        .bindTooltip(b.id).addTo(map);
    } else if (!show && bikeMarkers[b.id]) {
      bikeMarkers[b.id].remove();
      delete bikeMarkers[b.id];
    }
    bikeMarkers[b.id]?.setLatLng(ll(b));
  }
  const riding = !!state.myBike;
  meDot.setLatLng(ll(state.me));
  meHalo.setLatLng(ll(state.me));
  meDot.getElement()?.classList.toggle('riding', riding);
  meHalo.getElement()?.classList.toggle('riding', riding);
}

function drawRoute() {
  routeLayer.clearLayers();
  if (!state.plan) return;
  for (const l of state.plan.legs) {
    const pts = routePoints(l).map(ll);
    if (l.mode === 'bike') L.polyline(pts, { className: 'r-bike-casing', interactive: false }).addTo(routeLayer);
    L.polyline(pts, { className: l.mode === 'bike' ? 'r-bike' : 'r-walk', interactive: false }).addTo(routeLayer);
  }
  if (state.dest) {
    const d = nodeById[state.dest];
    L.circleMarker(ll(d), { radius: 9, className: 'dest-pin', interactive: false }).addTo(routeLayer);
  }
}

// ---------------- 경로 계산 ----------------
function replan() {
  if (!state.dest || state.nav) return renderRouteInfo();
  state.plan = state.myBike ? planRide(state.me.node, state.dest) : planWalk(state.me.node, state.dest);
  drawRoute();
  renderRouteInfo();
}

function legDetail(l) {
  const steps = l.edges.filter((e) => e.kind === 'steps').length;
  const foot = l.edges.filter((e) => e.kind === 'footway').reduce((s, e) => s + e.length, 0);
  const parts = [];
  if (foot >= 20) parts.push(`보행로 ${fmtDist(foot)}`);
  if (steps) parts.push(`계단 ${steps}곳`);
  return parts.length ? ` · 지름길: ${parts.join(', ')}` : '';
}

function renderRouteInfo() {
  const box = $('#routeInfo');
  const go = $('#goBtn');
  const p = state.plan;
  go.textContent = state.nav ? '이동 중…' : '안내 시작';
  if (!state.dest) {
    box.className = 'route-info muted';
    box.textContent = state.myBike
      ? '자전거 대여 중입니다. 목적지를 선택하면 자전거 경로 + 반납 대여소를 안내합니다.'
      : '목적지를 선택하면 경로를 안내합니다.';
    go.disabled = true;
    return;
  }
  if (!p) {
    box.className = 'route-info muted';
    box.textContent = '경로를 찾을 수 없습니다.';
    go.disabled = true;
    return;
  }
  box.className = 'route-info';
  const legHtml = p.legs.map((l) => {
    const label = l.mode === 'bike' ? '자전거 (차도)' : '도보';
    return `<div class="leg"><span class="leg-dot ${l.mode}"></span><span>${label} ${fmtDist(l.length)} · ${fmtTime(l.time)}${legDetail(l)}</span></div>`;
  }).join('');

  let hint = '';
  if (p.kind === 'ride') {
    hint = `<div class="hint">🅿️ <b>${p.returnStation.name}</b>에 반납 후 도보로 이동합니다.</div>`;
  } else if (!state.nav) {
    const alt = planWalkToBike(state.me.node, state.dest);
    if (alt && alt.time < p.time - 30) {
      hint = `<div class="hint">🚲 ${alt.rentStation.name}에서 자전거를 빌리면 약 <b>${fmtTime(alt.time)}</b> (도보보다 ${fmtTime(p.time - alt.time)} 빠름)
        <br><button class="btn small" id="toStationBtn" style="margin-top:6px">대여소로 길찾기</button></div>`;
      queueMicrotask(() => $('#toStationBtn')?.addEventListener('click', () => setDest(alt.rentStation.node, alt.rentStation.name)));
    }
  }
  box.innerHTML = `<div class="muted">${state.destName}까지</div>
    <div class="route-total">${fmtTime(p.time)} <span class="muted small">${fmtDist(p.length)}</span></div>${legHtml}${hint}`;
  go.disabled = !!state.nav || !p.legs.length;
}

function setDest(nodeId, name) {
  if (state.nav) {
    const cur = BUILDINGS.find((x) => x.node === state.dest && x.name === state.destName);
    $('#destSelect').value = cur ? cur.id : '';
    return toast('이동 중에는 목적지를 바꿀 수 없습니다.');
  }
  state.dest = nodeId || null;
  state.destName = name ?? null;
  const b = BUILDINGS.find((x) => x.node === nodeId && x.name === name);
  $('#destSelect').value = b ? b.id : '';
  if (!nodeId) state.plan = null;
  replan();
  drawRoute();
}

// ---------------- 이동 시뮬레이션 (안내 시작) ----------------
function startNav() {
  if (!state.plan || state.nav) return;
  // 반납 대여소가 바로 지금 위치라면 자전거 구간 없이 즉시 반납
  if (state.plan.kind === 'ride' && state.plan.legs[0]?.mode !== 'bike') {
    returnBike(state.myBike, state.plan.returnStation.id);
    state.myBike = null;
    updateModeBadge();
  }
  const points = routePoints(state.plan.legs[0]);
  state.nav = { legIndex: 0, travelled: 0, points, length: totalLength(points) };
  closeStation();
  renderRouteInfo();
}

function stepNav(dt) {
  const nav = state.nav;
  const l = state.plan.legs[nav.legIndex];
  nav.travelled += SPEED[l.mode] * dt * TIME_SCALE;
  const p = pointAlong(nav.points, nav.travelled);
  state.me.x = p.x;
  state.me.y = p.y;
  if (l.mode === 'bike') moveMyBike(state.myBike, p.x, p.y);
  if (nav.travelled < nav.length) return;

  state.me.node = l.path[l.path.length - 1];
  if (l.mode === 'bike') {
    const s = state.plan.returnStation;
    returnBike(state.myBike, s.id);
    state.myBike = null;
    updateModeBadge();
    toast(`${s.name}에 반납했습니다. 도보 안내로 전환합니다.`);
  }
  nav.legIndex++;
  if (nav.legIndex >= state.plan.legs.length) {
    state.nav = null;
    toast(`${state.destName}에 도착했습니다.`);
    const s = stationAtNode(state.me.node);
    setDest(null);
    if (s) openStation(s.id);
    return;
  }
  nav.travelled = 0;
  nav.points = routePoints(state.plan.legs[nav.legIndex]);
  nav.length = totalLength(nav.points);
}

// ---------------- 대여소 패널 ----------------
function openStation(sid) {
  state.openStation = sid;
  renderStation();
}
function closeStation() {
  state.openStation = null;
  $('#stationCard').hidden = true;
}
function renderStation() {
  const card = $('#stationCard');
  const sid = state.openStation;
  if (!sid) return;
  const s = stationById[sid];
  const here = state.me.node === s.node && !state.nav;
  const list = dockedAt(sid);
  let body;
  if (state.myBike) {
    body = here
      ? `<button class="btn ok" data-act="return">${state.myBike} 여기에 반납</button>`
      : '<div class="muted small">이 대여소에 도착하면 반납할 수 있습니다.</div>';
    if (here && !hasFreeDock(sid)) body = '<div class="muted small">거치대가 가득 찼습니다.</div>';
  } else if (!list.length) {
    body = '<div class="muted small">대여 가능한 자전거가 없습니다.</div>';
  } else {
    body = `<ul class="station-bikes">${list.map((b) =>
      `<li><span>${b.id} <span class="muted small">🔋${Math.round(b.battery)}%</span></span>
        <button class="btn primary" data-act="rent" data-bike="${b.id}" ${here ? '' : 'disabled'}>대여</button></li>`).join('')}</ul>`;
    if (!here) body += '<div class="muted small" style="margin-top:6px">대여소에 도착해야 대여할 수 있습니다.</div>';
  }
  const nav = here || state.nav ? '' : '<button class="btn" data-act="route" style="margin-top:8px;width:100%">이 대여소로 길찾기</button>';
  card.innerHTML = `<div class="station-title"><span>${s.name}</span>
      <span><span class="muted small">${list.length}/${s.capacity}</span> <button class="close" data-act="close" aria-label="닫기">×</button></span></div>
    <div style="margin-top:8px">${body}</div>${nav}`;
  card.hidden = false;
}

$('#stationCard').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const sid = state.openStation;
  if (act === 'close') return closeStation();
  if (act === 'route') setDest(stationById[sid].node, stationById[sid].name);
  if (act === 'rent' && rent(e.target.dataset.bike)) {
    state.myBike = e.target.dataset.bike;
    updateModeBadge();
    toast(`${state.myBike} 대여 완료 — 자전거 경로로 안내합니다.`);
    if (state.dest === stationById[sid].node) setDest(null);
    replan();
  }
  if (act === 'return' && returnBike(state.myBike, sid)) {
    toast(`${state.myBike} 반납 완료`);
    state.myBike = null;
    updateModeBadge();
    replan();
  }
  renderStation();
});

// ---------------- 입력 ----------------
function setMyLocation(nodeId) {
  if (state.nav) return toast('이동 중에는 위치를 바꿀 수 없습니다.');
  if (state.myBike) return toast('대여 중에는 위치를 직접 바꿀 수 없습니다.');
  const n = nodeById[nodeId];
  state.me = { node: nodeId, x: n.x, y: n.y };
  setLocating(false);
  toast('현재 위치를 설정했습니다.');
  replan();
  const s = stationAtNode(nodeId);
  if (s) openStation(s.id);
}

function setLocating(on) {
  state.locating = on;
  $('#map').classList.toggle('locating', on);
  $('#locBtn').classList.toggle('active', on);
  $('#locBtn').textContent = on ? '지도에서 위치를 탭하세요' : '📍 내 위치 설정';
}
$('#locBtn').addEventListener('click', () => setLocating(!state.locating));

const destSelect = $('#destSelect');
for (const b of BUILDINGS) destSelect.add(new Option(b.name, b.id));
destSelect.addEventListener('change', () => {
  const b = BUILDINGS.find((x) => x.id === destSelect.value);
  setDest(b?.node, b?.name);
});
$('#goBtn').addEventListener('click', startNav);
$('#clearBtn').addEventListener('click', () => !state.nav && setDest(null));

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#tab-bikes').hidden = t.dataset.tab !== 'bikes';
    $('#tab-log').hidden = t.dataset.tab !== 'log';
  }));

function updateModeBadge() {
  const b = $('#modeBadge');
  b.className = `badge ${state.myBike ? 'bike' : 'walk'}`;
  b.textContent = state.myBike ? `자전거 모드 · ${state.myBike}` : '도보 모드';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------- 자전거 현황 / 로그 ----------------
const STATUS_LABEL = { docked: '거치', in_use: '이용 중', mine: '내 대여' };
const flashed = new Map();
let gpsCount = 0;

subscribe(({ type, bike, message, at }) => {
  flashed.set(bike.id, performance.now());
  if (type === 'gps') {
    gpsCount++;
    return;
  }
  const li = document.createElement('li');
  li.innerHTML = `<time>${at.toLocaleTimeString('ko-KR')}</time>${message}`;
  $('#log').prepend(li);
  while ($('#log').children.length > 80) $('#log').lastChild.remove();
  // 대여소 재고가 바뀌면 현재 경로/패널도 갱신
  if (!state.nav) replan();
  renderStation();
});

function renderBikeTable() {
  const now = performance.now();
  $('#bikeRows').innerHTML = bikes.map((b) => {
    let where = `(${Math.round(b.x)}, ${Math.round(b.y)})`;
    if (b.status === 'docked') where = stationById[b.station].name;
    else {
      const [la, lo] = ll(b);
      where = `${la.toFixed(5)}, ${lo.toFixed(5)}`;
    }
    const flash = now - (flashed.get(b.id) ?? 0) < 400 ? ' class="flash"' : '';
    return `<tr${flash}><td>${b.id}</td><td class="st ${b.status}">${STATUS_LABEL[b.status]}</td><td>${where}</td><td>${Math.round(b.battery)}%</td></tr>`;
  }).join('');
  $('#gpsCount').textContent = gpsCount;
}

// ---------------- 루프 ----------------
let last = performance.now();
let tableAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.nav) stepNav(dt);
  updateMarkers();
  tableAcc += dt;
  if (tableAcc > 0.25) {
    tableAcc = 0;
    renderBikeTable();
  }
  requestAnimationFrame(frame);
}

updateModeBadge();
renderRouteInfo();
startSim();
openStation('S1');
requestAnimationFrame(frame);
