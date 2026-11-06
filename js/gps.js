// 휴대폰 GPS(브라우저 Geolocation API) 래퍼.
// HTTPS 또는 localhost 에서만 동작하며, 사용자가 위치 권한을 허용해야 한다.
//
// 휴대폰 GPS 는 건물 사이에서 수십 m 씩 튄다. 그래서 받은 값을 그대로 쓰지 않고
//  1) 너무 부정확한 값(MAX_ACCURACY 초과)은 버리고
//  2) 사람이 낼 수 없는 속도로 튄 값은 버리고 (연속으로 계속 오면 실제 이동으로 보고 받아들임)
//  3) 칼만 필터로 정확도(accuracy)에 따라 가중 평균해 부드럽게 만든다.

export const gpsSupported = () => 'geolocation' in navigator;

const MAX_ACCURACY = 80;   // m, 이보다 부정확한 값은 첫 위치를 잡은 뒤에는 버림
const MAX_SPEED = 12;      // m/s, 자전거로도 넘기 어려운 속도 → 순간 튐으로 판단
const MAX_REJECTS = 3;     // 연속으로 이만큼 튀면 실제로 이동한 것으로 보고 다시 맞춤

const R = 6371000;
const meters = (a, b) => {
  const dy = (b.lat - a.lat) * Math.PI / 180 * R;
  const dx = (b.lng - a.lng) * Math.PI / 180 * R * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
};

// 위경도 칼만 필터. q: 예상 이동 속도(m/s) — 클수록 새 값을 빨리 따라간다
export function createGpsFilter() {
  let s = null; // { lat, lng, variance, t }
  let rejects = 0;
  return {
    reset() { s = null; rejects = 0; },
    // fix: { lat, lng, accuracy, t }, q: m/s → 걸러진 { lat, lng, accuracy } 또는 null(버림)
    update(fix, q) {
      const acc = Math.max(fix.accuracy, 3);
      // 처음이거나, 새 값이 지금 추정치보다 훨씬 정확하면(기지국 → 위성) 그 값으로 바로 맞춤
      if (!s || acc * 3 < Math.sqrt(s.variance)) {
        rejects = 0;
        s = { lat: fix.lat, lng: fix.lng, variance: acc * acc, t: fix.t };
        return { lat: s.lat, lng: s.lng, accuracy: acc };
      }
      const dt = Math.max(0, (fix.t - s.t) / 1000);
      const jump = meters(s, fix);
      const tooCoarse = acc > MAX_ACCURACY && acc * acc > s.variance;
      // 지금 추정치 자체가 부정확하면(기지국 위치 등) 그만큼은 튐이 아니라 보정으로 본다
      const tooFast = jump - acc - Math.sqrt(s.variance) > MAX_SPEED * Math.max(dt, 1);
      if (tooCoarse || tooFast) {
        if (++rejects < MAX_REJECTS) return null;
        s = null; // 계속 튀면 필터를 새로 시작
        rejects = 0;
        return this.update(fix, q);
      }
      rejects = 0;
      s.variance += dt * q * q;
      const k = s.variance / (s.variance + acc * acc);
      s.lat += k * (fix.lat - s.lat);
      s.lng += k * (fix.lng - s.lng);
      s.variance *= 1 - k;
      s.t = fix.t;
      return { lat: s.lat, lng: s.lng, accuracy: Math.sqrt(s.variance) };
    },
  };
}

// onPos({ lat, lng, accuracy, raw }), onError('unsupported' | 'denied' | 'unavailable' | 'timeout')
// getSpeed(): 지금 예상 이동 속도(m/s) — 걷기/자전거에 따라 필터 반응 속도를 바꾼다
// 반환값: 추적 중지 함수
export function watchGps(onPos, onError, getSpeed = () => 2) {
  if (!gpsSupported()) {
    onError('unsupported');
    return () => {};
  }
  const filter = createGpsFilter();
  let gotFix = false;
  const id = navigator.geolocation.watchPosition(
    (p) => {
      gotFix = true;
      const raw = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, t: p.timestamp || Date.now() };
      const f = filter.update(raw, getSpeed());
      if (f) onPos({ ...f, raw });
    },
    (e) => {
      // 추적 중 잠깐 신호가 끊기는 시간 초과는 무시하고 다음 값을 기다린다
      if (e.code === 3 && gotFix) return;
      onError(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable');
    },
    // maximumAge 0: 캐시된 옛 위치 대신 항상 새로 측정
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export const GPS_ERROR_TEXT = {
  unsupported: '이 브라우저는 위치 기능을 지원하지 않습니다.',
  denied: '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.',
  unavailable: '현재 위치를 확인할 수 없습니다.',
  timeout: '위치 확인 시간이 초과되었습니다.',
};
