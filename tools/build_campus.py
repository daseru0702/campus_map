"""OpenStreetMap 원본(data/osm_raw.json) → 앱용 경로 그래프(js/campus.js) 변환.

사용법:  python tools/build_campus.py
원본 갱신: data/overpass_query.txt 를 https://overpass-turbo.eu 에서 실행해 data/osm_raw.json 으로 저장

- 좌표는 캠퍼스 중심 기준 미터(x: 동쪽 +, y: 남쪽 +)로 변환한다. 화면 표시 때 다시 위경도로 바꾼다.
- 교차점/막다른 길/건물·대여소 연결점만 그래프 노드로 남기고, 그 사이 굽은 길은 간선의 geom 으로 보존한다.
- data/elevation.json(tools/build_elevation.py)이 있으면 노드 높이(z)와 간선 높이 단면(z)을 넣는다.
"""
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'osm_raw.json'
ELEVATION = ROOT / 'data' / 'elevation.json'
OUT = ROOT / 'js' / 'campus.js'

CAMPUS_WAY_ID = 311203886  # amenity=university, 수원대학교
CAMPUS_BUFFER_M = 60       # 캠퍼스 경계 밖으로 이만큼까지 길을 포함 (정문 앞 도로 등)
GATE = {'name': '정문', 'lat': 37.2138074, 'lon': 126.9798181}  # OSM node 11453333130

# 대여소를 둘 건물 (가장 가까운 자전거 통행 가능 지점에 배치)
STATION_SPOTS = [
    ('S1', '정문 대여소', '정문', 10),
    ('S2', '중앙도서관 대여소', '중앙도서관', 8),
    ('S3', '학생회관 대여소', '학생회관', 8),
    ('S4', '대학본부 대여소', '대학본부', 6),
    ('S5', '고운기숙사 대여소', '고운기숙사 A동', 10),
    ('S6', '미래혁신관 대여소', '미래혁신관', 6),
    ('S7', '체육대학 대여소', '체육대학', 6),
    ('S8', '인문사회융합대학 대여소', '인문사회융합대학', 6),
    ('S9', '제1공학관 대여소', '제 1공학관', 6),
    ('S10', '제4공학관 대여소', '제 4공학관', 6),
    ('S11', '디자인앤아트대학 대여소', '디자인앤아트대학', 6),
    ('S12', '음악테크놀로지대학 대여소', '음악테크놀로지대학', 6),
    ('S13', '라이프케어사이언스대학 대여소', '라이프케어사이언스대학', 6),
    ('S14', '경영공학대학 대여소', '경영공학대학', 6),
]


# 건물 출입 지점 (출발/도착 후보)
#  1) 출입구 선: 건물 벽에 닿아 끝나는 길(막다른 끝) 또는 건물 안을 지나는 길의 지점 — 전부 쓴다
#  2) 출입구 선이 1개 이하인 건물은 외곽 EXIT_RADIUS_M 안의 길 지점으로 보충한다
ENTRANCE_TOUCH_M = 8   # 막다른 끝이 건물 외곽에서 이 거리 안이면 출입구 선으로 본다
ENTRANCE_MERGE_M = 6   # 출입구 지점끼리 이보다 가까우면 하나로 본다
EXIT_RADIUS_M = 20
EXIT_SPACING_M = 25    # 보충 후보끼리 이보다 가까우면 하나만 남긴다
MAX_EXITS = 4          # 보충할 때의 최대 개수

# 길로 쓰지 않을 구역 (위경도 다각형): 안에 든 보행로·계단은 그래프에서 뺀다 (차도는 남긴다)
#  - 대운동장: 둘레 보행로는 길이 아니라 트랙에 가깝고, 체대 수업 전 몸풀기·축제 준비로 붐빈다.
#    북쪽 길(미래혁신관 방향)과 서쪽 도로는 구역 밖
EXCLUDE_AREAS = {
    '대운동장': [(37.211645, 126.977651), (37.211645, 126.978751), (37.211415, 126.978941), (37.210207, 126.978941),
                 (37.209935, 126.978372), (37.209935, 126.977765), (37.210509, 126.977537)],
}

# 되도록 지나가지 않을 구역 (위경도 다각형). 길이의 절반 이상이 안에 있는 간선에 avoid 를 붙인다
AVOID_AREAS = {}
AVOID_SHARE = 0.5

# 간선 높이 단면: 길을 이 길이 안팎의 같은 구간으로 나눠 구간 끝마다 높이를 적는다
PROFILE_STEP_M = 15

WALK_ONLY = {'footway', 'steps', 'path', 'pedestrian', 'corridor', 'elevator'}
EXCLUDE = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed'}


def load_elevation():
    """(lat, lon) → 높이(m) 함수. 높이 격자가 없으면 None"""
    if not ELEVATION.exists():
        return None
    g = json.loads(ELEVATION.read_text(encoding='utf-8'))
    rows, cols, z = g['rows'], g['cols'], g['z']

    def height(lat, lon):  # 격자 4칸 사이 이중선형 보간
        r = min(max((g['north'] - lat) / g['dlat'], 0), rows - 1.001)
        c = min(max((lon - g['west']) / g['dlon'], 0), cols - 1.001)
        r0, c0 = int(r), int(c)
        fr, fc = r - r0, c - c0
        at = lambda i, j: z[i * cols + j]
        top = at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc
        bottom = at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc
        return top * (1 - fr) + bottom * fr
    return height


def main():
    elements = json.loads(RAW.read_text(encoding='utf-8'))['elements']
    campus = next(e for e in elements if e['type'] == 'way' and e['id'] == CAMPUS_WAY_ID)
    lat0 = sum(p['lat'] for p in campus['geometry']) / len(campus['geometry'])
    lon0 = sum(p['lon'] for p in campus['geometry']) / len(campus['geometry'])
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110540

    def proj(lat, lon):
        return ((lon - lon0) * kx, (lat0 - lat) * ky)

    poly = [proj(p['lat'], p['lon']) for p in campus['geometry']]

    def inside(pt, ring=poly):
        x, y = pt
        c = False
        for i in range(len(ring)):
            (x1, y1), (x2, y2) = ring[i - 1], ring[i]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    def seg_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = 0 if dx == dy == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

    def near_campus(pt):
        return inside(pt) or min(seg_dist(pt, poly[i - 1], poly[i]) for i in range(len(poly))) <= CAMPUS_BUFFER_M

    excluded = [[proj(la, lo) for la, lo in ring] for ring in EXCLUDE_AREAS.values()]

    # ---- 원시 그래프 (OSM 노드 단위) ----
    pos = {}
    raw_edges = []  # (u, v, bike, kind)
    for e in elements:
        t = e.get('tags', {})
        hw = t.get('highway')
        if e['type'] != 'way' or not hw or hw in EXCLUDE or t.get('access') in ('private', 'no') and t.get('foot') not in ('yes', 'designated'):
            continue
        if t.get('foot') == 'no':
            continue
        bike = hw not in WALK_ONLY or t.get('bicycle') in ('yes', 'designated')
        if t.get('bicycle') in ('no', 'dismount'):
            bike = False
        kind = 'steps' if hw == 'steps' else ('road' if bike else 'footway')
        ids = e['nodes']
        for nid, g in zip(ids, e['geometry']):
            pos[nid] = proj(g['lat'], g['lon'])
        for u, v in zip(ids, ids[1:]):
            mid = ((pos[u][0] + pos[v][0]) / 2, (pos[u][1] + pos[v][1]) / 2)
            if kind != 'road' and any(inside(mid, ring) for ring in excluded):
                continue
            if near_campus(pos[u]) and near_campus(pos[v]):
                raw_edges.append((u, v, bike, kind))

    adj = defaultdict(list)
    for i, (u, v, *_ ) in enumerate(raw_edges):
        adj[u].append((v, i))
        adj[v].append((u, i))

    # 가장 큰 연결 요소만 사용
    seen, best = set(), set()
    for start in adj:
        if start in seen:
            continue
        comp, stack = {start}, [start]
        while stack:
            for w, _ in adj[stack.pop()]:
                if w not in comp:
                    comp.add(w)
                    stack.append(w)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    raw_edges = [ed for ed in raw_edges if ed[0] in best]
    adj = defaultdict(list)
    for i, (u, v, *_ ) in enumerate(raw_edges):
        adj[u].append((v, i))
        adj[v].append((u, i))
    bike_nodes = {n for u, v, b, _ in raw_edges if b for n in (u, v)}

    def nearest(pt, pool):
        return min(pool, key=lambda n: math.hypot(pos[n][0] - pt[0], pos[n][1] - pt[1]))

    # ---- 목적지(건물) ----
    buildings = []
    for e in elements:
        t = e.get('tags', {})
        if e['type'] != 'way' or 'building' not in t or not t.get('name'):
            continue
        pts = [proj(g['lat'], g['lon']) for g in e['geometry']]
        c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        if not inside(c):
            continue
        buildings.append({'name': t['name'], 'x': c[0], 'y': c[1], '_ring': pts})
    buildings.append({'name': GATE['name'], 'x': proj(GATE['lat'], GATE['lon'])[0], 'y': proj(GATE['lat'], GATE['lon'])[1]})

    def ring_dist(pt, ring):
        if inside(pt, ring):
            return 0
        return min(seg_dist(pt, ring[i - 1], ring[i]) for i in range(len(ring)))

    def far_from(n, chosen, gap):
        return all(math.hypot(pos[n][0] - pos[m][0], pos[n][1] - pos[m][1]) >= gap for m in chosen)

    def exits_of(b):
        ring = b.get('_ring')
        if not ring:
            return [b['node']]
        cand = sorted((ring_dist(pos[n], ring), n) for n in adj)
        entrances = []
        for d, n in cand:
            if d > ENTRANCE_TOUCH_M:
                break
            if (d == 0 or len(adj[n]) == 1) and far_from(n, entrances, ENTRANCE_MERGE_M):
                entrances.append(n)
        if len(entrances) >= 2:
            return entrances
        # 출입구 선이 부족하면 건물 둘레의 길 지점으로 보충 (가까운 순, 서로 떨어진 것만)
        out = entrances + ([b['node']] if b['node'] not in entrances else [])
        for d, n in cand:
            if d > EXIT_RADIUS_M or len(out) >= MAX_EXITS:
                break
            if far_from(n, out, EXIT_SPACING_M):
                out.append(n)
        return out

    keep = set()
    for i, b in enumerate(buildings):
        b['id'] = f'd{i}'
        b['node'] = nearest((b['x'], b['y']), adj.keys())
        b['exits'] = exits_of(b)
        b.pop('_ring', None)
        keep.update(b['exits'])

    stations = []
    by_name = {b['name']: b for b in buildings}
    for sid, name, near, cap in STATION_SPOTS:
        b = by_name[near]
        n = nearest((b['x'], b['y']), bike_nodes)
        if any(s['node'] == n for s in stations):
            raise SystemExit(f'{name}: 다른 대여소와 같은 지점에 배치됨 — STATION_SPOTS 를 조정하세요')
        keep.add(n)
        stations.append({'id': sid, 'name': name, 'node': n, 'capacity': cap})

    # ---- 그래프 단순화: 차수 2 이고 양쪽 간선 성격이 같은 노드는 접는다 ----
    def is_key(n):
        if n in keep or len(adj[n]) != 2:
            return True
        (_, i1), (_, i2) = adj[n]
        return raw_edges[i1][2:] != raw_edges[i2][2:]

    used = set()
    edges = []
    for n in list(adj):
        if not is_key(n):
            continue
        for w, i in adj[n]:
            if i in used:
                continue
            used.add(i)
            chain = [n, w]
            bike, kind = raw_edges[i][2:]
            prev, cur = n, w
            while not is_key(cur):
                nxt = [(x, j) for x, j in adj[cur] if j not in used][0]
                used.add(nxt[1])
                prev, cur = cur, nxt[0]
                chain.append(cur)
            if chain[0] == chain[-1] and len(chain) <= 2:
                continue
            edges.append({'a': chain[0], 'b': chain[-1], 'bike': bike, 'kind': kind,
                          'geom': [[round(pos[c][0], 1), round(pos[c][1], 1)] for c in chain]})

    areas = {name: [proj(la, lo) for la, lo in ring] for name, ring in AVOID_AREAS.items()}
    for e in edges:
        g = e['geom']
        for name, ring in areas.items():
            total = inner = 0
            for p, q in zip(g, g[1:]):  # 구간마다 10곳을 찍어 구역 안에 든 길이를 잰다
                seg = math.hypot(q[0] - p[0], q[1] - p[1])
                total += seg
                inner += seg / 10 * sum(inside((p[0] + (q[0] - p[0]) * (k + .5) / 10, p[1] + (q[1] - p[1]) * (k + .5) / 10), ring)
                                        for k in range(10))
            if total and inner / total >= AVOID_SHARE:
                e['avoid'] = name

    node_ids = sorted({e['a'] for e in edges} | {e['b'] for e in edges})
    short = {nid: f'n{i}' for i, nid in enumerate(node_ids)}
    for e in edges:
        e['a'], e['b'] = short[e['a']], short[e['b']]
    for b in buildings:
        b['node'] = short[b['node']]
        b['exits'] = [short[n] for n in b['exits']]
        b['x'], b['y'] = round(b['x'], 1), round(b['y'], 1)
    for s in stations:
        s['node'] = short[s['node']]

    height = load_elevation()
    zof = lambda p: round(height(lat0 - p[1] / ky, lon0 + p[0] / kx), 1)
    if height:
        for e in edges:
            g = e['geom']
            cum = [0]
            for p, q in zip(g, g[1:]):
                cum.append(cum[-1] + math.hypot(q[0] - p[0], q[1] - p[1]))
            n = max(1, round(cum[-1] / PROFILE_STEP_M))
            prof, i = [], 0
            for k in range(n + 1):  # 길을 따라 같은 간격으로 높이를 잰다 (a 쪽 → b 쪽)
                d = cum[-1] * k / n
                while i < len(g) - 2 and cum[i + 1] < d:
                    i += 1
                seg = cum[i + 1] - cum[i]
                t = (d - cum[i]) / seg if seg else 0
                prof.append(zof((g[i][0] + (g[i + 1][0] - g[i][0]) * t, g[i][1] + (g[i + 1][1] - g[i][1]) * t)))
            e['z'] = prof

    out = {
        'source': 'OpenStreetMap contributors (ODbL)',
        'origin': {'lat': lat0, 'lon': lon0, 'kx': kx, 'ky': ky},
        'boundary': [[round(x, 1), round(y, 1)] for x, y in poly],
        'elevation': json.loads(ELEVATION.read_text(encoding='utf-8'))['source'] if height else None,
        'nodes': [{'id': short[n], 'x': round(pos[n][0], 1), 'y': round(pos[n][1], 1),
                   **({'z': zof(pos[n])} if height else {})} for n in node_ids],
        'edges': edges,
        'buildings': sorted(buildings, key=lambda b: b['name']),
        'stations': stations,
    }
    OUT.write_text('// 자동 생성 파일: python tools/build_campus.py\n// 지도 데이터 © OpenStreetMap contributors (ODbL)\nexport default '
                   + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    kinds = defaultdict(int)
    for e in edges:
        kinds[e['kind']] += 1
        kinds['avoid'] += 'avoid' in e
    print(f'nodes={len(node_ids)} edges={len(edges)} {dict(kinds)} buildings={len(buildings)} stations={len(stations)}'
          + (' 높이 반영' if height else ' (높이 없음: tools/build_elevation.py 를 먼저 실행)'))


if __name__ == '__main__':
    main()
