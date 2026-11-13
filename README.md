# 수원대 캠퍼스 바이크

수원대학교 캠퍼스 내 공유자전거 서비스 + 지도 웹 프로토타입.
실제 자전거는 아직 연결하지 않았고, 더미 자전거로 대여·이동·반납 흐름을 보여준다.

## 주요 기능

- **대여 여부에 따른 경로 안내**
  - 미대여(도보 모드): 보행로·계단 등 도보 전용 지름길을 포함한 최적 경로. 자전거를 빌리는 게 빠르면 함께 안내
  - 대여 중(자전거 모드): 차도만 이용하는 자전거 경로 + 가장 유리한 반납 대여소 자동 선택 → 반납 후 도보 안내
  - 보행로·계단은 평소에는 숨기고, 경로에 포함될 때만 지도에 표시
- **출발/도착 선택**: 내 위치, 건물, 대여소, 지도에서 직접 고른 지점 중 선택 · 출발/도착 바꾸기
- **QR 대여**: 자전거의 QR을 앱에서 스캔하거나(카메라를 못 쓰면 번호 입력) 휴대폰 기본 카메라로 찍어서 대여
- **이용 시간 30분**: 대여 중에는 남은 시간을 지도 위와 패널에 표시, 5분 남으면 알림, 초과 시 초과 시간 표시
- **안내 화면**: 안내 시작 시 지도·경로·남은 거리/시간만 보이는 화면으로 전환
- **실제 GPS**: 지도 오른쪽 아래 ◎ 버튼. 캠퍼스 안이면 실제 위치로 안내하고, 경로를 벗어나면 다시 탐색. 캠퍼스 밖이면 데모 위치 사용
- **대여소 14곳** (임시 위치)
- **버스 탭**: 캠퍼스 주변 버스 정류장과 실시간 도착정보(경기도 버스정보), 정류장까지 길찾기

## 실행

정적 파일과 버스 API 중계를 함께 하는 개발 서버를 띄운다 (Python 3, 추가 설치 없음).

```bash
python server.py
```

- 앱: http://localhost:5173
- 자전거 QR 코드 모음(테스트·인쇄용): http://localhost:5173/qr.html
- 개발용 시뮬레이션 탭(더미 자전거 전체 현황·이벤트 로그): http://localhost:5173/?debug

GPS와 카메라는 브라우저 보안 정책상 **HTTPS 또는 localhost** 에서만 동작한다. 휴대폰으로 테스트하려면 배포 주소(아래 [배포](#배포))를 쓴다.

## 버스 정보 설정

1. [공공데이터포털](https://www.data.go.kr)에서 경기도 버스 API 3종을 활용신청한다: **정류소 조회**, **버스도착정보 조회**, **버스노선 조회**
2. `.env.example`을 `.env`로 복사하고 `BUS_API_KEY=`에 **일반 인증키** 를 넣는다 (`.env`는 git에 올라가지 않는다)
3. `python server.py`를 다시 실행한다

인증키가 없으면 예시 데이터가 표시된다. 발급 직후에는 키가 활성화될 때까지 1~2시간 걸릴 수 있다.
주변 정류장은 `server.py`(와 `relay/worker.js`)의 `SEARCH_POINTS` 기준점 주변에서 찾는다.

## 배포

| 주소 | 브랜치 | 용도 | 버스 중계 |
| --- | --- | --- | --- |
| https://campus-map.daseru.workers.dev | `main` | 공개용 (Cloudflare Workers) | 같은 주소의 `/api/bus/*` (`relay/worker.js`) |
| https://daseru0702.github.io/campus_map/ | `beta` | 베타 테스트용 (GitHub Pages, 제목 옆 BETA 표시) | 공개용 주소의 중계를 빌려 씀 (`js/bus.js`의 `RELAY_URL`) |

둘 다 GitHub 저장소와 연결되어 있어 push하면 자동으로 다시 배포된다.

1. 작업은 `beta`에 push → 베타 사이트에서 확인
2. 공개할 때 `beta`를 `main`에 합쳐 push → 공개 사이트에 반영

버스 중계(`relay/worker.js`)는 공개용 주소에서만 돌아가므로, 이 파일을 바꾼 경우는 `main`에 올려야 확인할 수 있다.

### Cloudflare (공개용)

- 설정: 저장소 루트의 `wrangler.jsonc` — 정적 파일(앱 화면)과 `relay/worker.js`(버스 중계)를 한 Worker로 배포
- 공개하지 않을 파일(서버·도구·원본 데이터·문서)은 `.assetsignore`에 적는다
- **인증키**: Cloudflare 대시보드 → Workers & Pages → `campus-map` → Settings → Variables and Secrets 에 **Secret** `BUS_API_KEY`로 등록 (git에 올리지 않는다)
- 다른 주소에서 버스 API를 부르려면 `wrangler.jsonc`의 `ALLOWED_ORIGINS`에 추가한다
- 로컬에서 Cloudflare 배포 형태로 시험: 루트에 `.dev.vars`(`BUS_API_KEY=...`)를 두고 `npx wrangler dev`

중계 서버에 닿지 못하면 앱은 예시 데이터로 대신한다.

## 위치 기준

- **데모 위치**(기본): 가상 위치. 안내를 시작하면 경로를 따라 8배속으로 자동 이동하고, QR로 대여하면 해당 대여소로 이동한 것으로 본다.
- **GPS**: 휴대폰 실제 위치. 대여는 대여소 60m 이내에서만 가능하고, 반납 대여소 30m 이내에서 "여기에 반납" 버튼이 나타난다.
  - 켜자마자 오는 부정확한 위치(기지국·와이파이)는 건너뛰고, 오차 40m 이내 값을 최대 10초 기다린다
  - 오차 80m 넘는 값, 사람이 낼 수 없는 속도로 튄 값은 버리고, 칼만 필터로 부드럽게 만든다 (`js/gps.js`)
  - 안내 중에는 내 위치를 경로선에 붙여 표시하고, 경로 밖 위치가 3번 연속 나와야 다시 탐색한다
  - 상단 칩에 현재 오차(`GPS ±12m`)를 표시한다

## 구조

| 파일 | 역할 |
| --- | --- |
| `js/app.js` | 화면 상태, 출발/도착, 안내 진행, 대여/반납, 탭 |
| `js/mapview.js` | Leaflet 지도와 지도 위 요소(경로, 대여소, 버스, 내 위치, 확대 버튼) |
| `js/router.js` | 대여 여부에 따른 도보/자전거 경로 결정 |
| `js/graph.js` | 경로 그래프, 다익스트라 |
| `js/sim.js` | 더미 자전거 시뮬레이터 — 실제 자전거 연동 시 서버(WebSocket 등) 수신으로 교체 |
| `js/gps.js` | 휴대폰 GPS(Geolocation API) |
| `js/qr.js` | QR 스캔 모달 |
| `js/bus.js` | 주변 버스 정류장·도착정보 요청 |
| `server.py` | 개발 서버 + 버스 API 중계(인증키 보관, 캐시) |
| `relay/worker.js` | 공개 사이트의 버스 API 중계 (Cloudflare Worker, `server.py`의 `/api/bus/*`와 같은 응답) |
| `wrangler.jsonc`, `.assetsignore` | Cloudflare 배포 설정, 공개하지 않을 파일 목록 |
| `js/data.js` | 캠퍼스 데이터 로드, 좌표 변환, 속도·대여 시간 설정, 초기 자전거 배치 |
| `js/campus.js` | 자동 생성된 캠퍼스 그래프 (직접 수정하지 않음) |
| `tools/build_campus.py` | OSM 원본 → `js/campus.js` 변환, 대여소(`STATION_SPOTS`) 위치 설정 |
| `data/` | OSM 원본 데이터와 Overpass 쿼리 |
| `qr.html` | 자전거별 QR 코드 모음 |

## 캠퍼스 데이터 갱신

1. `data/overpass_query.txt`를 https://overpass-turbo.eu 에서 실행해 결과를 `data/osm_raw.json`으로 저장
2. `python tools/build_campus.py`

## 남은 과제

- 대여소 실제 위치 반영 (현재 임시)
- 교내 셔틀 정보 (확보 시 추가)
- 경사(고도) 반영 — OSM에는 높이 정보가 없음
- PWA 전환 (서비스 워커, 아이콘)
- 실제 자전거/서버 연동 (자전거 위치·잠금 장치)

## 라이선스 고지

지도 및 길 데이터 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
