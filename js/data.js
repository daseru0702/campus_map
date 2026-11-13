// 수원대학교 캠퍼스 데이터 (OpenStreetMap 기반, tools/build_campus.py 로 생성한 campus.js 를 사용)
// 내부 좌표는 캠퍼스 중심 기준 미터(x: 동쪽 +, y: 남쪽 +). 지도 표시 때만 위경도로 바꾼다.
import campus from './campus.js';

export const CAMPUS = campus;
export const NODES = campus.nodes;
export const EDGES = campus.edges;       // { a, b, bike, kind: road|footway|steps, geom: [[x,y],...] }
export const BUILDINGS = campus.buildings; // { id, name, node, exits: [nodeId], x, y } — exits: 건물 둘레의 출발/도착 후보 지점
export const STATIONS = campus.stations;   // { id, name, node, capacity }

const { lat, lon, kx, ky } = campus.origin;
export const toLatLng = (x, y) => [lat - y / ky, lon + x / kx];
export const fromLatLng = (la, lo) => ({ x: (lo - lon) * kx, y: (lat - la) * ky });

// 더미 자전거 초기 배치: 대여소마다 거치대의 절반 정도
let seq = 0;
export const INITIAL_BIKES = STATIONS.flatMap((st) =>
  Array.from({ length: Math.ceil(st.capacity / 2) }, () => ({
    id: `B-${String(++seq).padStart(3, '0')}`,
    station: st.id,
    battery: 60 + Math.floor(Math.random() * 40),
  })));

export const RENTAL_LIMIT_SEC = 30 * 60; // 1회 대여 시간 30분

// m/s, 평지 기준 (자전거는 캠퍼스 안 최고 속도로도 쓴다)
// 걷기: 2026-11-13 실측 — 정문 → ACE교육관(대운동장 서쪽 도로, 약 810m, 오르막 14m) 약 9분에 맞춤
export const SPEED = { walk: 1.55, bike: 4.2 };
// 계단은 도보로도 평지보다 느리다 (자전거는 통행 불가)
export const STEPS_PENALTY = 1.6;
// 계단 오르내리기: 한 칸 높이와 칸당 걸리는 시간(초)
export const STAIR = { rise: 0.16, up: 0.6, down: 0.5 };

// 경사 반영 (높이: 국토지리정보원 수치지도, tools/build_elevation.py)
// 걷기: 토블러 보행 함수를 평지 SPEED.walk 에 맞춘 것 — 살짝 내리막(-5%)이 가장 빠르고 오르막·급한 내리막은 느려진다
export const walkSpeed = (grade) => SPEED.walk * Math.exp(-3.5 * (Math.abs(grade + 0.05) - 0.05));

// 자전거: 오르막은 페달 힘(+전기 보조)으로 낼 수 있는 속도, 평지·내리막은 SPEED.bike 로 제한.
// 그 속도가 끌고 걷는 것보다 느리면 내려서 끌고 간다.
export const BIKE = {
  riderW: 100,  // 일반인이 편하게 내는 페달 힘 (W)
  assistW: 250, // 전기 보조 모터 힘 (W, 흔한 정격 출력). 일반 자전거면 0
  massKg: 95,   // 사람 + 자전거
  crr: 0.008,   // 구름 저항 계수
  cda: 0.5,     // 공기 저항 면적 (m²)
};
export function bikeSpeed(grade) {
  const { riderW, assistW, massKg, crr, cda } = BIKE;
  const theta = Math.atan(grade);
  const force = massKg * 9.81 * (Math.sin(theta) + crr * Math.cos(theta));
  const power = (v) => v * force + 0.6 * cda * v ** 3; // 0.6 = 공기 밀도의 절반
  // 낼 수 있는 힘으로 달릴 수 있는 속도를 이분법으로 찾는다 (최고 SPEED.bike)
  let lo = 0, hi = SPEED.bike;
  if (power(hi) <= riderW + assistW) lo = hi;
  else for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (power(mid) > riderW + assistW) hi = mid;
    else lo = mid;
  }
  return Math.max(lo, 0.85 * walkSpeed(grade));
}
