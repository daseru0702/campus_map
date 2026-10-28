"""OpenStreetMap 원본(data/osm_raw.json) → 앱용 경로 그래프(js/campus.js) 변환.

사용법:  python tools/build_campus.py
원본 갱신: data/overpass_query.txt 를 https://overpass-turbo.eu 에서 실행해 data/osm_raw.json 으로 저장

- 좌표는 캠퍼스 중심 기준 미터(x: 동쪽 +, y: 남쪽 +)로 변환한다. 화면 표시 때 다시 위경도로 바꾼다.
- 교차점/막다른 길/건물·대여소 연결점만 그래프 노드로 남기고, 그 사이 굽은 길은 간선의 geom 으로 보존한다.
"""
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'osm_raw.json'
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
]

WALK_ONLY = {'footway', 'steps', 'path', 'pedestrian', 'corridor', 'elevator'}
EXCLUDE = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed'}


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

    def inside(pt):
        x, y = pt
        c = False
        for i in range(len(poly)):
            (x1, y1), (x2, y2) = poly[i - 1], poly[i]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    def seg_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = 0 if dx == dy == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

    def near_campus(pt):
        return inside(pt) or min(seg_dist(pt, poly[i - 1], poly[i]) for i in range(len(poly))) <= CAMPUS_BUFFER_M

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
        buildings.append({'name': t['name'], 'x': c[0], 'y': c[1]})
    buildings.append({'name': GATE['name'], 'x': proj(GATE['lat'], GATE['lon'])[0], 'y': proj(GATE['lat'], GATE['lon'])[1]})
    keep = set()
    for i, b in enumerate(buildings):
        b['id'] = f'd{i}'
        b['node'] = nearest((b['x'], b['y']), adj.keys())
        keep.add(b['node'])

    stations = []
    by_name = {b['name']: b for b in buildings}
    for sid, name, near, cap in STATION_SPOTS:
        b = by_name[near]
        n = nearest((b['x'], b['y']), bike_nodes)
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

    node_ids = sorted({e['a'] for e in edges} | {e['b'] for e in edges})
    short = {nid: f'n{i}' for i, nid in enumerate(node_ids)}
    for e in edges:
        e['a'], e['b'] = short[e['a']], short[e['b']]
    for b in buildings:
        b['node'] = short[b['node']]
        b['x'], b['y'] = round(b['x'], 1), round(b['y'], 1)
    for s in stations:
        s['node'] = short[s['node']]

    out = {
        'source': 'OpenStreetMap contributors (ODbL)',
        'origin': {'lat': lat0, 'lon': lon0, 'kx': kx, 'ky': ky},
        'boundary': [[round(x, 1), round(y, 1)] for x, y in poly],
        'nodes': [{'id': short[n], 'x': round(pos[n][0], 1), 'y': round(pos[n][1], 1)} for n in node_ids],
        'edges': edges,
        'buildings': sorted(buildings, key=lambda b: b['name']),
        'stations': stations,
    }
    OUT.write_text('// 자동 생성 파일: python tools/build_campus.py\n// 지도 데이터 © OpenStreetMap contributors (ODbL)\nexport default '
                   + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    kinds = defaultdict(int)
    for e in edges:
        kinds[e['kind']] += 1
    print(f'nodes={len(node_ids)} edges={len(edges)} {dict(kinds)} buildings={len(buildings)} stations={len(stations)}')


if __name__ == '__main__':
    main()
