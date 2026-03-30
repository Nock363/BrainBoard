#!/usr/bin/env python3
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
PUBLIC_DIR = ROOT_DIR / 'frontend' / 'public'


def clamp(value: float) -> int:
    return max(0, min(255, round(value)))


def blend(base: tuple[int, int, int, int], overlay: tuple[int, int, int, int], alpha: float) -> tuple[int, int, int, int]:
    alpha = max(0.0, min(1.0, alpha))
    inverse = 1.0 - alpha
    return (
        clamp(base[0] * inverse + overlay[0] * alpha),
        clamp(base[1] * inverse + overlay[1] * alpha),
        clamp(base[2] * inverse + overlay[2] * alpha),
        clamp(base[3] * inverse + overlay[3] * alpha),
    )


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 1.0 if value >= edge1 else 0.0
    t = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def distance_to_rounded_rect(px: float, py: float, cx: float, cy: float, width: float, height: float, radius: float) -> float:
    dx = abs(px - cx) - width / 2.0 + radius
    dy = abs(py - cy) - height / 2.0 + radius
    outside_x = max(dx, 0.0)
    outside_y = max(dy, 0.0)
    inside = min(max(dx, dy), 0.0)
    return math.hypot(outside_x, outside_y) + inside - radius


def distance_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx = bx - ax
    aby = by - ay
    apx = px - ax
    apy = py - ay
    denominator = abx * abx + aby * aby
    if denominator == 0:
        return math.hypot(apx, apy)
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / denominator))
    closest_x = ax + abx * t
    closest_y = ay + aby * t
    return math.hypot(px - closest_x, py - closest_y)


def write_png(path: Path, width: int, height: int, rgba_bytes: bytes) -> None:
    raw = bytearray()
    stride = width * 4
    for row in range(height):
        raw.append(0)
        start = row * stride
        raw.extend(rgba_bytes[start:start + stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = bytearray()
    png.extend(b'\x89PNG\r\n\x1a\n')
    png.extend(chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 6, 0, 0, 0)))
    png.extend(chunk(b'IDAT', zlib.compress(bytes(raw), level=9)))
    png.extend(chunk(b'IEND', b''))
    path.write_bytes(bytes(png))


def generate_icon(size: int) -> bytes:
    pixels = bytearray(size * size * 4)
    cx = cy = size / 2.0
    ring_radius = size * 0.275
    ring_thickness = size * 0.052
    pill_width = size * 0.30
    pill_height = size * 0.115
    pill_radius = pill_height / 2.0
    line_thickness = size * 0.022

    for y in range(size):
        for x in range(size):
            u = x / max(1, size - 1)
            v = y / max(1, size - 1)

            bg_start = (0x17, 0x1A, 0x24, 0xFF)
            bg_end = (0x0B, 0x0D, 0x12, 0xFF)
            bg = blend(bg_start, bg_end, (u * 0.42 + v * 0.58) / 1.0)

            distance = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            ring_alpha = 1.0 - smoothstep(ring_thickness * 0.45, ring_thickness * 0.65, abs(distance - ring_radius))
            angle = math.atan2(y + 0.5 - cy, x + 0.5 - cx)
            ring_color = blend((0xFF, 0xB2, 0x6B, 0xFF), (0xFF, 0x6A, 0x1B, 0xFF), (math.sin(angle) + 1.0) * 0.5)
            pixel = blend(bg, ring_color, ring_alpha)

            pill_distance = distance_to_rounded_rect(x + 0.5, y + 0.5, cx, cy + size * 0.02, pill_width, pill_height, pill_radius)
            pill_alpha = 1.0 - smoothstep(0.0, size * 0.018, pill_distance)
            pill_color = blend((0xFF, 0xA7, 0x5D, 0xFF), (0xFF, 0x6A, 0x1B, 0xFF), v)
            pixel = blend(pixel, pill_color, pill_alpha)

            accent_segments = [
                (cx - size * 0.12, cy, cx + size * 0.12, cy),
                (cx, cy - size * 0.12, cx, cy + size * 0.12),
                (cx - size * 0.17, cy - size * 0.17, cx - size * 0.08, cy - size * 0.08),
                (cx + size * 0.08, cy + size * 0.08, cx + size * 0.17, cy + size * 0.17),
            ]
            accent_alpha = 0.0
            for ax, ay, bx, by in accent_segments:
                accent_alpha = max(accent_alpha, 1.0 - smoothstep(line_thickness * 0.4, line_thickness * 0.9, distance_to_segment(x + 0.5, y + 0.5, ax, ay, bx, by)))
            pixel = blend(pixel, (0xF2, 0xED, 0xE6, 0xFF), accent_alpha)

            offset = (y * size + x) * 4
            pixels[offset:offset + 4] = bytes(pixel)

    return bytes(pixels)


def main() -> None:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    for size, name in ((192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')):
        path = PUBLIC_DIR / name
        write_png(path, size, size, generate_icon(size))
        print(f'Wrote {path.relative_to(ROOT_DIR)}')


if __name__ == '__main__':
    main()
