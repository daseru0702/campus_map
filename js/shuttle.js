// 교내 셔틀버스 (학생 통학버스 운행 안내 2025학년도 2학기 + 팀원 현장 조사)
// 인문대 앞에서 출발해 한 바퀴 돌아 인문대 앞으로 돌아온다. 학기 중 평일만 운행 (방학·공휴일 없음).
//
// 정류장을 넣거나 빼려면 STOPS 의 줄만 추가·삭제(또는 주석 처리)하면 된다. 순서 = 도는 순서.
//  - min: 인문대 앞 출발 후 이 정류장에 오는 시간(분). 14:20 회차 실측
//  - lat, lon: 타는 위치 (지도 앱에서 확인한 핀 위치)
export const STOPS = [
  { id: 'humanities', name: '인문대 앞', min: 0, lat: 37.212911, lon: 126.978133 },
  { id: 'crossroad', name: '학생회관 사거리', min: 1, lat: 37.210021, lon: 126.977114 },
  // ICT 융합대학: 시간표에는 있지만 조사 때 정차하지 않음 (재확인 중). 정차하면 min·위치를 실제 값으로 바꾸고 주석을 푼다
  // { id: 'ict', name: 'ICT 융합대학', min: 2, lat: 37.2101, lon: 126.9750 },
  { id: 'music', name: '음악대학', min: 2, lat: 37.209876, lon: 126.972863 },
  { id: 'eng1', name: '제1공학관', min: 4, lat: 37.209027, lon: 126.979121 },
  { id: 'backgate', name: '후문 (제4공학관)', min: 5, lat: 37.206872, lon: 126.979869 },
  { id: 'art', name: '미술대학 (조형관)', min: 7, lat: 37.208476, lon: 126.976865 },
];
export const LOOP_MIN = 8; // 인문대 앞으로 돌아오기까지

// 인문대 앞 출발 시각
export const DEPARTURES = ['09:10', '09:20', '10:10', '10:20', '11:10', '11:20', '12:10', '13:20', '14:20', '15:20'];
export const SERVICE_DAYS = [1, 2, 3, 4, 5]; // 월~금

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const runsOn = (date) => SERVICE_DAYS.includes(date.getDay());

// 이 정류장에 오는 시각 전체: [{ at: 'HH:MM', min: 자정부터 분 }]
export const timesAt = (stop) => DEPARTURES.map((d) => toMin(d) + stop.min).map((min) => ({ at: fmt(min), min }));

// 지금부터 오는 셔틀 (운행하지 않는 날이면 빈 목록): [{ at, inMin }]
export function upcoming(stop, now = new Date(), count = 2) {
  if (!runsOn(now)) return [];
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return timesAt(stop).filter((t) => t.min >= Math.floor(nowMin))
    .slice(0, count).map((t) => ({ at: t.at, inMin: Math.max(0, Math.round(t.min - nowMin)) }));
}
