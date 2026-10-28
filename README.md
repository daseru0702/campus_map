# 수원대 캠퍼스 바이크

수원대학교 캠퍼스 내 공유자전거 서비스 + 지도 웹 프로토타입.
실제 자전거는 아직 연결하지 않았고, 더미 자전거의 대여·이동·반납이 지도와 현황표에 어떻게 반영되는지 보여준다.

## 주요 기능

- **대여 여부에 따른 경로 안내**
  - 미대여(도보 모드): 보행로·계단 등 도보 전용 지름길을 포함한 최적 경로. 자전거를 빌리는 게 빠르면 함께 안내
  - 대여 중(자전거 모드): 차도만 이용하는 자전거 경로 + 자전거·도보 합산 시간이 가장 짧은 반납 대여소 자동 선택 → 반납 후 도보 안내
- **더미 자전거 시뮬레이션**: 다른 이용자의 대여·주행·반납, 실시간 위치(GPS) 갱신, 대여소 재고 변화
- **실제 지도**: OpenStreetMap 타일 + OSM 길 데이터로 만든 경로 그래프

## 실행

ES 모듈을 쓰므로 정적 서버가 필요하다.

```bash
python -m http.server 5173
```

브라우저에서 http://localhost:5173 을 연다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `js/app.js` | 화면(Leaflet 지도, 패널, 안내 진행) |
| `js/router.js` | 대여 여부에 따른 도보/자전거 경로 결정 |
| `js/graph.js` | 경로 그래프, 다익스트라 |
| `js/sim.js` | 더미 자전거 시뮬레이터 — 실제 자전거 연동 시 서버(WebSocket 등) 수신으로 교체 |
| `js/data.js` | 캠퍼스 데이터 로드, 좌표 변환, 속도 설정, 초기 자전거 배치 |
| `js/campus.js` | 자동 생성된 캠퍼스 그래프 (직접 수정하지 않음) |
| `tools/build_campus.py` | OSM 원본 → `js/campus.js` 변환, 대여소 위치(`STATION_SPOTS`) 설정 |
| `data/` | OSM 원본 데이터와 Overpass 쿼리 |

## 캠퍼스 데이터 갱신

1. `data/overpass_query.txt`를 https://overpass-turbo.eu 에서 실행해 결과를 `data/osm_raw.json`으로 저장
2. `python tools/build_campus.py`

## 남은 과제

- 대여소 실제 위치 반영 (현재 임시 위치 7곳)
- 경사(고도) 반영 — OSM에는 높이 정보가 없음
- PWA 전환 (서비스 워커, 아이콘)
- 실제 자전거/서버 연동

## 라이선스 고지

지도 및 길 데이터 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
