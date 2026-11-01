#!/usr/bin/env python3
"""Gate Run server: serves the game and routes each generation job.

The browser asks for a "portrait" (selfie -> anime hunter) or a "clip"
(hunter -> Gate opening video). The server walks a route list and uses the
first route that works, falling through to the next on any error:

  router:<model>   Comfy Router (api.comfy.org/v2/models): one API for hosted
                   models. Router also switches serving providers on its own.
  cloud:<file>     A ComfyUI workflow from workflows/ run on Comfy Cloud
                   through comfy-sdk (RTX 6000 Pro, open weights + LoRAs).
  local:<file>     The same workflow on your own ComfyUI (/prompt API).

Environment:
  COMFY_API_KEY    Comfy workspace key, used for Router, Cloud and partner
                   nodes on local ComfyUI   (platform.comfy.org/profile/api-keys)
  COMFY_URL        local ComfyUI            (default http://127.0.0.1:8188)
  PORTRAIT_ROUTES  comma list, overrides the default portrait chain
  CLIP_ROUTES      comma list, overrides the default clip chain
  PORT             this server's port       (default 8080)
Any of these can also go in a .env file next to this script (gitignored).

Router works with the standard library. Cloud routes need `pip install comfy-sdk`;
when it is installed the Router calls go through it too.
"""
import base64, json, os, random, re, threading, time, uuid
import urllib.error, urllib.parse, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import comfy_sdk
except ImportError:
    comfy_sdk = None

ROOT = os.path.dirname(os.path.abspath(__file__))
if os.path.exists(os.path.join(ROOT, ".env")):  # KEY=value lines; real env vars win
    for line in open(os.path.join(ROOT, ".env")):
        k, _, v = line.strip().partition("=")
        if k and not k.startswith("#") and v:
            os.environ.setdefault(k.strip(), v.strip().strip('"\''))
WF_DIR = os.path.join(ROOT, "workflows")
KEY = os.environ.get("COMFY_API_KEY", "").strip()
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
ROUTER = os.environ.get("COMFY_ROUTER_URL", "https://api.comfy.org").rstrip("/")
PORT = int(os.environ.get("PORT", "8080"))
# Free tier on the host key (hosted deploys set FREE_LIMITS=1). Visitors with their own key are not limited.
FREE_LIMITS = os.environ.get("FREE_LIMITS", "") == "1"
FREE_JOBS_PER_IP = int(os.environ.get("FREE_JOBS_PER_IP", "14"))    # about one Crasher: portrait, quick trailer, voice, body, 5 moves
FREE_JOBS_PER_DAY = int(os.environ.get("FREE_JOBS_PER_DAY", "600"))
USAGE = {}

ROUTES = {
    "portrait": os.environ.get("PORTRAIT_ROUTES",
        "router:vertexai/gemini-3.1-flash-image,router:bfl/flux-3-image,router:bfl/flux-kontext-pro,local:hunter_portrait_api.json"),
    "clip": os.environ.get("CLIP_ROUTES",
        "cloud:gate_clip_ltx2_lora_api.json,cloud:gate_clip_ltx25_api.json,"
        "local:gate_clip_ltx25_api.json,local:gate_clip_api.json,router:ltx/ltx-2-5-fast"),
}
ROUTES["keyframe"] = os.environ.get("KEYFRAME_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
ROUTES["voice"] = os.environ.get("VOICE_ROUTES", "router:elevenlabs/eleven_v3,router:elevenlabs/eleven_multilingual_v2")
ROUTES["body"] = os.environ.get("BODY_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
ROUTES["move"] = os.environ.get("MOVE_ROUTES", "cloud:moves_ltx2_api.json,local:moves_ltx2_api.json")
ROUTES["arena"] = os.environ.get("ARENA_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
ROUTES["arenaground"] = os.environ.get("ARENAGROUND_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
ROUTES["arenaloop"] = os.environ.get("ARENALOOP_ROUTES", "cloud:arena_ltx2_api.json,local:arena_ltx2_api.json")
ROUTES["upscale"] = os.environ.get("UPSCALE_ROUTES", "router:bfl/video-upscale-v1")
ROUTES = {k: [r.strip() for r in v.split(",") if r.strip()] for k, v in ROUTES.items()}


def _wf_prompt(name):
    wf = json.load(open(os.path.join(WF_DIR, name)))
    return next(n["inputs"]["text"] for n in wf.values() if n.get("_meta", {}).get("title") == "IN_PROMPT")


PORTRAIT_PROMPT = _wf_prompt("hunter_portrait_api.json")
# Router's LTX takes text only, so this route renders an empty Gate plate and the
# browser composites the player's hunter in front of it.
PLATE_PROMPT = ("Empty rain-slick city street at night, vertical frame. In the center a rift of blue and violet "
                "light tears open into a glowing Gate: crackling energy arcs, swirling sparks, debris lifting off "
                "the ground, wind. Slow cinematic dolly-in toward the Gate, anime style, dramatic light. No people, "
                "no text. Audio: a deep rising hum, crackling electricity, rushing wind, a bright whoosh.")

TRAILER = json.load(open(os.path.join(WF_DIR, "trailer.json")))
MOVESET = json.load(open(os.path.join(WF_DIR, "moveset.json")))
ARENAS = json.load(open(os.path.join(WF_DIR, "arenas.json")))
JOBS, LOCK = {}, threading.Lock()


class Skip(Exception):
    """Route not usable here (missing key, SDK or server). Not an error worth reporting."""


# ---------------------------------------------------------------- helpers
def http(url, data=None, headers=None, method=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read()


def http_json(url, body=None, headers=None, method=None, timeout=60):
    h = {"Content-Type": "application/json", **(headers or {})}
    status, hdrs, raw = http(url, json.dumps(body).encode() if body is not None else None, h, method, timeout)
    return status, hdrs, json.loads(raw or b"{}")


def find_url(obj):
    """First media URL anywhere in a model's native output."""
    if isinstance(obj, str):
        return obj if re.match(r"https?://", obj) else None
    items = obj.values() if isinstance(obj, dict) else obj if isinstance(obj, list) else []
    for v in items:
        u = find_url(v)
        if u:
            return u
    return None


def find_inline(obj):
    """Base64 image data in a Gemini-style response (inlineData parts), if any."""
    if isinstance(obj, dict):
        d = obj.get("inlineData") or obj.get("inline_data")
        if isinstance(d, dict) and d.get("data"):
            return d["data"]
        obj = list(obj.values())
    if isinstance(obj, list):
        for v in obj:
            r = find_inline(v)
            if r:
                return r
    return None


def sniff(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n": return "image/png"
    if data[:3] == b"\xff\xd8\xff": return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp"
    if data[4:8] == b"ftyp": return "video/mp4"
    if data[:4] == b"\x1aE\xdf\xa3": return "video/webm"
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"): return "audio/mpeg"
    return "application/octet-stream"


def local_up():
    try:
        return http(COMFY_URL + "/system_stats", timeout=2)[0] == 200
    except Exception:
        return False


def load_wf(name, image_title, image_value, seed, prompt=None, frames=None):
    wf = json.load(open(os.path.join(WF_DIR, name)))
    ids = lambda t: [i for i, n in wf.items() if n.get("_meta", {}).get("title") == t]
    img = ids(image_title)
    out = ids("OUT")
    if not img or not out:
        raise RuntimeError(f"{name} needs nodes titled {image_title} and OUT")
    for i in img:
        wf[i]["inputs"]["image"] = image_value
    if prompt:  # per-shot motion prompt from trailer.json
        for i in ids("IN_PROMPT"):
            wf[i]["inputs"]["text"] = prompt
        for n in wf.values():
            if n["class_type"].startswith("LtxApi") and "prompt" in n["inputs"]:
                n["inputs"]["prompt"] = "Use the provided start image as the first frame. " + prompt
    if frames:
        for i, n in wf.items():
            if n.get("_meta", {}).get("title", "").startswith("Frames"):
                n["inputs"]["value"] = frames
    for i in ids("IN_SEED"):
        for k in ("seed", "noise_seed"):
            if k in wf[i]["inputs"]:
                wf[i]["inputs"][k] = seed
    return wf, img[0], out[0]


# ---------------------------------------------------------------- routes
def router_body(model, img_b64, opts):
    if model.startswith("elevenlabs/"):
        text = opts["text"]
        if model.endswith("v3"):
            return {"inputs": [{"text": text, "voice_id": TRAILER["voice_id"]}]}, False
        return {"text": text, "voice_id": TRAILER["voice_id"]}, False
    if "upscale" in model:
        return {"input_video": "data:video/mp4;base64," + img_b64, "upscale_factor": 1.5, "creativity": 0}, False
    prompt = opts.get("prompt") or PORTRAIT_PROMPT
    if "gemini" in model:  # Gemini Flash Image: ~22 s for the portrait vs ~50 s for FLUX 3
        return {"contents": [{"role": "user", "parts": [{"text": prompt + " Square 1:1 portrait."},
                {"inlineData": {"mimeType": sniff(base64.b64decode(img_b64)) or "image/png", "data": img_b64}}]}],
                "generationConfig": {"responseModalities": ["IMAGE"]}}, False
    if opts.get("prompt") and not model.startswith("ltx/"):  # trailer keyframe / sprite body
        ar = opts.get("aspect", "9:16")
        if "kontext" in model:
            return {"prompt": prompt, "aspect_ratio": ar, "output_format": "png", **({"input_image": img_b64} if img_b64 else {})}, False
        return {"prompt": prompt, "aspect_ratio": ar, "resolution": "1k", **({"images": [img_b64]} if img_b64 else {})}, False
    if model.startswith("ltx/"):
        return {"prompt": PLATE_PROMPT, "duration": 5, "fps": 24, "generate_audio": True, "resolution": "1080x1920"}, True
    if "kontext" in model:
        return {"prompt": prompt, "input_image": img_b64, "aspect_ratio": "1:1", "output_format": "png"}, False
    return {"prompt": prompt, "images": [img_b64], "aspect_ratio": "1:1", "resolution": "1k"}, False


def run_router(job, model, img, opts):
    key = opts.get("key") or KEY
    if not key:
        raise Skip("no COMFY_API_KEY")
    body, plate = router_body(model, base64.b64encode(img).decode(), opts)
    job["plate"] = plate
    sync = model.startswith("elevenlabs/")  # Router serves these on the synchronous route only
    if comfy_sdk and sync:
        note(job, f"Comfy Router · {model} · running")
        with comfy_sdk.Comfy(api_key=key) as c:
            result = c.models.run(model, body)
        if isinstance(result, comfy_sdk.BinaryResult):
            return result.content
    elif sync:
        note(job, f"Comfy Router · {model} · running")
        return http(f"{ROUTER}/v2/models/{model}", json.dumps(body).encode(),
                    {"X-API-Key": key, "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())}, timeout=180)[2]
    elif comfy_sdk:  # SDK: queued submit, poll with server-named Retry-After, typed errors
        with comfy_sdk.Comfy(api_key=key) as c:
            h = c.models.submit(model, body)
            for u in h.iter_events():
                note(job, f"Comfy Router · {model} · {u.status.lower().replace('_', ' ')}"
                          + (f" #{u.queue_position}" if u.queue_position else ""))
            result = h.get()
        if isinstance(result, comfy_sdk.BinaryResult):
            return result.content
    else:  # plain HTTP, same queue routes
        base, hdr = f"{ROUTER}/v2/models/{model}/requests", {"X-API-Key": key}
        _, _, sub = http_json(base, body, {**hdr, "Idempotency-Key": str(uuid.uuid4())})
        rid = sub["request_id"]
        while True:
            _, hh, st = http_json(f"{base}/{rid}/status", headers=hdr)
            note(job, f"Comfy Router · {model} · {st.get('status', '').lower().replace('_', ' ')}")
            if st.get("status") == "COMPLETED":
                break
            time.sleep(min(10, float(hh.get("Retry-After") or 2)))
        _, _, result = http_json(f"{base}/{rid}", headers=hdr)
        if isinstance(result, dict) and result.get("error_type"):
            raise RuntimeError(result.get("detail") or result["error_type"])
    if isinstance(result, dict) and str(result.get("status", "")).lower() in ("failed", "error", "request moderated", "content moderated"):
        raise RuntimeError(f"{model}: {result.get('status')}")
    inline = find_inline(result)
    if inline:
        return base64.b64decode(inline)
    url = find_url(result.get("result", result) if isinstance(result, dict) else result)
    if not url:
        raise RuntimeError(f"{model} returned no media")
    return http(url, timeout=180)[2]


def run_cloud(job, name, img, image_title, opts):
    key = opts.get("key") or KEY
    if not key:
        raise Skip("no COMFY_API_KEY")
    if not comfy_sdk:
        raise Skip("pip install comfy-sdk")
    with comfy_sdk.Comfy(api_key=key) as c:
        graph, img_id, out_id = load_wf(name, image_title, "placeholder.png", random.randrange(2**32), opts.get("prompt"), opts.get("frames"))
        wf = c.workflows.from_json(graph)
        wf.set_input(img_id, "image", c.assets.from_bytes(img, filename="gaterun.png", content_type="image/png"))
        j = c.submit(wf)
        note(job, f"Comfy Cloud · {name} · queued")
        for ev in j.events():
            if isinstance(ev, comfy_sdk.Progress) and ev.value is not None:
                note(job, f"Comfy Cloud · {name} · {ev.value:.0%}")
            elif isinstance(ev, comfy_sdk.StatusChange):
                note(job, f"Comfy Cloud · {name} · {ev.status}")
                if ev.status in ("succeeded", "canceled", "failed", "expired"):
                    break
        j.result()  # raises JobFailed with node detail
        outs = j.get_outputs(out_id)
        if not outs:
            raise RuntimeError(f"{name} finished with no output")
        return outs[0].to_bytes()


def run_local(job, name, img, image_title, opts):
    key = opts.get("key") or KEY
    if not local_up():
        raise Skip(f"no ComfyUI at {COMFY_URL}")
    bnd = uuid.uuid4().hex
    fname = f"gaterun_{uuid.uuid4().hex[:8]}.png"
    form = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{fname}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + img + \
           f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{bnd}--\r\n".encode()
    up = json.loads(http(COMFY_URL + "/upload/image", form, {"Content-Type": f"multipart/form-data; boundary={bnd}"})[2])
    wf, _, out_id = load_wf(name, image_title, up["name"], random.randrange(2**32), opts.get("prompt"), opts.get("frames"))
    body = {"prompt": wf, "client_id": "gaterun"}
    if key:  # lets partner nodes (LTX 2.5 API, FLUX API) bill your Comfy account
        body["extra_data"] = {"api_key_comfy_org": key}
    try:
        _, _, q = http_json(COMFY_URL + "/prompt", body)
    except urllib.error.HTTPError as e:
        err = json.loads(e.read() or b"{}")
        raise RuntimeError((err.get("error") or {}).get("message") or f"queue failed {e.code}")
    pid, t0 = q["prompt_id"], time.time()
    while time.time() - t0 < 20 * 60:
        time.sleep(1.5)
        rec = http_json(f"{COMFY_URL}/history/{pid}")[2].get(pid)
        if not rec:
            note(job, f"Local ComfyUI · {name} · running")
            continue
        if rec.get("status", {}).get("status_str") == "error":
            raise RuntimeError(f"{name} failed in ComfyUI")
        o = rec.get("outputs", {}).get(out_id) or next(iter(rec.get("outputs", {}).values()), {})
        files = next((o[k] for k in ("images", "videos", "gifs", "video", "animated") if o.get(k)), [])
        if files:
            f = files[0]
            qs = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
            return http(f"{COMFY_URL}/view?{qs}", timeout=120)[2]
        if rec.get("status", {}).get("completed"):
            raise RuntimeError(f"{name} finished with no output")
    raise RuntimeError(f"{name} timed out")


def route_ready(route, key=None):
    kind = route.split(":", 1)[0]
    key = key or KEY
    if kind == "router": return bool(key)
    if kind == "cloud": return bool(key and comfy_sdk)
    return local_up()


def note(job, text):
    job["note"] = text


def work(job, stage, img, opts):
    image_title = "IN_SELFIE" if stage in ("portrait", "keyframe", "body", "arena", "arenaground") else "IN_IMAGE"
    for route in ROUTES[stage]:
        kind, target = route.split(":", 1)
        job.update(route=route, plate=False)
        note(job, f"{route} · starting")
        try:
            if opts.get("prompt") and kind == "router" and target.startswith("ltx/"):
                raise Skip("text-only plate does not fit a trailer shot")
            data = (run_router(job, target, img, opts) if kind == "router"
                    else run_cloud(job, target, img, image_title, opts) if kind == "cloud"
                    else run_local(job, target, img, image_title, opts))
            job.update(status="done", media=data, mime=sniff(data), note=f"Made with {route}")
            print(f"[{stage}] done via {route}", flush=True)
            return
        except Skip as e:
            job["tried"].append({"route": route, "skipped": str(e)})
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:300]
            job["tried"].append({"route": route, "error": msg})
            print(f"[{stage}] {route} failed, switching: {msg}", flush=True)
    job.update(status="error", note="No route worked: " + "; ".join(
        f"{t['route']} ({t.get('error') or t.get('skipped')})" for t in job["tried"]))


def gc():
    cutoff = time.time() - 30 * 60  # nothing kept past 30 minutes
    with LOCK:
        for k in [k for k, j in JOBS.items() if j["t"] < cutoff]:
            del JOBS[k]


# ---------------------------------------------------------------- high scores
# Stored in Upstash Redis over its REST API (stdlib only). Without UPSTASH_REDIS_REST_URL/TOKEN they live in
# memory and reset on restart. One entry per handle: its best score. Basic checks only; the game runs in the browser.
KV_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
KV_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
SCORES_MEM, SCORE_HITS, TOP_CACHE = {}, {}, {"t": 0, "top": None}
HANDLE_RE = {"x": re.compile(r"[A-Za-z0-9_]{1,15}"), "ig": re.compile(r"(?!\.)(?!.*\.\.)[A-Za-z0-9._]{1,30}(?<!\.)")}
BLOCKED = ("fuck", "shit", "cunt", "nigg", "fag", "rape", "nazi", "hitler", "porn", "whore", "slut", "kys")
CORS_ORIGINS = {"https://luciddreamcenter1-design.github.io"}


def kv(*cmds):
    req = urllib.request.Request(KV_URL + "/pipeline", data=json.dumps(cmds).encode(),
                                 headers={"Authorization": "Bearer " + KV_TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        out = json.load(r)
    if any("error" in o for o in out):
        raise RuntimeError("upstash error")
    return [o["result"] for o in out]


def max_score(gate):
    # generous ceiling per Gate: every Riftspawn a brute at max combo, the boss and its summons, clear bonus, shards
    return sum((6 + 3.5 * g) * 300 * (1 + .1 * g) + 150 * g + 2000 + (6000 * (1 + .1 * g) if g % 5 == 0 else 0) for g in range(1, gate + 1))


def top_scores(n=25):
    if TOP_CACHE["top"] is not None and time.time() - TOP_CACHE["t"] < 10:
        return TOP_CACHE["top"][:n]
    if KV_URL:
        ids = kv(["ZREVRANGE", "gr:scores", 0, 49])[0]
        top = [json.loads(m) for m in (kv(["HMGET", "gr:meta", *ids])[0] if ids else []) if m]
    else:
        top = sorted(SCORES_MEM.values(), key=lambda e: (-e["score"], e["t"]))[:50]
    TOP_CACHE.update(t=time.time(), top=top)
    return top[:n]


def save_score(e):
    """Keep the best score per handle; returns (rank, best) for that handle."""
    member = e["net"] + ":" + e["handle"].lower()
    if KV_URL:
        if kv(["ZADD", "gr:scores", "GT", "CH", e["score"], member])[0]:
            kv(["HSET", "gr:meta", member, json.dumps(e)])
        rank, best = kv(["ZREVRANK", "gr:scores", member], ["ZSCORE", "gr:scores", member])
        rank, best = int(rank) + 1, int(float(best))
    else:
        if member not in SCORES_MEM or e["score"] > SCORES_MEM[member]["score"]:
            SCORES_MEM[member] = e
        best = SCORES_MEM[member]["score"]
        rank = 1 + sum(1 for v in SCORES_MEM.values() if v["score"] > best)
    TOP_CACHE["top"] = None
    return rank, best


# ---------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/api/jobs/" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)

    def send_json(self, obj, status=200):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.cors()
        self.end_headers()
        self.wfile.write(raw)

    def cors(self):  # the GitHub Pages copy of the game reads and posts high scores here
        origin = self.headers.get("Origin")
        if origin in CORS_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        if self.path.split("?")[0] != "/api/scores":
            return self.send_error(404)
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def post_score(self):
        ip, now = self.client_ip(), time.time()
        hits = [t for t in SCORE_HITS.get(ip, []) if now - t < 3600]
        if len(hits) >= 20 or (hits and now - hits[-1] < 8):
            return self.send_json({"error": "slow_down"}, 429)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            assert 0 < n < 2000
            b = json.loads(self.rfile.read(n))
            net, handle = b["net"], str(b["handle"]).strip().lstrip("@")
            score, gate, secs = int(b["score"]), int(b["gate"]), float(b["time"])
            assert net in HANDLE_RE and HANDLE_RE[net].fullmatch(handle)
        except Exception:
            return self.send_json({"error": "bad_handle"}, 400)
        if any(w in handle.lower() for w in BLOCKED):
            return self.send_json({"error": "bad_handle"}, 400)
        if not (1 <= gate <= 999 and 0 < score <= max_score(gate) and secs >= 4 * (gate - 1)):
            return self.send_json({"error": "bad_score"}, 400)
        SCORE_HITS[ip] = hits + [now]
        crasher = str(b.get("crasher") or "")
        e = {"net": net, "handle": handle, "score": score, "gate": gate, "combo": max(0, min(9999, int(b.get("combo") or 0))),
             "crasher": crasher if crasher in ("ren", "kira", "brann", "vex", "you") else "", "t": int(now)}
        try:
            rank, best = save_score(e)
            return self.send_json({"rank": rank, "best": best, "top": top_scores(10)})
        except Exception:
            return self.send_json({"error": "scores_unavailable"}, 503)

    def visitor_key(self):
        k = (self.headers.get("X-Comfy-Key") or "").strip()
        return k if k.startswith("comfyui-") and len(k) < 200 else None

    def client_ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def free_left(self):
        day = time.strftime("%Y-%m-%d")
        return (max(0, FREE_JOBS_PER_IP - USAGE.get((day, self.client_ip()), 0)), max(0, FREE_JOBS_PER_DAY - USAGE.get(day, 0)))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/status":
            vk = self.visitor_key()
            tier = "own" if vk else ("free" if FREE_LIMITS and KEY else ("host" if KEY else "none"))
            return self.send_json({
                "server": True, "key": bool(KEY or vk), "sdk": getattr(comfy_sdk, "__version__", None) if comfy_sdk else None,
                "local": local_up(), "tier": tier, "free_left": min(self.free_left()) if tier == "free" else None,
                "routes": {s: [{"route": r, "ready": route_ready(r, vk)} for r in rs] for s, rs in ROUTES.items()},
            })
        if path == "/api/scores":
            try:
                return self.send_json({"top": top_scores(), "persistent": bool(KV_URL)})
            except Exception:
                return self.send_json({"error": "scores_unavailable"}, 503)
        m = re.fullmatch(r"/api/(jobs|media)/([\w-]+)", path)
        if m:
            job = JOBS.get(m.group(2))
            if not job:
                return self.send_json({"error": "unknown job"}, 404)
            if m.group(1) == "jobs":
                return self.send_json({k: job.get(k) for k in ("status", "route", "note", "tried", "plate", "mime")})
            if job["status"] != "done":
                return self.send_json({"error": "not ready"}, 409)
            self.send_response(200)
            self.send_header("Content-Type", job["mime"])
            self.send_header("Content-Length", str(len(job["media"])))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(job["media"])
            return
        if path in ("/", "/index.html", "/app"):  # page lives at /app/ so its relative assets resolve
            self.send_response(302)
            self.send_header("Location", "/app/" + (self.path[len(path):] or ""))
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/scores":
            return self.post_score()
        if self.path != "/api/forge":
            return self.send_error(404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            stage = body["stage"]
            assert stage in ROUTES
            opts = {}
            if stage == "arena":   # the player's own place -> battle arena (16:9)
                opts.update(prompt=ARENAS["upload"].replace("{style}", ARENAS["style"]), aspect="16:9")
            if stage == "arenaground":   # top-down floor texture for the player's arena room
                opts.update(prompt=ARENAS["ground"].replace("{style}", ARENAS["style"]), aspect="1:1")
            if stage == "arenaloop":
                opts.update(prompt=ARENAS["motion"].replace("{style}", ARENAS["style"]))
            if stage in ("body", "move"):
                ch = MOVESET["characters"][body["char"]]
                if stage == "body":
                    opts.update(prompt=ch["keyframe"].replace("{green}", MOVESET["green"]), aspect="2:3")
                else:
                    mv = ch["moves"][body["move"]]
                    opts.update(prompt=mv["motion"], frames=int(mv["frames"]))
            if stage == "voice":
                name = re.sub(r"[^\w .'-]", "", str(body.get("name") or "Hunter"))[:24] or "Hunter"
                opts["text"] = TRAILER["narration"].replace("{name}", name)
                img = b""
            elif stage == "body" and not body.get("image"):
                img = b""  # enemies: text-to-image
            else:
                img = base64.b64decode(body["image"].split(",", 1)[-1])
                assert 0 < len(img) < 40 * 1024 * 1024
            if body.get("shot") is not None:  # trailer shot: keyframe prompt or motion prompt
                shot = TRAILER["shots"][int(body["shot"])]
                opts["prompt"] = shot["keyframe" if stage == "keyframe" else "motion"]
                assert opts["prompt"] or stage == "clip"
        except Exception:
            return self.send_json({"error": "send {stage, image: dataURL, shot?, name?}"}, 400)
        vk = self.visitor_key()
        if vk:
            opts["key"] = vk          # used for this job only, never logged or stored
        elif FREE_LIMITS and KEY:
            per_ip, per_day = self.free_left()
            if per_ip <= 0 or per_day <= 0:
                return self.send_json({"error": "free_limit", "detail": "Free tries are used up for today. Add your own Comfy key to keep going."}, 429)
            day = time.strftime("%Y-%m-%d"); USAGE[(day, self.client_ip())] = USAGE.get((day, self.client_ip()), 0) + 1; USAGE[day] = USAGE.get(day, 0) + 1
        gc()
        jid = uuid.uuid4().hex
        JOBS[jid] = {"t": time.time(), "status": "running", "route": None, "note": "queued", "tried": [], "plate": False}
        threading.Thread(target=work, args=(JOBS[jid], stage, img, opts), daemon=True).start()
        self.send_json({"job": jid})


if __name__ == "__main__":
    print(f"Gate Run on http://localhost:{PORT}")
    print(f"  Comfy key: {'yes' if KEY else 'no (Router/Cloud off)'} · comfy-sdk: {'yes' if comfy_sdk else 'no'} · local ComfyUI {COMFY_URL}: {'up' if local_up() else 'down'}")
    for s, rs in ROUTES.items():
        print(f"  {s:8} " + " -> ".join(f"{r}{'' if route_ready(r) else ' (off)'}" for r in rs))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
