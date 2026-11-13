import { BUILDINGS, SPEED, RENTAL_LIMIT_SEC, fromLatLng, toLatLng } from './data.js';
import { nodeById, shortestPath, routePoints, pointAlong, totalLength, nearestNode } from './graph.js';
import {
  bikes, bikeById, stations, stationById, dockedAt, hasFreeDock,
  subscribe, rent, returnBike, moveMyBike, start as startSim, TIME_SCALE,
} from './sim.js';
import { planWalk, planRide, planWalkToBike, fmtTime, fmtDist } from './router.js';
import { createMap } from './mapview.js';
import { watchGps, GPS_ERROR_TEXT } from './gps.js';
import { openScanner } from './qr.js';
import { fetchStops, fetchArrivals, fmtBus } from './bus.js';

const $ = (s) => document.querySelector(s);
// 내용이 바뀌었을 때만 다시 그린다 (주기적으로 갱신하는 목록에서 클릭이 끊기지 않도록)
const setHTML = (el, html) => {
  if (el._html !== html) el.innerHTML = el._html = html;
};
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// ---------------- 상태 ----------------
const gate = BUILDINGS.find((b) => b.name === '정문');
const state = {
  me: { node: gate.node, x: nodeById[gate.node].x, y: nodeById[gate.node].y },
  loc: 'demo',      // demo: 가상 위치(안내 시 자동 이동) | gps: 휴대폰 실제 위치
  gpsAccuracy: null,
  stopGps: null,
  start: null,      // { node, name } — null 이면 내 위치에서 출발
  dest: null,       // { node, name }
  plan: null,
  nav: null,        // 안내 진행 상태
  rental: null,     // { bikeId, elapsed(초), warned }
  picking: false,   // 지도에서 출발지 고르는 중
  station: null,    // 열려 있는 대여소 카드
  tab: 'stations',
};

const meNode = () => state.me.node;
// 건물은 출입 후보 지점(nodes) 중 가장 빠른 곳으로 나가고 들어간다
const nodesOf = (place) => place.nodes ?? place.node;
const originNode = () => (state.rental || !state.start ? meNode() : nodesOf(state.start));
const buildingPlace = (b) => ({ node: b.node, nodes: b.exits, name: b.name });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const remainingSec = () => RENTAL_LIMIT_SEC - (state.rental?.elapsed ?? 0);
const fmtMMSS = (sec) => {
  const s = Math.abs(Math.round(sec));
  return `${sec < 0 ? '+' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------- 지도 ----------------
const mv = createMap($('#map'), {
  onBuilding: (b) => (state.picking ? pickStart(buildingPlace(b)) : setDest(buildingPlace(b), true)),
  onStation: (s) => (state.picking ? pickStart({ node: s.node, name: s.name }) : openStation(s.id)),
  onMapClick: (latlng) => {
    if (!state.picking) return;
    const p = fromLatLng(latlng.lat, latlng.lng);
    pickStart({ node: nearestNode(p.x, p.y).id, name: '지도에서 고른 지점' });
  },
  // 안내 중이면 내 위치로 돌아가기만 한다 (위치 기준은 안내 중에 바꿀 수 없음)
  onLocate: () => (state.loc === 'gps' || state.nav ? mv.focus(state.me, state.nav ? 17.5 : 18) : startGps()),
});

// ---------------- 출발/도착 선택 ----------------
const startSelect = $('#startSelect');
const destSelect = $('#destSelect');

function fillPlaceOptions(select, first) {
  select.innerHTML = first;
  const gb = document.createElement('optgroup');
  gb.label = '건물';
  for (const b of BUILDINGS) gb.append(new Option(b.name, `b:${b.id}`));
  const gs = document.createElement('optgroup');
  gs.label = '대여소';
  for (const s of stations) gs.append(new Option(s.name, `s:${s.id}`));
  select.append(gb, gs);
}
fillPlaceOptions(startSelect, '<option value="">내 위치</option><option value="pick">지도에서 선택…</option><option value="picked" hidden>지도에서 고른 지점</option>');
fillPlaceOptions(destSelect, '<option value="">도착지를 선택하세요</option>');

function placeFromValue(v) {
  if (v.startsWith('b:')) {
    return buildingPlace(BUILDINGS.find((x) => x.id === v.slice(2)));
  }
  if (v.startsWith('s:')) {
    const s = stationById[v.slice(2)];
    return { node: s.node, name: s.name };
  }
  return null;
}
function valueOfPlace(p) {
  if (!p) return '';
  const b = BUILDINGS.find((x) => x.node === p.node && x.name === p.name);
  if (b) return `b:${b.id}`;
  const s = stations.find((x) => x.node === p.node && x.name === p.name);
  return s ? `s:${s.id}` : 'picked';
}
function syncSelects() {
  startSelect.value = state.rental ? '' : valueOfPlace(state.start);
  startSelect.disabled = !!state.rental || !!state.nav;
  destSelect.value = valueOfPlace(state.dest);
  destSelect.disabled = !!state.nav;
}

startSelect.addEventListener('change', () => {
  const v = startSelect.value;
  if (v === 'pick') return setPicking(true);
  state.start = placeFromValue(v);
  syncSelects();
  replan(true);
});
destSelect.addEventListener('change', () => setDest(placeFromValue(destSelect.value), true));
$('#swapBtn').addEventListener('click', () => {
  if (state.nav || state.rental) return toast(state.rental ? '대여 중에는 내 위치에서만 출발합니다.' : '');
  const from = state.start ?? { node: meNode(), name: '내 위치' };
  const to = state.dest;
  state.dest = from.name === '내 위치' ? null : from;
  state.start = to;
  syncSelects();
  replan(true);
});

function setPicking(on) {
  state.picking = on;
  mv.setLocating(on);
  $('#pickHint').hidden = !on;
  if (!on) syncSelects();
}
$('#pickCancel').addEventListener('click', () => setPicking(false));
function pickStart(place) {
  state.start = place;
  setPicking(false);
  replan(true);
}

function setDest(place, fit = false) {
  if (state.nav) return toast('안내 중에는 도착지를 바꿀 수 없습니다.');
  state.dest = place;
  syncSelects();
  replan(fit);
}

// ---------------- 경로 ----------------
function replan(fit = false) {
  if (state.nav) return renderRouteInfo();
  if (!state.dest) {
    state.plan = null;
  } else {
    state.plan = state.rental ? planRide(originNode(), nodesOf(state.dest)) : planWalk(originNode(), nodesOf(state.dest));
  }
  mv.drawRoute(state.plan, state.dest?.node);
  $('#legend').hidden = !state.plan;
  if (fit && state.plan) mv.fitRoute(state.plan);
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
  if (!state.dest) {
    box.className = 'route-info muted';
    box.textContent = state.rental
      ? '대여 중입니다. 도착지를 선택하면 자전거 경로와 반납 대여소를 안내합니다.'
      : '도착지를 선택하면 경로를 안내합니다.';
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
    hint = `<div class="hint"><b>${p.returnStation.name}</b>에 반납 후 도보로 이동합니다.</div>`;
    const bikeLeg = p.legs.find((l) => l.mode === 'bike');
    if (bikeLeg && bikeLeg.time > remainingSec()) hint += '<div class="hint warn">남은 이용시간 안에 반납하기 어려워요.</div>';
  } else {
    const alt = planWalkToBike(originNode(), nodesOf(state.dest));
    if (alt && alt.time < p.time - 30) {
      hint = `<div class="hint">${alt.rentStation.name}에서 자전거를 빌리면 약 <b>${fmtTime(alt.time)}</b> (도보보다 ${fmtTime(p.time - alt.time)} 빠름)
        <br><button class="btn small" data-to-station="${alt.rentStation.id}" style="margin-top:6px">대여소로 길찾기</button></div>`;
    }
  }
  const gpsStartNote = state.loc === 'gps' && state.start && !state.rental
    ? '<div class="hint">GPS 사용 중에는 내 위치에서 출발할 때만 안내를 시작할 수 있어요.</div>' : '';
  const from = state.rental || !state.start ? '내 위치' : state.start.name;
  box.innerHTML = `<div class="muted small">${from} → ${state.dest.name}</div>
    <div class="route-total">${fmtTime(p.time)} <span class="muted small">${fmtDist(p.length)}${p.climb >= 3 ? ` · 오르막 ${Math.round(p.climb)}m` : ''}</span></div>${legHtml}${hint}${gpsStartNote}`;
  go.disabled = !p.legs.length || (state.loc === 'gps' && !!state.start && !state.rental);
}
$('#routeInfo').addEventListener('click', (e) => {
  const sid = e.target.closest('[data-to-station]')?.dataset.toStation;
  if (sid) setDest({ node: stationById[sid].node, name: stationById[sid].name }, true);
});
$('#goBtn').addEventListener('click', startNav);
$('#clearBtn').addEventListener('click', () => {
  if (state.nav) return;
  state.start = null;
  setDest(null);
});

// ---------------- 안내 (지도+경로만 보이는 화면) ----------------
function setNavMode(on) {
  document.body.classList.toggle('nav-mode', on);
  $('#navHud').hidden = !on;
  syncSelects();
  setTimeout(() => {
    mv.invalidate();
    if (on) mv.focus(state.me, 17.5);
    else mv.stopFollow();
  }, 50);
}

function beginLeg(i) {
  const l = state.plan.legs[i];
  const points = routePoints(l);
  state.nav = { legIndex: i, travelled: 0, points, length: totalLength(points), canReturn: false, offFixes: 0 };
}

function startNav() {
  if (!state.plan || state.nav) return;
  if (state.start && !state.rental) {
    // 데모 위치: 고른 출발지(건물이면 경로가 시작되는 출입 지점)로 이동해서 시작
    moveMeTo(state.plan.legs[0]?.path[0] ?? state.start.node);
    state.start = null;
  }
  // 반납 대여소가 지금 위치라 자전거 구간이 없으면 바로 반납
  if (state.plan.kind === 'ride' && state.plan.legs[0]?.mode !== 'bike') returnAt(state.plan.returnStation.id);
  if (!state.plan.legs.length) return;
  beginLeg(0);
  closeStation();
  setNavMode(true);
  renderRouteInfo();
  renderNavHud();
}

function stopNav(arrived) {
  state.nav = null;
  setNavMode(false);
  if (arrived) {
    toast(`${state.dest.name}에 도착했습니다.`);
    state.dest = null;
    state.plan = null;
    syncSelects();
  }
  replan();
  renderRentCard();
}
$('#navStop').addEventListener('click', () => stopNav(false));

function advanceLeg() {
  const next = state.nav.legIndex + 1;
  if (next >= state.plan.legs.length) return stopNav(true);
  beginLeg(next);
}

function finishBikeLeg() {
  const s = state.plan.returnStation;
  if (returnAt(s.id)) toast(`${s.name}에 반납했습니다. 도보 안내로 전환합니다.`);
  advanceLeg();
}
$('#navReturn').addEventListener('click', finishBikeLeg);

// 데모 위치: 경로를 따라 자동 이동
function stepNavDemo(dt) {
  const nav = state.nav;
  const l = state.plan.legs[nav.legIndex];
  nav.travelled += (l.time ? nav.length / l.time : SPEED[l.mode]) * dt * TIME_SCALE; // 경사를 반영한 이 구간 평균 속도
  const p = pointAlong(nav.points, nav.travelled);
  state.me.x = p.x;
  state.me.y = p.y;
  if (l.mode === 'bike') moveMyBike(state.rental.bikeId, p.x, p.y);
  mv.follow(state.me);
  if (nav.travelled < nav.length) return;
  state.me.node = l.path[l.path.length - 1];
  if (l.mode === 'bike') finishBikeLeg();
  else advanceLeg();
}

// GPS: 실제 위치를 경로에 맞춰 진행, 벗어나면 다시 탐색
function project(points, p) {
  let best = { d: Infinity, along: 0, x: p.x, y: p.y };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seg = dist(a, b);
    const t = seg ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (seg * seg))) : 0;
    const x = a.x + t * (b.x - a.x), y = a.y + t * (b.y - a.y);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) best = { d, along: acc + t * seg, x, y };
    acc += seg;
  }
  return best;
}
const OFF_ROUTE_M = 35;     // 경로에서 이만큼(또는 GPS 오차의 1.5배) 넘게 벗어나면 이탈 후보
const OFF_ROUTE_FIXES = 3;  // 이탈 후보가 연속 이만큼 나와야 다시 탐색 (GPS 튐으로 재탐색하지 않도록)
function trackGps() {
  const nav = state.nav;
  const l = state.plan.legs[nav.legIndex];
  const { d, along, x, y } = project(nav.points, state.me);
  if (d > Math.max(OFF_ROUTE_M, (state.gpsAccuracy ?? 0) * 1.5)) {
    mv.follow(state.me);
    if (++nav.offFixes < OFF_ROUTE_FIXES) return;
    state.plan = state.rental ? planRide(meNode(), nodesOf(state.dest)) : planWalk(meNode(), nodesOf(state.dest));
    if (!state.plan?.legs.length) return stopNav(true);
    mv.drawRoute(state.plan, state.dest.node);
    beginLeg(0);
    toast('경로를 벗어나 다시 탐색했습니다.');
    return;
  }
  nav.offFixes = 0;
  // 경로 위에 있으면 내 위치를 경로선에 붙여 표시 (길 옆 건물 안으로 튀어 보이지 않게)
  state.me.x = x;
  state.me.y = y;
  if (state.rental) moveMyBike(state.rental.bikeId, x, y);
  mv.follow(state.me);
  // 오차로 조금 뒤로 튄 값은 무시해 남은 거리가 늘었다 줄었다 하지 않게
  if (along < nav.travelled && nav.travelled - along < 15) return;
  nav.travelled = along;
  const left = nav.length - along;
  if (l.mode === 'bike') nav.canReturn = left < 30;
  else if (left < 20) advanceLeg();
}

function renderNavHud() {
  const nav = state.nav;
  if (!nav) return;
  const p = state.plan;
  const l = p.legs[nav.legIndex];
  const left = Math.max(0, nav.length - nav.travelled);
  const rest = p.legs.slice(nav.legIndex + 1);
  const sec = (nav.length ? (l.time * left) / nav.length : 0) + rest.reduce((s, x) => s + x.time, 0);
  const meters = left + rest.reduce((s, x) => s + x.length, 0);
  const eta = new Date(Date.now() + sec * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  $('#navHud .nav-leg').innerHTML = l.mode === 'bike'
    ? `<span class="leg-dot bike"></span> 자전거로 이동 · 반납: <b>${p.returnStation.name}</b>`
    : `<span class="leg-dot walk"></span> 걸어서 <b>${state.dest.name}</b>까지`;
  $('#navHud .nav-remain').textContent = fmtTime(sec);
  $('#navHud .nav-sub').textContent = `${fmtDist(meters)} 남음 · 도착 ${eta}`;
  $('#navReturn').hidden = !(state.loc === 'gps' && l.mode === 'bike' && nav.canReturn);
}

// ---------------- 위치 (데모 / GPS) ----------------
function moveMeTo(nodeId) {
  const n = nodeById[nodeId];
  state.me = { node: nodeId, x: n.x, y: n.y };
}

function setLoc(mode) {
  state.loc = mode;
  updateLocChip();
  $('#locChip').classList.toggle('active', mode === 'gps');
  renderRouteInfo();
}
function updateLocChip() {
  const acc = state.gpsAccuracy;
  $('#locChip').textContent = state.loc !== 'gps' ? '데모 위치' : acc ? `GPS ±${Math.round(acc)}m` : 'GPS';
}

const FIRST_FIX_ACCURACY = 40; // m, 첫 위치는 이 정도로 정확해질 때까지 기다림
const FIRST_FIX_WAIT_MS = 10000; // 그래도 안 되면 이 시간 뒤 가장 나은 값으로 시작
function startGps() {
  if (state.nav) return toast('안내 중에는 위치 기준을 바꿀 수 없습니다.');
  toast('현재 위치를 확인하는 중…');
  let first = true;
  const startedAt = Date.now();
  state.stopGps?.();
  state.stopGps = watchGps((pos) => {
    const p = fromLatLng(pos.lat, pos.lng);
    const n = nearestNode(p.x, p.y);
    if (first) {
      // 켜자마자 오는 값은 기지국·와이파이 기반이라 수백 m 틀리는 경우가 많다
      if (pos.raw.accuracy > FIRST_FIX_ACCURACY && Date.now() - startedAt < FIRST_FIX_WAIT_MS) return;
      first = false;
      if (dist(n, p) - pos.accuracy > 300) {
        stopGps();
        return toast('캠퍼스 밖에 있어요. 데모 위치를 계속 사용합니다.');
      }
      setLoc('gps');
      toast(pos.accuracy > FIRST_FIX_ACCURACY
        ? `GPS 신호가 약해요 (오차 약 ${Math.round(pos.accuracy)}m). 실외로 나가면 더 정확해집니다.`
        : 'GPS 위치를 사용합니다.');
      mv.focus(p, 17.5);
    }
    const nodeChanged = n.id !== state.me.node;
    state.me = { node: n.id, x: p.x, y: p.y };
    state.gpsAccuracy = pos.accuracy;
    updateLocChip();
    if (state.rental) moveMyBike(state.rental.bikeId, p.x, p.y);
    if (state.nav) trackGps();
    else if (nodeChanged) replan();
  }, (err) => {
    stopGps();
    toast(GPS_ERROR_TEXT[err]);
  }, () => 1.5 * (state.rental ? SPEED.bike : SPEED.walk)); // 필터가 따라갈 이동 속도(여유를 둔 값)
}
function stopGps() {
  state.stopGps?.();
  state.stopGps = null;
  state.gpsAccuracy = null;
  setLoc('demo');
}
$('#locChip').addEventListener('click', () => {
  if (state.loc === 'gps') {
    if (state.nav) return toast('안내 중에는 위치 기준을 바꿀 수 없습니다.');
    stopGps();
    toast('데모 위치로 전환했습니다.');
  } else startGps();
});

// ---------------- 대여 / 반납 ----------------
function tryRent(bikeId) {
  if (state.rental) return toast('이미 대여 중인 자전거가 있습니다.');
  if (state.nav) return toast('안내를 종료한 뒤 대여해 주세요.');
  const b = bikeById[bikeId];
  if (!b) return toast(`${bikeId}: 등록되지 않은 자전거입니다.`);
  if (b.status !== 'docked') return toast(`${bikeId}: 지금은 대여할 수 없는 자전거입니다.`);
  const st = stationById[b.station];
  if (state.loc === 'gps') {
    if (dist(state.me, st) > 60) return toast(`${st.name} 근처에서 스캔해 주세요.`);
  } else {
    moveMeTo(st.node); // 데모 위치: 스캔한 대여소에 있는 것으로 간주
  }
  if (!rent(bikeId)) return toast('대여에 실패했습니다.');
  state.rental = { bikeId, elapsed: 0, warned: false };
  state.start = null;
  if (state.dest?.node === st.node) state.dest = null;
  updateModeBadge();
  syncSelects();
  toast(`${bikeId} 대여 완료 · 30분 이용할 수 있어요.`);
  closeStation();
  replan(true);
  renderRentCard();
}

function returnAt(sid) {
  const r = state.rental;
  if (!r || !returnBike(r.bikeId, sid)) return false;
  const used = Math.ceil(r.elapsed / 60);
  state.rental = null;
  updateModeBadge();
  syncSelects();
  toast(`${r.bikeId} 반납 완료 · ${used}분 이용`);
  renderRentCard();
  return true;
}

const scan = () => openScanner(tryRent);

function nearestReturnStation() {
  let best = null;
  for (const s of stations) {
    if (!hasFreeDock(s.id)) continue;
    const r = shortestPath(meNode(), s.node, 'bike');
    if (r && (!best || r.time < best.time)) best = { station: s, time: r.time };
  }
  return best;
}

function renderRentCard() {
  const card = $('#rentCard');
  const r = state.rental;
  if (!r) {
    setHTML(card, `<button class="btn primary big" data-act="scan">QR 스캔으로 대여</button>
      <div class="muted small" style="margin-top:6px">대여소 자전거의 QR 코드를 스캔하세요 · 1회 30분</div>`);
    return;
  }
  const here = stations.find((s) => s.node === meNode());
  const canReturnHere = here && hasFreeDock(here.id) && !state.nav;
  const near = nearestReturnStation();
  setHTML(card, `<div class="rent-title"><b>${r.bikeId}</b> 이용 중</div>
    <div class="rent-time"><b class="rent-left"></b> <span class="muted small">남음</span></div>
    <div class="bar"><i class="rent-bar"></i></div>
    ${canReturnHere ? `<button class="btn ok big" data-act="return" data-station="${here.id}">${here.name}에 반납</button>` : ''}
    ${near && !canReturnHere ? `<div class="small" style="margin-top:8px">가까운 반납 대여소: <b>${near.station.name}</b> (자전거 ${fmtTime(near.time)})</div>
      <button class="btn" data-act="go-return" data-station="${near.station.id}" style="margin-top:6px;width:100%">반납 대여소로 길찾기</button>` : ''}`);
  tickRentTimer();
}
$('#rentCard').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (t.dataset.act === 'scan') scan();
  if (t.dataset.act === 'return') {
    returnAt(t.dataset.station);
    replan();
  }
  if (t.dataset.act === 'go-return') {
    const s = stationById[t.dataset.station];
    setDest({ node: s.node, name: s.name }, true);
  }
});

function tickRentTimer() {
  const r = state.rental;
  const hud = $('#rentHud');
  hud.hidden = !r;
  if (!r) return;
  const left = remainingSec();
  const cls = left < 0 ? 'over' : left < 300 ? 'low' : '';
  const ratio = Math.max(0, left / RENTAL_LIMIT_SEC) * 100;
  hud.className = `rent-hud ${cls}`;
  hud.querySelector('.rent-hud-bike').textContent = r.bikeId;
  hud.querySelector('.rent-hud-time').textContent = left < 0 ? `초과 ${fmtMMSS(left)}` : `${fmtMMSS(left)} 남음`;
  hud.querySelector('.bar i').style.width = `${ratio}%`;
  const big = $('#rentCard .rent-left');
  if (big) {
    big.textContent = left < 0 ? `초과 ${fmtMMSS(left)}` : fmtMMSS(left);
    big.className = `rent-left ${cls}`;
    $('#rentCard .rent-bar').style.width = `${ratio}%`;
  }
  if (!r.warned && left < 300) {
    r.warned = true;
    toast('이용시간이 5분 남았습니다. 가까운 대여소에 반납해 주세요.');
  }
}

// ---------------- 대여소 카드 / 목록 ----------------
function openStation(sid) {
  state.station = sid;
  renderStation();
  mv.updateStations(sid);
}
function closeStation() {
  state.station = null;
  $('#stationCard').hidden = true;
  mv.updateStations(null);
}
function renderStation() {
  const sid = state.station;
  if (!sid) return;
  const s = stationById[sid];
  const list = dockedAt(sid);
  const here = meNode() === s.node && !state.nav;
  let action = '';
  if (state.rental && here && hasFreeDock(sid)) action = `<button class="btn ok" data-act="return">${state.rental.bikeId} 여기에 반납</button>`;
  else if (!state.rental && list.length) action = '<button class="btn primary" data-act="scan">QR 스캔 대여</button>';
  $('#stationCard').innerHTML = `<div class="station-title"><span>${s.name}</span>
      <button class="close" data-act="close" aria-label="닫기">×</button></div>
    <div class="small" style="margin-top:4px">대여 가능 <b>${list.length}대</b> · 거치대 ${s.capacity}칸</div>
    ${list.length ? `<div class="bike-chips">${list.map((b) => `<span class="bike-chip">${b.id} · ${Math.round(b.battery)}%</span>`).join('')}</div>` : ''}
    <div class="actions">${action}<button class="btn" data-act="route">길찾기</button><button class="btn" data-act="from">여기서 출발</button></div>`;
  $('#stationCard').hidden = false;
}
$('#stationCard').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const s = stationById[state.station];
  if (!act || !s) return;
  if (act === 'close') return closeStation();
  if (act === 'scan') return scan();
  if (act === 'return') {
    returnAt(s.id);
    replan();
  }
  if (act === 'route') setDest({ node: s.node, name: s.name }, true);
  if (act === 'from') {
    if (state.rental) return toast('대여 중에는 내 위치에서만 출발합니다.');
    pickStart({ node: s.node, name: s.name });
    syncSelects();
  }
  renderStation();
});

function renderStationList() {
  const rows = stations.map((s) => {
    const r = shortestPath(meNode(), s.node, 'walk');
    return { s, n: dockedAt(s.id).length, t: r ? r.time : Infinity };
  }).sort((a, b) => a.t - b.t);
  setHTML($('#stationList'), rows.map(({ s, n, t }) =>
    `<li data-station="${s.id}"><span><b>${s.name}</b><br><span class="muted small">도보 ${fmtTime(t)}</span></span>
      <span class="avail ${n ? '' : 'none'}">${n}대</span></li>`).join(''));
}
$('#stationList').addEventListener('click', (e) => {
  const sid = e.target.closest('[data-station]')?.dataset.station;
  if (!sid) return;
  openStation(sid);
  mv.focus(stationById[sid], 17.5);
});

// ---------------- 주변 버스 (실시간 도착정보) ----------------
const bus = { stops: null, mock: false, error: null, loading: false, selected: null, arrivals: {}, inflight: new Set() };
const ARRIVAL_REFRESH_MS = 30000;
const busStopById = (id) => bus.stops?.find((s) => s.id === id);

async function loadBusStops() {
  if (bus.stops || bus.loading) return;
  bus.loading = true;
  bus.error = null;
  renderBus();
  try {
    const d = await fetchStops();
    bus.stops = d.stops;
    bus.mock = d.mock;
    mv.setBusStops(bus.stops, (s) => selectBusStop(s.id, false));
    if (state.tab === 'bus' && bus.stops.length) mv.fitWith(bus.stops);
  } catch (e) {
    bus.error = e.message;
  }
  bus.loading = false;
  renderBus();
}

async function loadArrivals(id) {
  if (bus.inflight.has(id)) return;
  bus.inflight.add(id);
  try {
    const d = await fetchArrivals(id);
    bus.arrivals[id] = { list: d.arrivals, at: Date.now() };
    bus.mock = d.mock;
  } catch (e) {
    bus.arrivals[id] = { error: e.message, at: Date.now() };
  }
  bus.inflight.delete(id);
  renderBus();
}

// 목록에서 누르면 펼치기/접기, 지도에서 누르면 펼치기
function selectBusStop(id, fromList = true) {
  bus.selected = fromList && bus.selected === id ? null : id;
  mv.highlightBusStop(bus.selected);
  const s = busStopById(id);
  if (bus.selected) {
    loadArrivals(id);
    if (fromList) mv.focus(fromLatLng(s.lat, s.lon), 17.5);
  }
  renderBus();
}

// 정류장까지 도보 시간: 가장 가까운 길 지점까지 길찾기 + 그 지점에서 정류장까지 직선
function walkToBusStop(s) {
  const p = fromLatLng(s.lat, s.lon);
  const n = nearestNode(p.x, p.y);
  const r = shortestPath(meNode(), n.id, 'walk');
  return { node: n.id, time: (r ? r.time : Infinity) + dist(n, p) / SPEED.walk };
}

function arrivalsHtml(id) {
  const a = bus.arrivals[id];
  if (!a) return '<div class="muted small">도착 정보를 불러오는 중…</div>';
  if (a.error) return `<div class="hint warn">${a.error}</div>`;
  if (!a.list.length) return '<div class="muted small">도착 예정인 버스가 없습니다.</div>';
  const coming = a.list.filter((r) => r.buses.length);
  // 지금 다가오는 버스가 없는 노선(차고지 대기 등)은 한 줄로 모은다
  const idle = [...new Set(a.list.filter((r) => !r.buses.length).map((r) => r.routeName))];
  const rows = coming.map((r) => {
    const [first, second] = r.buses.map(fmtBus);
    const where = r.dest ? `${r.dest} 방면` : r.terminal ? '이 정류장 종점' : '';
    return `<div class="arr-row"><div><b>${r.routeName}</b>${where ? ` <span class="muted small">${where}</span>` : ''}</div>
      <div class="arr-times"><span class="soon">${first.when}</span> <span class="muted small">${first.extra}</span>
      ${second ? `<br><span class="small">${second.when}</span> <span class="muted small">${second.extra}</span>` : ''}</div></div>`;
  }).join('');
  const idleHtml = idle.length ? `<div class="muted small arr-idle">도착 정보 없음: ${idle.join(', ')}</div>` : '';
  const ago = Math.round((Date.now() - a.at) / 1000);
  return `${rows || '<div class="muted small">지금 다가오는 버스가 없습니다.</div>'}${idleHtml}<div class="muted small arr-foot">${ago < 5 ? '방금' : `${ago}초 전`} 갱신</div>`;
}

function renderBus() {
  let info = '<b>캠퍼스 주변 버스 정류장</b> · 실시간 도착정보 (경기도 버스정보)';
  if (bus.mock === 'offline') info += '<div class="hint warn">이 데모 버전에서는 예시 데이터를 보여줍니다. 실시간 도착정보는 버스 중계 서버와 함께 실행할 때 나옵니다.</div>';
  else if (bus.mock) info += '<div class="hint warn">버스 API 인증키가 설정되지 않아 예시 데이터를 보여줍니다.</div>';
  if (bus.error) info += `<div class="hint warn">${bus.error}</div>`;
  setHTML($('#busInfo'), info);
  if (bus.loading) return setHTML($('#busList'), '<li class="muted">정류장을 불러오는 중…</li>');
  if (!bus.stops) return setHTML($('#busList'), '');
  if (!bus.stops.length) return setHTML($('#busList'), '<li class="muted">주변 정류장을 찾지 못했습니다.</li>');
  const rows = bus.stops.map((s) => ({ s, w: walkToBusStop(s) })).sort((a, b) => a.w.time - b.w.time);
  setHTML($('#busList'), rows.map(({ s, w }) => {
    const open = bus.selected === s.id;
    return `<li class="bus-stop${open ? ' open' : ''}" data-bus-stop="${s.id}">
      <div class="bus-stop-head"><span><b>${s.name}</b>${s.mobileNo ? ` <span class="muted small">${s.mobileNo}</span>` : ''}</span>
        <span class="muted small">도보 ${fmtTime(w.time)}</span></div>
      ${open ? `<div class="arr">${arrivalsHtml(s.id)}
        <button class="btn small" data-bus-route="${s.id}">정류장까지 길찾기</button></div>` : ''}</li>`;
  }).join(''));
}
$('#busList').addEventListener('click', (e) => {
  const routeId = e.target.closest('[data-bus-route]')?.dataset.busRoute;
  if (routeId) {
    const s = busStopById(routeId);
    return setDest({ node: walkToBusStop(s).node, name: `${s.name} 정류장` }, true);
  }
  if (e.target.closest('.arr')) return;
  const id = e.target.closest('[data-bus-stop]')?.dataset.busStop;
  if (id) selectBusStop(id);
});

function refreshBus() {
  renderBus();
  const a = bus.arrivals[bus.selected];
  if (bus.selected && a && Date.now() - a.at > ARRIVAL_REFRESH_MS) loadArrivals(bus.selected);
}

// ---------------- 탭 ----------------
if (DEBUG) $('.tab[data-tab="sim"]').hidden = false;
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    state.tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const name of ['stations', 'bus', 'sim']) $(`#tab-${name}`).hidden = name !== state.tab;
    mv.showBus(state.tab === 'bus');
    if (state.tab === 'bus') loadBusStops();
    if (state.tab === 'stations') renderStationList();
  }));

// ---------------- 공통 UI ----------------
// 밝게/어둡게: 고르기 전에는 기기 설정을 따르고, 고르면 저장해 다음에도 유지
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
function updateThemeBtn() {
  const label = currentTheme() === 'dark' ? '밝은 화면으로' : '어두운 화면으로';
  $('#themeBtn').title = label;
  $('#themeBtn').setAttribute('aria-label', label);
}
$('#themeBtn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* 저장 못 해도 지금 화면에는 적용 */ }
  updateThemeBtn();
});
darkQuery.addEventListener('change', updateThemeBtn);
updateThemeBtn();

function updateModeBadge() {
  const b = $('#modeBadge');
  b.className = `badge ${state.rental ? 'bike' : 'walk'}`;
  b.textContent = state.rental ? '자전거 모드' : '도보 모드';
}

let toastTimer;
function toast(msg) {
  if (!msg) return;
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------- 시뮬레이션 이벤트 ----------------
const STATUS_LABEL = { docked: '거치', in_use: '이용 중', mine: '내 대여' };
let gpsCount = 0;
subscribe(({ type, message, at }) => {
  if (type === 'gps') {
    gpsCount++;
    return;
  }
  if (DEBUG) {
    const li = document.createElement('li');
    li.innerHTML = `<time>${at.toLocaleTimeString('ko-KR')}</time>${message}`;
    $('#log').prepend(li);
    while ($('#log').children.length > 80) $('#log').lastChild.remove();
  }
  // 대여소 재고가 바뀌면 경로(반납 대여소)와 카드도 갱신
  if (!state.nav) replan();
  renderStation();
});

function renderBikeTable() {
  $('#bikeRows').innerHTML = bikes.map((b) => {
    let where = stationById[b.station]?.name;
    if (b.status !== 'docked') {
      const [la, lo] = toLatLng(b.x, b.y);
      where = `${la.toFixed(5)}, ${lo.toFixed(5)}`;
    }
    return `<tr><td>${b.id}</td><td class="st ${b.status}">${STATUS_LABEL[b.status]}</td><td>${where}</td><td>${Math.round(b.battery)}%</td></tr>`;
  }).join('');
  $('#gpsCount').textContent = gpsCount;
}

// ---------------- 루프 ----------------
let last = performance.now();
let slowAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.nav && state.loc === 'demo') stepNavDemo(dt);
  if (state.rental) state.rental.elapsed += dt * (state.nav && state.loc === 'demo' ? TIME_SCALE : 1);
  mv.setMe(state.me, { riding: !!state.rental, accuracy: state.loc === 'gps' ? state.gpsAccuracy : 0 });
  mv.updateStations(state.station);
  tickRentTimer();
  renderNavHud();
  slowAcc += dt;
  if (slowAcc > 1) {
    slowAcc = 0;
    if (state.tab === 'stations') renderStationList();
    if (state.tab === 'bus') refreshBus();
    if (state.tab === 'sim') renderBikeTable();
    if (state.rental) renderRentCard();
  }
  requestAnimationFrame(frame);
}

// ---------------- 시작 ----------------
updateModeBadge();
syncSelects();
renderRouteInfo();
renderRentCard();
renderStationList();
startSim();
requestAnimationFrame(frame);

// QR을 휴대폰 기본 카메라로 찍으면 ?bike=B-001 로 열린다
const qrBike = params.get('bike');
if (qrBike) {
  history.replaceState(null, '', location.pathname + (DEBUG ? '?debug' : ''));
  setTimeout(() => {
    if (confirm(`${qrBike} 자전거를 대여할까요? (1회 30분)`)) tryRent(qrBike.toUpperCase());
  }, 300);
}
