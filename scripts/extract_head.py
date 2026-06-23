"""Extract the head from the source photo and save a transparent, square PNG.

Pipeline: crop a generous square around the head -> rembg background removal
with alpha matting -> auto-crop to the visible (non-transparent) bounding box
-> pad to a square so it scales cleanly as a circular "ball".
"""
from pathlib import Path

from PIL import Image
from rembg import remove, new_session

SRC = Path("/Users/timsimms/Desktop/Screenshot 2026-06-23 at 09.42.00.png")
OUT = Path(__file__).resolve().parent.parent / "public" / "head.png"

# Generous square around the head (image is 634x648).
CROP_BOX = (190, 190, 440, 440)  # left, top, right, bottom


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    head = img.crop(CROP_BOX)

    session = new_session("u2net")
    cut = remove(
        head,
        session=session,
        alpha_matting=True,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=8,
    )

    # Auto-crop to the non-transparent bounding box.
    alpha = cut.split()[-1]
    bbox = alpha.getbbox()
    if bbox:
        cut = cut.crop(bbox)

    # Pad to a centered square.
    w, h = cut.size
    side = max(w, h)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cut, ((side - w) // 2, (side - h) // 2), cut)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    square.save(OUT)
    print(f"Saved {OUT} ({square.size[0]}x{square.size[1]})")


if __name__ == "__main__":
    main()
