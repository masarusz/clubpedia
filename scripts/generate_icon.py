#!/usr/bin/env python3
"""Generate Clubpedia's book icon assets.

Pillow only for PNG output. The SVG is written directly so the browser icon
stays sharp, while the PNGs are opaque RGB for iOS/PWA use.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets"

GREEN = (23, 63, 53)
WHITE = (255, 255, 255)
PAGE = (235, 244, 240)

SCALE = 4


def draw_icon(draw, size):
    s = size
    stroke = max(4, round(s * 0.045))
    cx = s / 2
    top = s * 0.22
    bottom = s * 0.78
    left = s * 0.20
    right = s * 0.80
    gutter = s * 0.035

    left_page = [
        (cx, top + s * 0.035),
        (left, top),
        (left, bottom - s * 0.035),
        (cx, bottom + s * 0.035),
    ]
    right_page = [
        (cx, top + s * 0.035),
        (right, top),
        (right, bottom - s * 0.035),
        (cx, bottom + s * 0.035),
    ]
    draw.polygon(left_page, fill=PAGE)
    draw.polygon(right_page, fill=PAGE)
    draw.line([left_page[1], left_page[2], left_page[3], left_page[0], left_page[1]], fill=WHITE, width=stroke, joint="curve")
    draw.line([right_page[0], right_page[1], right_page[2], right_page[3], right_page[0]], fill=WHITE, width=stroke, joint="curve")
    draw.line([(cx, top + s * 0.04), (cx, bottom + s * 0.03)], fill=GREEN, width=max(2, stroke // 2))
    draw.line([(cx - gutter, top + s * 0.055), (cx - gutter, bottom + s * 0.015)], fill=WHITE, width=max(2, stroke // 3))
    draw.line([(cx + gutter, top + s * 0.055), (cx + gutter, bottom + s * 0.015)], fill=WHITE, width=max(2, stroke // 3))

    pitch_left = left + s * 0.035
    pitch_right = right - s * 0.035
    pitch_top = top + s * 0.095
    pitch_bottom = bottom - s * 0.075
    pitch_mid = (pitch_top + pitch_bottom) / 2
    pitch_stroke = max(2, round(s * 0.018))
    circle_r = (pitch_bottom - pitch_top) * 0.25
    draw.ellipse(
        [cx - circle_r, pitch_mid - circle_r, cx + circle_r, pitch_mid + circle_r],
        outline=GREEN,
        width=pitch_stroke,
    )

    box_depth = s * 0.105
    box_top = pitch_mid - s * 0.105
    box_bottom = pitch_mid + s * 0.105
    goal_depth = s * 0.052
    goal_top = pitch_mid - s * 0.055
    goal_bottom = pitch_mid + s * 0.055
    draw.line([(pitch_left, box_top), (pitch_left + box_depth, box_top), (pitch_left + box_depth, box_bottom), (pitch_left, box_bottom)], fill=GREEN, width=pitch_stroke)
    draw.line([(pitch_left, goal_top), (pitch_left + goal_depth, goal_top), (pitch_left + goal_depth, goal_bottom), (pitch_left, goal_bottom)], fill=GREEN, width=pitch_stroke)
    draw.line([(pitch_right, box_top), (pitch_right - box_depth, box_top), (pitch_right - box_depth, box_bottom), (pitch_right, box_bottom)], fill=GREEN, width=pitch_stroke)
    draw.line([(pitch_right, goal_top), (pitch_right - goal_depth, goal_top), (pitch_right - goal_depth, goal_bottom), (pitch_right, goal_bottom)], fill=GREEN, width=pitch_stroke)


def render_png(size):
    hi = size * SCALE
    image = Image.new("RGB", (hi, hi), GREEN)
    draw_icon(ImageDraw.Draw(image), hi)
    return image.resize((size, size), Image.LANCZOS).convert("RGB")


def write_svg():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Clubpedia">
  <rect width="512" height="512" fill="#173f35"/>
  <path d="M256 130 L102 112 L102 382 L256 418 Z" fill="#ebf4f0" stroke="#fff" stroke-width="23" stroke-linejoin="round"/>
  <path d="M256 130 L410 112 L410 382 L256 418 Z" fill="#ebf4f0" stroke="#fff" stroke-width="23" stroke-linejoin="round"/>
  <path d="M256 132 L256 406" stroke="#173f35" stroke-width="12" stroke-linecap="round"/>
  <path d="M238 140 L238 390 M274 140 L274 390" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
  <circle cx="256" cy="261" r="55" fill="none" stroke="#173f35" stroke-width="9"/>
  <path d="M120 207 L174 207 L174 315 L120 315 M120 233 L147 233 L147 289 L120 289" fill="none" stroke="#173f35" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M392 207 L338 207 L338 315 L392 315 M392 233 L365 233 L365 289 L392 289" fill="none" stroke="#173f35" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""
    (ASSETS / "icon.svg").write_text(svg, encoding="utf-8")


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    write_svg()
    outputs = {
        "apple-touch-icon.png": 180,
        "icon-192.png": 192,
        "icon-512.png": 512,
    }
    for name, size in outputs.items():
        image = render_png(size)
        image.save(ASSETS / name, format="PNG")
        print(f"{name}: {size}x{size} {image.mode}")
    print("icon.svg: 512x512 SVG")


if __name__ == "__main__":
    main()
