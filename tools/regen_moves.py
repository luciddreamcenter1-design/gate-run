#!/usr/bin/env python3
"""Regenerate LTX-2 move clips for one character on Comfy Cloud, then re-bake with tools/bake_sprites.py.

  .venv/bin/python tools/regen_moves.py boss idle attack

Uses the same route as the web build (server.py: cloud:moves_ltx2_api.json) with the character's keyframe
app/sprites/src/<char>_body.png and the motion prompt from workflows/moveset.json. Each old clip is kept as
app/sprites/src/_old/<char>_<move>.<timestamp>.mp4. Needs COMFY_API_KEY in .env and comfy-sdk. Spends Comfy credits.
"""
import os, shutil, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402  (loads .env and the workflow files)

SRC = os.path.join(ROOT, "app/sprites/src")


def regen(char, move, results):
    mv = server.MOVESET["characters"][char]["moves"][move]
    img = open(os.path.join(SRC, f"{char}_body.png"), "rb").read()
    job = {"tried": []}
    t0 = time.time()
    try:
        data = server.run_cloud(job, "moves_ltx2_api.json", img, "IN_IMAGE", {"prompt": mv["motion"], "frames": int(mv["frames"])})
    except Exception as e:
        results[move] = f"FAILED: {type(e).__name__}: {str(e)[:300]}"
        return
    dst = os.path.join(SRC, f"{char}_{move}.mp4")
    os.makedirs(os.path.join(SRC, "_old"), exist_ok=True)
    if os.path.exists(dst):
        shutil.copy2(dst, os.path.join(SRC, "_old", f"{char}_{move}.{int(t0)}.mp4"))
    open(dst, "wb").write(data)
    results[move] = f"ok {len(data) // 1024} KB in {time.time() - t0:.0f}s"


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    if not server.KEY:
        sys.exit("COMFY_API_KEY missing from .env")
    char, moves, results = sys.argv[1], sys.argv[2:], {}
    threads = [threading.Thread(target=regen, args=(char, m, results)) for m in moves]
    for t in threads: t.start()
    for t in threads: t.join()
    for m in moves:
        print(f"{char}_{m}: {results.get(m)}")


if __name__ == "__main__":
    main()
