#!/usr/bin/env python3
"""生成 App 图标与扩展图标：两张错开的书页（verso = 书页背面），前页上三行字。改了就重跑，产物入库。"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def pages(size, bg=True):
    k = 4  # 超采样抗锯齿
    n = size * k
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    if bg:
        top, bottom = (224, 138, 106), (196, 96, 70)
        grad = Image.new("RGBA", (1, n))
        for y in range(n):
            grad.putpixel((0, y), lerp(top, bottom, y / (n - 1)) + (255,))
        img = grad.resize((n, n))
    d = ImageDraw.Draw(img)
    u = n / 1024
    r = 64 * u
    d.rounded_rectangle([250 * u, 190 * u, 700 * u, 760 * u], r, fill=(255, 255, 255, 110))
    d.rounded_rectangle([340 * u, 280 * u, 790 * u, 850 * u], r, fill=(255, 250, 244, 255))
    ink = (196, 96, 70, 255)
    for i, w in enumerate((330, 290, 200)):
        y = (430 + i * 110) * u
        d.rounded_rectangle([410 * u, y, (410 + w) * u, y + 46 * u], 23 * u, fill=ink)
    return img.resize((size, size), Image.LANCZOS)


def toolbar(size):
    k = 8
    n = size * k
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = n / 32
    w = round(2.2 * u)
    d.rounded_rectangle([5 * u, 3 * u, 20 * u, 22 * u], 3 * u, outline=(0, 0, 0, 255), width=w)
    d.rounded_rectangle([11 * u, 9 * u, 27 * u, 29 * u], 3 * u, fill=(255, 255, 255, 0), outline=(0, 0, 0, 255), width=w)
    # 前页遮住后页的那一角
    d.rectangle([11 * u + w, 9 * u + w, 20 * u, 22 * u], fill=(0, 0, 0, 0))
    for i, x2 in enumerate((23, 21)):
        y = (16 + i * 5) * u
        d.line([15 * u, y, x2 * u, y], fill=(0, 0, 0, 255), width=w)
    return img.resize((size, size), Image.LANCZOS)


icon_dir = ROOT / "App/Assets.xcassets/AppIcon.appiconset"
icon_dir.mkdir(parents=True, exist_ok=True)
pages(S).convert("RGB").save(icon_dir / "icon-1024.png")  # iOS App 图标不能有透明通道
(icon_dir / "Contents.json").write_text(
    '{"images":[{"filename":"icon-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"}],'
    '"info":{"author":"xcode","version":1}}\n')
(ROOT / "App/Assets.xcassets/Contents.json").write_text('{"info":{"author":"xcode","version":1}}\n')

static = ROOT / "web/static"
for s in (48, 96, 128, 256, 512):
    pages(s).save(static / f"icon-{s}.png", optimize=True)
for s in (16, 32):
    toolbar(s).save(static / f"toolbar-{s}.png", optimize=True)
print("ok")
