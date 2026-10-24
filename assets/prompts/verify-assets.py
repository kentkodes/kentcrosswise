from pathlib import Path
from PIL import Image, ImageOps
import json

root = Path(__file__).resolve().parents[2]
plate = root / 'assets/plates'
review = root / '.impeccable/review/asset-proofs'
review.mkdir(parents=True, exist_ok=True)
# Impeccable's documented material exception: exact clean 70x66 paper patch,
# mirror tiled, never used as an artwork reconstruction or resampled crop.
patch = Image.open(root / '.impeccable/build/crops/paper-surface.png').convert('RGB')
tile = Image.new('RGB', (256,256))
for row, y in enumerate(range(0,256,patch.height)):
    for col, x in enumerate(range(0,256,patch.width)):
        cell = ImageOps.mirror(patch) if col % 2 else patch
        cell = ImageOps.flip(cell) if row % 2 else cell
        tile.paste(cell, (x,y))
tile.save(plate / 'paper-surface.png')
crt = Image.open(plate / 'retro-computer.png').convert('RGBA')
for name, color in [('light',(248,241,228)),('dark',(18,25,38))]:
    proof=Image.new('RGBA', crt.size, color+(255,))
    proof.alpha_composite(crt)
    proof.convert('RGB').save(review / f'computer-alpha-{name}.png')
info=[]
for p in plate.glob('*.png'):
    im=Image.open(p)
    record={'file':str(p.relative_to(root)), 'width':im.width, 'height':im.height, 'mode':im.mode}
    if 'A' in im.getbands():
        hist=im.getchannel('A').histogram()
        record.update(alphaZero=hist[0], alphaOpaque=hist[255], alphaPartial=sum(hist[1:255]))
    info.append(record)
(review / 'dimensions-alpha.json').write_text(json.dumps(info,indent=2)+'\n')
print(json.dumps(info,indent=2))
