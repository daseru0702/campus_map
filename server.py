"""개발 서버: 정적 파일 + 경기도 버스정보(GBIS) API 중계.

사용법:  python server.py  (기본 포트 5173)

인증키는 브라우저에 노출되지 않도록 이 서버에서만 사용한다.
프로젝트 폴더의 .env 파일에  BUS_API_KEY=발급받은키  를 넣거나 환경변수로 지정한다.
(공공데이터포털의 "일반 인증키(Decoding)"를 권장. Encoding 키를 넣어도 자동으로 처리한다.)
키가 없으면 /api/bus/* 는 예시 데이터를 돌려준다 (응답의 mock: true).

API:
  GET /api/bus/stops                  캠퍼스 주변 정류장 목록
  GET /api/bus/arrivals?stationId=..  정류장 실시간 도착정보
"""
import json
import math
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get('PORT', 5173))
GBIS = 'https://apis.data.go.kr/6410000'

# 주변 정류장을 찾을 기준점 (위도, 경도) — 정문, 캠퍼스 중심, 서쪽·남쪽 진입로
SEARCH_POINTS = [
    (37.21381, 126.97982),  # 정문
    (37.20990, 126.97650),  # 캠퍼스 중심
    (37.21300, 126.97300),  # 서쪽 (와우로34번길)
    (37.20560, 126.97900),  # 남쪽
    (37.21150, 126.98150),  # 동쪽 (효행로 방면)
]
MAX_STOPS = 12
STOPS_TTL = 24 * 3600
ARRIVALS_TTL = 20


def load_key():
    key = os.environ.get('BUS_API_KEY', '').strip()
    env = ROOT / '.env'
    if not key and env.exists():
        for line in env.read_text(encoding='utf-8').splitlines():
            if line.strip().startswith('BUS_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('"\'')
    # Encoding 키(%2B 등 포함)를 넣었으면 원래 값으로 되돌린다 (요청 시 다시 인코딩함)
    return urllib.parse.unquote(key) if '%' in key else key


API_KEY = load_key()
_cache = {}
_lock = threading.Lock()


def cached(name, ttl, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(name)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _lock:
        _cache[name] = (now, value)
    return value


# ---------------- GBIS 호출 ----------------
def _xml_to_obj(el):
    children = list(el)
    if not children:
        return (el.text or '').strip()
    out = {}
    for c in children:
        v = _xml_to_obj(c)
        if c.tag in out:
            if not isinstance(out[c.tag], list):
                out[c.tag] = [out[c.tag]]
            out[c.tag].append(v)
        else:
            out[c.tag] = v
    return out


def gbis(path, **params):
    q = urllib.parse.urlencode({'serviceKey': API_KEY, 'format': 'json', **params})
    req = urllib.request.Request(f'{GBIS}/{path}?{q}', headers={'User-Agent': 'campus-bike'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode('utf-8', 'replace').strip()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise RuntimeError('인증키가 올바르지 않거나 아직 사용할 수 없습니다. '
                               '활용신청한 API인지, 발급 직후라면 1~2시간 뒤 다시 확인해 주세요.') from None
        raise
    if raw.startswith('<'):
        root = ET.fromstring(raw)
        data = {'response': _xml_to_obj(root)} if root.tag == 'response' else {root.tag: _xml_to_obj(root)}
    else:
        data = json.loads(raw)
    resp = data.get('response') or data.get('OpenAPI_ServiceResponse') or data
    header = resp.get('msgHeader') or resp.get('cmmMsgHeader') or {}
    code = str(header.get('resultCode', header.get('returnReasonCode', '0')))
    if code == '4':  # 결과 없음
        return {}
    if code != '0':
        raise RuntimeError(header.get('resultMessage') or header.get('returnAuthMsg') or header.get('errMsg') or f'API 오류 {code}')
    return resp.get('msgBody') or {}


def as_list(v):
    if v is None or v == '':
        return []
    return v if isinstance(v, list) else [v]


def dist_m(lat1, lon1, lat2, lon2):
    kx = 111320 * math.cos(math.radians(lat1))
    return math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540)


def fetch_stops():
    found = {}
    for lat, lon in SEARCH_POINTS:
        body = gbis('busstationservice/v2/getBusStationAroundListv2', x=lon, y=lat)
        for s in as_list(body.get('busStationAroundList')):
            sid = str(s.get('stationId'))
            if not sid or sid in found:
                continue
            slat, slon = float(s.get('y')), float(s.get('x'))
            found[sid] = {
                'id': sid,
                'name': s.get('stationName'),
                'mobileNo': str(s.get('mobileNo') or '').strip(),
                'lat': slat,
                'lon': slon,
                'region': s.get('regionName'),
                '_d': min(dist_m(slat, slon, a, b) for a, b in SEARCH_POINTS),
            }
    stops = sorted(found.values(), key=lambda s: s['_d'])[:MAX_STOPS]
    for s in stops:
        s.pop('_d')
    return stops


_route_names = {}


def route_name(route_id):
    if route_id in _route_names:
        return _route_names[route_id]
    try:
        item = gbis('busrouteservice/v2/getBusRouteInfoItemv2', routeId=route_id).get('busRouteInfoItem') or {}
        name = item.get('routeName') or route_id
    except Exception:
        name = route_id
    _route_names[route_id] = str(name)
    return _route_names[route_id]


def num(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


# 남은 좌석 수가 의미 있는 노선 유형 (직행좌석·좌석·광역급행 등). 일반 시내버스는 0 으로 온다
SEAT_ROUTE_TYPES = {11, 12, 14, 16, 21, 22}


def fetch_arrivals(station_id):
    body = gbis('busarrivalservice/v2/getBusArrivalListv2', stationId=station_id)
    out = []
    for a in as_list(body.get('busArrivalList')):
        rid = str(a.get('routeId'))
        seated = num(a.get('routeTypeCd')) in SEAT_ROUTE_TYPES

        def seats(i):
            n = num(a.get(f'remainSeatCnt{i}'))
            return n if seated and n is not None and n >= 0 else None

        out.append({
            'routeId': rid,
            'routeName': str(a.get('routeName') or route_name(rid)),
            # 이 정류장이 종점(회차)인 노선은 행선지가 정류장 자신으로 온다
            'dest': '' if str(a.get('routeDestId')) == str(station_id) else (a.get('routeDestName') or ''),
            'terminal': str(a.get('routeDestId')) == str(station_id),
            'buses': [b for b in (
                {'min': num(a.get(f'predictTime{i}')), 'stops': num(a.get(f'locationNo{i}')),
                 'seats': seats(i), 'lowFloor': str(a.get(f'lowPlate{i}')) == '1'}
                for i in (1, 2)) if b['min'] is not None],
        })
    out.sort(key=lambda r: (r['buses'][0]['min'] if r['buses'] else 999))
    return out


# ---------------- 예시 데이터 (인증키 없을 때) ----------------
MOCK_STOPS = [
    {'id': 'mock-1', 'name': '수원대학교 정문 (예시)', 'mobileNo': '', 'lat': 37.21405, 'lon': 126.97955, 'region': '화성'},
    {'id': 'mock-2', 'name': '수원대학교 정문 건너편 (예시)', 'mobileNo': '', 'lat': 37.21420, 'lon': 126.98000, 'region': '화성'},
    {'id': 'mock-3', 'name': '와우리 입구 (예시)', 'mobileNo': '', 'lat': 37.21330, 'lon': 126.97330, 'region': '화성'},
]
MOCK_ROUTES = [('예시1', '수원역'), ('예시2', '병점역'), ('예시3', '봉담읍'), ('예시4', '사당역')]


def mock_arrivals(station_id):
    rnd = random.Random(f'{station_id}-{int(time.time() // 60)}')
    out = []
    for name, dest in rnd.sample(MOCK_ROUTES, 3):
        first = rnd.randint(1, 15)
        out.append({'routeId': name, 'routeName': name, 'dest': dest, 'buses': [
            {'min': first, 'stops': max(1, first // 2), 'seats': rnd.choice([None, rnd.randint(0, 40)]), 'lowFloor': rnd.random() < .4},
            {'min': first + rnd.randint(8, 20), 'stops': first // 2 + 5, 'seats': None, 'lowFloor': False},
        ]})
    return sorted(out, key=lambda r: r['buses'][0]['min'])


# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # 개발 중에는 수정한 JS/CSS 가 바로 반영되도록
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith('/api/'):
            return super().do_GET()
        q = urllib.parse.parse_qs(url.query)
        try:
            if url.path == '/api/bus/stops':
                if not API_KEY:
                    return self.send_json({'mock': True, 'stops': MOCK_STOPS})
                return self.send_json({'mock': False, 'stops': cached('stops', STOPS_TTL, fetch_stops)})
            if url.path == '/api/bus/arrivals':
                sid = (q.get('stationId') or [''])[0]
                if not sid:
                    return self.send_json({'error': 'stationId 가 필요합니다.'}, 400)
                if not API_KEY:
                    return self.send_json({'mock': True, 'arrivals': mock_arrivals(sid), 'at': int(time.time())})
                arr = cached(f'arr:{sid}', ARRIVALS_TTL, lambda: fetch_arrivals(sid))
                return self.send_json({'mock': False, 'arrivals': arr, 'at': int(time.time())})
            return self.send_json({'error': 'not found'}, 404)
        except Exception as e:  # API 장애·키 오류 등은 화면에 그대로 알린다
            self.log_error('bus api: %s', e)
            return self.send_json({'error': f'버스 정보를 가져오지 못했습니다: {e}'}, 502)


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    print(f'http://localhost:{PORT}  (버스 API: {"인증키 사용" if API_KEY else "인증키 없음 → 예시 데이터"})')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
