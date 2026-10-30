#!/usr/bin/env python3
"""Bake LTX green-screen move clips into sprite sheets for the game.

  python3 tools/bake_sprites.py            # reads app/sprites/src/<char>_<move>.mp4

For each clip: sample the key color from the frame corners, key it out with ffmpeg
(colorkey + despill), resample to FPS, tile into a sheet (COLS wide), and measure the
character's foot line and height so every move of a character shares one ground anchor.
Writes app/sprites/<char>_<move>.png and app/sprites/manifest.json. Needs ffmpeg.
"""
import json, math, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, OUT = os.path.join(ROOT, "app/sprites/src"), os.path.join(ROOT, "app/sprites")
MOVES = json.load(open(os.path.join(ROOT, "workflows/moveset.json")))["characters"]
FW, FH, FPS, COLS, MAXF = 192, 288, 12, 8, 16


def ff(*args, raw=False):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr.decode()[-400:])
    return r.stdout


def key_color(path):
    px = ff("-i", path, "-frames:v", "1", "-vf", f"scale={FW}:{FH},crop=6:6:2:2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
    n = len(px) // 3
    r, g, b = (sum(px[i::3]) // n for i in range(3))
    return f"0x{r:02x}{g:02x}{b:02x}"


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())


def keyed_chain(color):
    return f"fps={FPS},scale={FW}:{FH}:flags=lanczos,colorkey={color}:0.30:0.10,despill=type=green:mix=0.7:expand=0.15,format=rgba"


def frames(path, color):
    raw = ff("-i", path, "-vf", keyed_chain(color), "-f", "rawvideo", "-pix_fmt", "rgba", "-")
    size = FW * FH * 4
    return [raw[i * size:(i + 1) * size] for i in range(len(raw) // size)]


def motion_range(fr, loop, maxf=MAXF):
    """LTX tends to hold the first pose for a second: keep only frames where the character moves."""
    sig = [[f[(y * FW + x) * 4 + c] for y in range(0, FH, 12) for x in range(0, FW, 12) for c in (1, 3)] for f in fr]
    diff = [0] + [sum(abs(a - b) for a, b in zip(sig[i], sig[i - 1])) / len(sig[i]) for i in range(1, len(sig))]
    thr = max(1.0, .2 * max(diff))
    moving = [i for i, d in enumerate(diff) if d > thr]
    if not moving:
        return 0, len(fr) - 1
    a, b = max(0, moving[0] - 1), min(len(fr) - 1, moving[-1] + (1 if loop else 3))
    if b - a + 1 > maxf:
        a = b - maxf + 1 if loop else a       # loops: keep the settled cycle at the end
        b = min(b, a + maxf - 1)
    return a, b


def bbox(fr):
    """Union bbox (alpha > 50%) across frames: foot line and top of the character."""
    top, foot, left, right = FH, 0, FW, 0
    for f in fr[::3]:
        a = f[3::4]
        for y in range(FH):
            row = a[y * FW:(y + 1) * FW]
            xs = [x for x in range(0, FW, 2) if row[x] > 128]
            if xs:
                top, foot = min(top, y), max(foot, y)
                left, right = min(left, xs[0]), max(right, xs[-1])
    return top, foot, left, right


def main():
    manifest = {"frame": [FW, FH], "fps": FPS, "chars": {}}
    for char, spec in MOVES.items():
        anims, anchor = {}, None
        for move, mv in spec["moves"].items():
            src = os.path.join(SRC, f"{char}_{move}.mp4")
            if not os.path.exists(src):
                print("missing", src); continue
            color = key_color(src)
            fr = frames(src, color)
            a, b = motion_range(fr, bool(mv.get("loop")), mv.get("maxf", MAXF))
            n = b - a + 1
            rows = math.ceil(n / COLS)
            out = f"{char}_{move}.png"
            ff("-i", src, "-vf", keyed_chain(color) + f",select='between(n\\,{a}\\,{b})',setpts=N/TB,tile={COLS}x{rows}:padding=0",
               "-frames:v", "1", "-compression_level", "9", os.path.join(OUT, out))
            anims[move] = {"img": out, "cols": COLS, "rows": rows, "n": n, "loop": bool(mv.get("loop"))}
            if anchor is None or move in ("idle", "move"):
                t, f_, l, r = bbox(fr[a:b + 1])
                anchor = {"top": round(t / FH, 4), "foot": round(f_ / FH, 4), "cx": round((l + r) / 2 / FW, 4)}
            print(f"{char:7} {move:8} key {color} frames {a}-{b} ({n}) of {len(fr)} -> {out} {os.path.getsize(os.path.join(OUT, out)) // 1024}KB")
        if anims:
            manifest["chars"][char] = {"anchor": anchor, "anims": anims}
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    print("manifest:", {c: list(v["anims"]) for c, v in manifest["chars"].items()})


if __name__ == "__main__":
    main()
