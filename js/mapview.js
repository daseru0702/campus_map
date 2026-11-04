/* global L */
// Leaflet 지도와 지도 위 표시 요소(경로, 대여소, 버스, 내 위치)
import { CAMPUS, BUILDINGS, toLatLng } from './data.js';
import { nodeById, routePoints } from './graph.js';
import { stations, dockedAt } from './sim.js';

const ll = (p) => toLatLng(p.x, p.y);
// 안내 중 지도를 직접 움직이면 이 시간 동안은 내 위치로 되돌아가지 않는다
const FREE_LOOK_MS = 3000;

export function createMap(el, handlers) {
  const map = L.map(el, { zoomControl: false, zoomSnap: 0.5 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const boundary = CAMPUS.boundary.map(([x, y]) => toLatLng(x, y));
  const campusBounds = L.latLngBounds(boundary);
  L.polygon(boundary, { className: 'campus-boundary', interactive: false }).addTo(map);
  const fitCampus = () => map.fitBounds(campusBounds, { padding: [12, 12] });
  fitCampus();
  // 레이아웃(그리드)이 확정된 뒤 크기를 다시 계산해야 처음 확대 수준이 맞는다
  requestAnimationFrame(() => {
    map.invalidateSize();
    fitCampus();
  });

  // 확대/축소, 캠퍼스 전체 보기, 내 위치 — 엄지로 누르기 쉬운 오른쪽 아래
  const Controls = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl');
      box.innerHTML = `
        <button data-z="in" aria-label="확대">＋</button>
        <button data-z="out" aria-label="축소">－</button>
        <button data-z="fit" aria-label="캠퍼스 전체 보기" title="캠퍼스 전체 보기">⤢</button>
        <button data-z="me" aria-label="내 위치로" title="내 위치 (GPS)">◎</button>`;
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener('click', (e) => {
        const z = e.target.closest('button')?.dataset.z;
        if (z !== 'me') touched();
        if (z === 'in') map.zoomIn();
        if (z === 'out') map.zoomOut();
        if (z === 'fit') fitCampus();
        if (z === 'me') handlers.onLocate();
      });
      return box;
    },
  });
  const controls = new Controls().addTo(map);
  const meBtn = controls.getContainer().querySelector('[data-z="me"]');

  // 사용자가 지도를 둘러보는 중인지 (끌기, 휠/핀치 확대, 더블클릭, 버튼)
  let lastTouch = 0;
  const touched = () => {
    lastTouch = Date.now();
  };
  const browsing = () => Date.now() - lastTouch < FREE_LOOK_MS;
  let wasFree = false;
  let glidingUntil = 0;
  map.on('dragstart drag', touched);
  el.addEventListener('wheel', touched, { passive: true });
  el.addEventListener('dblclick', touched);
  el.addEventListener('touchmove', (e) => e.touches.length > 1 && touched(), { passive: true });

  const routeLayer = L.layerGroup().addTo(map);
  const busLayer = L.layerGroup();

  // 건물(목적지)
  for (const b of BUILDINGS) {
    L.circleMarker(ll(b), { radius: 6, className: 'bld' })
      .bindTooltip(b.name, { direction: 'top', offset: [0, -6] })
      .on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        handlers.onBuilding(b);
      })
      .addTo(map);
  }

  // 대여소
  const stationMarkers = {};
  for (const s of stations) {
    stationMarkers[s.id] = L.marker(ll(s), {
      icon: L.divIcon({ className: 'stn-wrap', html: '<div class="stn"><b></b></div>', iconSize: [30, 30] }),
      zIndexOffset: 500,
    })
      .bindTooltip(s.name, { direction: 'top', offset: [0, -14] })
      .on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        handlers.onStation(s);
      })
      .addTo(map);
  }

  // 주변 버스 정류장 (버스 탭을 열었을 때만 표시)
  const busStopMarkers = {};

  // 내 위치
  const meAcc = L.circle(ll({ x: 0, y: 0 }), { radius: 0, className: 'me-acc', interactive: false }).addTo(map);
  const meHalo = L.circleMarker(ll({ x: 0, y: 0 }), { radius: 18, className: 'me-halo', interactive: false }).addTo(map);
  const meDot = L.circleMarker(ll({ x: 0, y: 0 }), { radius: 8, className: 'me', interactive: false }).addTo(map);

  map.on('click', (ev) => handlers.onMapClick(ev.latlng));

  return {
    map,
    fitCampus,
    invalidate: () => map.invalidateSize(),
    focus(p, zoom = 18) {
      lastTouch = 0;
      wasFree = false;
      meBtn.classList.remove('free');
      map.setView(ll(p), Math.max(map.getZoom(), zoom));
    },
    // 내 위치를 가운데에 두고 따라가기. 둘러보는 중이면 멈추고, 입력이 없으면 부드럽게 돌아온다
    follow(p) {
      const free = browsing();
      meBtn.classList.toggle('free', free);
      if (free) {
        wasFree = true;
        return;
      }
      if (wasFree) {
        wasFree = false;
        glidingUntil = Date.now() + 600;
        return map.panTo(ll(p), { duration: 0.5 });
      }
      if (Date.now() < glidingUntil) return;
      map.setView(ll(p), map.getZoom(), { animate: false });
    },
    stopFollow() {
      meBtn.classList.remove('free');
    },
    setLocating(on) {
      el.classList.toggle('locating', on);
    },

    drawRoute(plan, destNode) {
      routeLayer.clearLayers();
      if (!plan) return;
      for (const l of plan.legs) {
        const pts = routePoints(l).map(ll);
        L.polyline(pts, { className: 'r-casing', interactive: false }).addTo(routeLayer);
        L.polyline(pts, { className: l.mode === 'bike' ? 'r-bike' : 'r-walk', interactive: false }).addTo(routeLayer);
        // 보행로·계단 구간은 경로에 포함됐을 때만 따로 강조
        if (l.mode === 'walk') {
          for (const e of l.edges) {
            if (e.bike) continue;
            L.polyline(e.geom.map(([x, y]) => toLatLng(x, y)), {
              className: e.kind === 'steps' ? 'r-steps' : 'r-footway', interactive: false,
            }).addTo(routeLayer);
          }
        }
      }
      const end = plan.legs.at(-1)?.path.at(-1) ?? destNode;
      if (end) L.circleMarker(ll(nodeById[end]), { radius: 9, className: 'dest-pin', interactive: false }).addTo(routeLayer);
    },
    fitRoute(plan) {
      if (!plan?.legs.length) return;
      const pts = plan.legs.flatMap((l) => routePoints(l).map(ll));
      map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 18 });
    },

    updateStations(highlight) {
      for (const s of stations) {
        const box = stationMarkers[s.id].getElement()?.querySelector('.stn');
        if (!box) continue;
        const n = dockedAt(s.id).length;
        box.classList.toggle('empty', !n);
        box.classList.toggle('hl', s.id === highlight);
        box.firstChild.textContent = n;
      }
    },

    setMe(p, { riding, accuracy, visible = true }) {
      for (const m of [meDot, meHalo, meAcc]) m.setLatLng(ll(p));
      meAcc.setRadius(accuracy ?? 0);
      for (const m of [meDot, meHalo]) {
        m.getElement()?.classList.toggle('riding', !!riding);
        m.getElement()?.classList.toggle('hidden', !visible);
      }
    },

    showBus(on) {
      if (on) busLayer.addTo(map);
      else busLayer.remove();
    },
    setBusStops(stops, onClick) {
      busLayer.clearLayers();
      for (const s of stops) {
        busStopMarkers[s.id] = L.marker([s.lat, s.lon], {
          icon: L.divIcon({ className: 'stn-wrap', html: '<div class="busstop"></div>', iconSize: [18, 18] }),
          zIndexOffset: 700,
        })
          .bindTooltip(s.name, { direction: 'top', offset: [0, -10] })
          .on('click', (ev) => {
            L.DomEvent.stopPropagation(ev);
            onClick(s);
          })
          .addTo(busLayer);
      }
    },
    highlightBusStop(id) {
      for (const [sid, m] of Object.entries(busStopMarkers)) {
        m.getElement()?.querySelector('.busstop')?.classList.toggle('hl', sid === id);
      }
    },
    fitWith(points) {
      const b = L.latLngBounds(boundary);
      for (const p of points) b.extend([p.lat, p.lon]);
      map.fitBounds(b, { padding: [16, 16] });
    },
    controls,
  };
}
