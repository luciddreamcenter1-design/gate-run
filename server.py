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

ROUTES = {
    "portrait": os.environ.get("PORTRAIT_ROUTES",
        "router:bfl/flux-3-image,router:bfl/flux-kontext-pro,local:hunter_portrait_api.json"),
    "clip": os.environ.get("CLIP_ROUTES",
        "cloud:gate_clip_ltx2_lora_api.json,cloud:gate_clip_ltx25_api.json,"
        "local:gate_clip_ltx25_api.json,local:gate_clip_api.json,router:ltx/ltx-2-5-fast"),
}
ROUTES["keyframe"] = os.environ.get("KEYFRAME_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
ROUTES["voice"] = os.environ.get("VOICE_ROUTES", "router:elevenlabs/eleven_v3,router:elevenlabs/eleven_multilingual_v2")
ROUTES["body"] = os.environ.get("BODY_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
ROUTES["move"] = os.environ.get("MOVE_ROUTES", "cloud:moves_ltx2_api.json,local:moves_ltx2_api.json")
ROUTES["arena"] = os.environ.get("ARENA_ROUTES", "router:bfl/flux-3-image,router:bfl/flux-kontext-pro")
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
    if not KEY:
        raise Skip("no COMFY_API_KEY")
    body, plate = router_body(model, base64.b64encode(img).decode(), opts)
    job["plate"] = plate
    sync = model.startswith("elevenlabs/")  # Router serves these on the synchronous route only
    if comfy_sdk and sync:
        note(job, f"Comfy Router · {model} · running")
        with comfy_sdk.Comfy(api_key=KEY) as c:
            result = c.models.run(model, body)
        if isinstance(result, comfy_sdk.BinaryResult):
            return result.content
    elif sync:
        note(job, f"Comfy Router · {model} · running")
        return http(f"{ROUTER}/v2/models/{model}", json.dumps(body).encode(),
                    {"X-API-Key": KEY, "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())}, timeout=180)[2]
    elif comfy_sdk:  # SDK: queued submit, poll with server-named Retry-After, typed errors
        with comfy_sdk.Comfy(api_key=KEY) as c:
            h = c.models.submit(model, body)
            for u in h.iter_events():
                note(job, f"Comfy Router · {model} · {u.status.lower().replace('_', ' ')}"
                          + (f" #{u.queue_position}" if u.queue_position else ""))
            result = h.get()
        if isinstance(result, comfy_sdk.BinaryResult):
            return result.content
    else:  # plain HTTP, same queue routes
        base, hdr = f"{ROUTER}/v2/models/{model}/requests", {"X-API-Key": KEY}
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
    url = find_url(result.get("result", result) if isinstance(result, dict) else result)
    if not url:
        raise RuntimeError(f"{model} returned no media")
    return http(url, timeout=180)[2]


def run_cloud(job, name, img, image_title, opts):
    if not KEY:
        raise Skip("no COMFY_API_KEY")
    if not comfy_sdk:
        raise Skip("pip install comfy-sdk")
    with comfy_sdk.Comfy(api_key=KEY) as c:
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
    if KEY:  # lets partner nodes (LTX 2.5 API, FLUX API) bill your Comfy account
        body["extra_data"] = {"api_key_comfy_org": KEY}
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


def route_ready(route):
    kind = route.split(":", 1)[0]
    if kind == "router": return bool(KEY)
    if kind == "cloud": return bool(KEY and comfy_sdk)
    return local_up()


def note(job, text):
    job["note"] = text


def work(job, stage, img, opts):
    image_title = "IN_SELFIE" if stage in ("portrait", "keyframe", "body", "arena") else "IN_IMAGE"
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
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/status":
            return self.send_json({
                "server": True, "key": bool(KEY), "sdk": getattr(comfy_sdk, "__version__", None) if comfy_sdk else None,
                "local": local_up(),
                "routes": {s: [{"route": r, "ready": route_ready(r)} for r in rs] for s, rs in ROUTES.items()},
            })
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
        if self.path != "/api/forge":
            return self.send_error(404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            stage = body["stage"]
            assert stage in ROUTES
            opts = {}
            if stage == "arena":   # the player's own place -> battle arena (16:9)
                opts.update(prompt=ARENAS["upload"].replace("{style}", ARENAS["style"]), aspect="16:9")
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
