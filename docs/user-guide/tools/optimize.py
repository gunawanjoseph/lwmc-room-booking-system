"""Shrinks new guide screenshots so the Word file and repo stay small.

    python3 docs/user-guide/tools/optimize.py      (needs Pillow: pip install pillow)

Screenshots (*.png other than diagram-*) become JPEGs no wider than 1600px;
diagrams stay PNG but are reduced to 256 colours, which keeps text sharp.
"""
import glob
import os

from PIL import Image

IMAGES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "images")

for path in glob.glob(os.path.join(IMAGES, "*.png")):
    name = os.path.basename(path)
    image = Image.open(path)
    if name.startswith("diagram-"):
        image.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
        continue
    image = image.convert("RGB")
    if image.width > 1600:
        image = image.resize((1600, round(image.height * 1600 / image.width)), Image.LANCZOS)
    image.save(path[:-4] + ".jpg", quality=84, optimize=True, progressive=True)
    os.remove(path)
    print("optimised", name)
