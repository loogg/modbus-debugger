from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# vertical gradient background
top = (0, 120, 212)      # #0078D4
bottom = (0, 90, 158)    # #005A9E
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=(int(top[0] + (bottom[0] - top[0]) * t), int(top[1] + (bottom[1] - top[1]) * t), int(top[2] + (bottom[2] - top[2]) * t), 255))
# rounded-rect mask
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=190, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# square wave (Modbus RTU pulse), white, thick
w = 66
ys_high, ys_low = 330, 560
pts = [(150, ys_low), (250, ys_low), (250, ys_high), (410, ys_high), (410, ys_low), (570, ys_low), (570, ys_high), (730, ys_high), (730, ys_low), (874, ys_low)]
d.line(pts, fill=(255, 255, 255, 255), width=w, joint="curve")
for (x, y) in pts:
    d.ellipse([x - w // 2, y - w // 2, x + w // 2, y + w // 2], fill=(255, 255, 255, 255))

# register grid: 2 rows x 4 cols, rounded cells
cell_w, cell_h, gap = 168, 108, 28
grid_w = 4 * cell_w + 3 * gap
x0 = (S - grid_w) // 2
y0 = 660
highlight = 5
for i in range(8):
    r, c = divmod(i, 4)
    x = x0 + c * (cell_w + gap)
    y = y0 + r * (cell_h + gap)
    if i == highlight:
        d.rounded_rectangle([x, y, x + cell_w, y + cell_h], radius=26, fill=(155, 208, 245, 255))
    else:
        d.rounded_rectangle([x, y, x + cell_w, y + cell_h], radius=26, outline=(255, 255, 255, 235), width=14)

img.save("build/icon.png")
img.save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon written")