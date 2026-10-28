// 수원대학교 캠퍼스 데이터 (OpenStreetMap 기반, tools/build_campus.py 로 생성한 campus.js 를 사용)
// 내부 좌표는 캠퍼스 중심 기준 미터(x: 동쪽 +, y: 남쪽 +). 지도 표시 때만 위경도로 바꾼다.
import campus from './campus.js';

export const CAMPUS = campus;
export const NODES = campus.nodes;
export const EDGES = campus.edges;       // { a, b, bike, kind: road|footway|steps, geom: [[x,y],...] }
export const BUILDINGS = campus.buildings; // { id, name, node, x, y }
export const STATIONS = campus.stations;   // { id, name, node, capacity }

const { lat, lon, kx, ky } = campus.origin;
export const toLatLng = (x, y) => [lat - y / ky, lon + x / kx];
export const fromLatLng = (la, lo) => ({ x: (lo - lon) * kx, y: (lat - la) * ky });

// 더미 자전거 초기 배치
export const INITIAL_BIKES = [
  ['B-001', 'S1'], ['B-002', 'S1'], ['B-003', 'S1'], ['B-004', 'S2'],
  ['B-005', 'S2'], ['B-006', 'S3'], ['B-007', 'S3'], ['B-008', 'S4'],
  ['B-009', 'S5'], ['B-010', 'S5'], ['B-011', 'S5'], ['B-012', 'S6'],
  ['B-013', 'S7'], ['B-014', 'S7'], ['B-015', 'S2'], ['B-016', 'S1'],
].map(([id, station]) => ({ id, station, battery: 60 + Math.floor(Math.random() * 40) }));

export const SPEED = { walk: 1.3, bike: 4.2 }; // m/s
// 계단은 도보로도 평지보다 느리다 (자전거는 통행 불가)
export const STEPS_PENALTY = 1.6;
