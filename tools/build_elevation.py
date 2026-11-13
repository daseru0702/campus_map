"""국토지리정보원 수치지도 2.0(등고선·표고점) → 캠퍼스 높이 격자(data/elevation.json) 변환.

사용법:  python tools/build_elevation.py   (그다음 python tools/build_campus.py)
필요 패키지: pip install pyshp pyproj scipy numpy  — build_campus.py 는 이 패키지 없이 결과 파일만 읽는다.

원본: 국토정보플랫폼(map.ngii.go.kr)에서 받은 1:5,000 수치지도 2.0 도엽 zip 을 data/ngii/ 에 둔다
      (도엽 37616019, 37616020 이 캠퍼스를 덮는다. 원본은 용량이 커서 git 에 올리지 않는다)
- 등고선(N3L_F0010000, 5m 간격)의 꼭짓점과 표고점(N3P_F0020000)을 삼각망으로 이어 높이를 보간한다.
- 캠퍼스 경계 + 여유 범위를 약 5m 격자로 나눠 각 칸의 높이(m)를 저장한다.
"""
import io
import json
import math
import zipfile
from pathlib import Path

import numpy as np
import pyproj
import shapefile
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator
from scipy.ndimage import gaussian_filter

from build_campus import RAW, CAMPUS_WAY_ID

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'ngii'
OUT = ROOT / 'data' / 'elevation.json'

CELL_M = 5        # 격자 간격
MARGIN_M = 150    # 캠퍼스 경계 밖으로 포함할 범위
SMOOTH_CELLS = 1  # 삼각망의 각진 면을 살짝 고르게 (격자 칸 단위)
CRS = 5186        # 수치지도 2.0 좌표계 (Korea 2000 / Central Belt 2010)


def read_layer(zf, name):
    files = {ext: io.BytesIO(zf.read(f'{name}.{ext}')) for ext in ('shp', 'shx', 'dbf')}
    return shapefile.Reader(**files, encoding='euc-kr')


def main():
    pts, z = [], []
    sheets = sorted(SRC.glob('*.zip'))
    if not sheets:
        raise SystemExit(f'{SRC} 에 수치지도 zip 이 없습니다')
    for path in sheets:
        with zipfile.ZipFile(path) as zf:
            contours = read_layer(zf, 'N3L_F0010000')
            for shape, rec in zip(contours.iterShapes(), contours.iterRecords()):
                pts += shape.points
                z += [rec['등고수치']] * len(shape.points)
            spots = read_layer(zf, 'N3P_F0020000')
            for shape, rec in zip(spots.iterShapes(), spots.iterRecords()):
                pts.append(shape.points[0])
                z.append(rec['수치'])
    pts, z = np.array(pts), np.array(z, dtype=float)
    print(f'도엽 {len(sheets)}개, 높이 지점 {len(z)}개 ({z.min():.0f}~{z.max():.0f}m)')

    elements = json.loads(RAW.read_text(encoding='utf-8'))['elements']
    campus = next(e for e in elements if e['type'] == 'way' and e['id'] == CAMPUS_WAY_ID)
    lats = [p['lat'] for p in campus['geometry']]
    lons = [p['lon'] for p in campus['geometry']]
    dlat = CELL_M / 110540
    dlon = CELL_M / (111320 * math.cos(math.radians(sum(lats) / len(lats))))
    north = max(lats) + MARGIN_M / 110540
    west = min(lons) - MARGIN_M / 110540 * dlon / dlat
    rows = math.ceil((north - min(lats)) / dlat + MARGIN_M / CELL_M)
    cols = math.ceil((max(lons) - west) / dlon + MARGIN_M / CELL_M)

    glat, glon = np.meshgrid(north - np.arange(rows) * dlat, west + np.arange(cols) * dlon, indexing='ij')
    gx, gy = pyproj.Transformer.from_crs(4326, CRS, always_xy=True).transform(glon, glat)
    grid = LinearNDInterpolator(pts, z)(gx, gy)
    holes = np.isnan(grid)
    if holes.any():  # 도엽 밖 가장자리는 가장 가까운 값으로 채움
        grid[holes] = NearestNDInterpolator(pts, z)(gx[holes], gy[holes])
    grid = gaussian_filter(grid, SMOOTH_CELLS)

    out = {
        'source': '국토지리정보원 수치지도 2.0 (1:5,000 등고선·표고점), 도엽 ' + ', '.join(p.stem for p in sheets),
        'north': north, 'west': west, 'dlat': dlat, 'dlon': dlon, 'rows': rows, 'cols': cols,
        'z': [round(float(v), 1) for v in grid.ravel()],  # 북→남, 서→동 순서 (m)
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{rows}x{cols} 격자, {grid.min():.0f}~{grid.max():.0f}m, 도엽 밖 {int(holes.sum())}칸 → {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
