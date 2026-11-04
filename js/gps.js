// 휴대폰 GPS(브라우저 Geolocation API) 래퍼.
// HTTPS 또는 localhost 에서만 동작하며, 사용자가 위치 권한을 허용해야 한다.

export const gpsSupported = () => 'geolocation' in navigator;

// onPos({ lat, lng, accuracy }), onError('unsupported' | 'denied' | 'unavailable' | 'timeout')
// 반환값: 추적 중지 함수
export function watchGps(onPos, onError) {
  if (!gpsSupported()) {
    onError('unsupported');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (e) => onError(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export const GPS_ERROR_TEXT = {
  unsupported: '이 브라우저는 위치 기능을 지원하지 않습니다.',
  denied: '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.',
  unavailable: '현재 위치를 확인할 수 없습니다.',
  timeout: '위치 확인 시간이 초과되었습니다.',
};
