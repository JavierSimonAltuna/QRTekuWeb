"""
Genera Pulso.ico con el diseño del logo PULSO (fondo rojo, P blanca, línea ECG)
usando solo Pillow (ya en requirements.txt).  Ejecutar antes de build.bat:

    python make_ico.py
"""

from PIL import Image, ImageDraw, ImageFont
import os

SIZES = [16, 32, 48, 64, 128, 256]
RED = (230, 48, 48, 255)
WHITE = (255, 255, 255, 255)


def _draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Fondo rojo con esquinas redondeadas
    r = max(2, size // 6)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=r, fill=RED)

    # "P" centrada en blanco
    font_size = int(size * 0.55)
    font = None
    for candidate in [
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        if os.path.exists(candidate):
            try:
                font = ImageFont.truetype(candidate, font_size)
                break
            except Exception:
                pass
    if font is None:
        font = ImageFont.load_default()

    bbox = d.textbbox((0, 0), "P", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] - int(size * 0.03)
    d.text((tx, ty), "P", font=font, fill=WHITE)

    # Línea ECG pequeña en la parte inferior (sólo si el icono es suficientemente grande)
    if size >= 32:
        y0 = int(size * 0.80)
        lw = max(1, size // 40)
        margin = int(size * 0.12)
        mid = size // 2
        pts = [
            (margin, y0),
            (mid - int(size * 0.15), y0),
            (mid - int(size * 0.08), y0 - int(size * 0.09)),
            (mid, y0 + int(size * 0.09)),
            (mid + int(size * 0.08), y0),
            (size - margin, y0),
        ]
        for i in range(len(pts) - 1):
            d.line([pts[i], pts[i + 1]], fill=WHITE, width=lw)

    return img


def main():
    frames = [_draw_icon(s) for s in SIZES]
    out = "Pulso.ico"
    frames[0].save(
        out,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=frames[1:],
    )
    print(f"[OK] {out} generado con tamaños {SIZES}")


if __name__ == "__main__":
    main()
