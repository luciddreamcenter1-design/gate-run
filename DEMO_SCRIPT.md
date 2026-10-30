# Gate Run: 2-minute demo video

**Logline:** One selfie in, a personal anime trailer and a playable game out, every time, for every player. Filmmakers make one film; this makes a film for everyone who opens the link.

**Format:** 1920×1080 master (judges watch on laptops) with the 9:16 app footage centered on a dark background; also export a 9:16 cut for socials.
**Audio bed:** `app/audio/music_loop.mp3` under everything at about −18 dB, ducked under voice-over. Use `sfx_braam.mp3` on the hard cuts marked ▲.

---

## Before you record

1. Run `python3 server.py`, open Chrome at `http://localhost:8080` in a 430×900 window (DevTools device mode: iPhone 15 Pro works).
2. Do two or three warm-up runs with **friends' selfies (with permission)** so you have different trailers and Reels for the montage. Save each Reel (`Make my Reel`) and trailer (`Save my trailer`).
3. Screen-record with OBS (Window Capture, 60 fps). Record your own run in one take: selfie → forge → trailer → play → boss → license → Reel.
4. Open `workflows/gate_clip_ltx2_lora_api.json` in ComfyUI (drag the file onto the canvas) for the under-the-hood shot.

---

## Shot list

| Time | Picture | Sound / words |
|---|---|---|
| **0:00–0:13** | **Cold open:** your auto-generated trailer, full screen, no UI. Card "A GATE HAS OPENED", then the three shots, then the end card with your face. | The trailer's own mix: narrator, riser, ▲ braam. No VO. |
| 0:13–0:17 | Hard cut to black. White text: *"Ninety seconds ago, that was this."* | Silence, then a single `sfx_whoosh`. |
| 0:17–0:26 | The Forge screen: the selfie sliding into the Gatecrasher. Hold on the side-by-side. | VO: "One selfie. FLUX 3 keeps your face and makes you a Crasher." |
| 0:26–0:34 | Speed-ramped (2×) progress: "Directing your trailer" and "Animating your Crasher · 5/5 moves". Cut in a sprite sheet of your combo. | VO: "Then LTX-2 animates you: three trailer shots, and every move you make in the game." |
| ▲ 0:34–0:52 | **Gameplay:** your full-body manhwa Crasher (your face, LTX-animated) running and chaining the 3-hit combo, the combo counter climbing, an enemy telegraph you dash through, then the **GATE SLASH** special. Then the **boss entrance** (letterbox, slow motion, "BREACH LORD"). | Game audio only: slashes, hits, "[RIFT OS] Warning. Breach Lord detected." |
| 0:52–1:00 | Boss defeated (white flash, slow-mo push-in), Crasher Pass card with gate badge. | `sfx_win`, narrator "Gate cleared." |
| 1:00–1:08 | Tap **Make my Reel**: the Reel plays and renders on device, then the phone share sheet. | VO: "One tap: a vertical Reel of your trailer and your run, ready to post." |
| 1:08–1:38 | **Under the hood** (screen recording, slow pans): (1) the LTX-2 + LoRA graph in ComfyUI with the `IN_IMAGE`, `IN_PROMPT`, `IN_LORA`, `OUT` titles highlighted; (2) `workflows/trailer.json`, the editable shot list; (3) `server.py` console showing the route chain and a route switch; (4) this diagram: | VO: "Two Comfy APIs, one SDK. Comfy Router for FLUX 3 keyframes, ElevenLabs voice and sound, and video upscaling. Comfy Cloud runs the actual ComfyUI workflow: LTX-2 with a camera LoRA. If a route fails, the server switches to the next one. The shot list is a JSON file, so you can direct your own trailer." |
| | `selfie → Router: FLUX 3 → Crasher → Router: FLUX 3 keyframes ×2 → Cloud: LTX-2 + LoRA ×3 (parallel) → Router: upscale → in-browser edit: cards, grade, voice, SFX → trailer + Reel` | |
| ▲ 1:38–1:52 | **Montage:** 3–4 different players' trailers, cut on the braam, each ending on their end card. | Music up. No VO. |
| 1:52–2:00 | End card: "GATE RUN · open source · #OpenSourceHiggsfield", repo URL, "Clone it. Run it on your own ComfyUI." | Final ▲ braam, music out. |

---

## Lines to keep it honest
- Say "LTX-2" (the video model) and "Comfy Cloud" (where it runs); LTX is the core video model in the clip workflow.
- Mention it is open source (MIT) and runs on your own ComfyUI too (`local:` routes).
- If you show a friend's face, get their OK; the demo face in `demo/` is AI-generated.

## Social post (Most Viral)
Post your Reel (9:16, under 20 s) with:
> I took a selfie and got my own anime trailer and a game where I'm the hero. Open source, built on ComfyUI (FLUX 3 + LTX-2). Try it: <link> #OpenSourceHiggsfield
