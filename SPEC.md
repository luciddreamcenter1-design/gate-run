# Gate Run: Spec

**One line:** Take a selfie, become an anime hunter, watch a Gate tear open behind you, then play as yourself.

**Entry for:** Comfy "Open Source Higgsfield" (submissions close Oct 30, 9am PT)
**Targets:** Best Overall, Most Viral, LTX VFX bonus ($2,000)
**Also markets:** Gatecrashers (the full game)

---

## 1. The point

The player should **see themselves in the game.** Every screen exists to serve that:

| Moment | What the player sees |
|---|---|
| Forge | Their selfie next to their anime hunter version |
| Gate clip | Their hunter, with a Gate opening behind them, stepping through |
| Play | Their face as the character's head, plus in the HUD |
| End | A Hunter License card with their face, name and rank, ready to post |

## 2. User flow

```
Selfie ──▶ ComfyUI #1 (FLUX edit) ──▶ Anime hunter portrait
                                         │
                                         ├──▶ ComfyUI #2 (LTX image-to-video) ──▶ Gate opening clip
                                         │        (renders in background)
                                         ▼
                                   75-second Gate run as yourself
                                         ▼
                              Hunter License (PNG) + Gate clip (WebP)
```

1. **Start:** enter a hunter name, take or upload a selfie (or play as a guest hunter).
2. **Forge:** the selfie uploads to ComfyUI, runs the portrait workflow, returns the hunter.
3. **Gate clip:** the hunter image goes into the LTX workflow. It renders while the player plays. If it finishes before they press Enter, it plays as the intro. Otherwise it is waiting on the end screen.
4. **Play:** 75 seconds. The Gate spawns shadow monsters. A Gate Boss shows up with 22 seconds left.
5. **End:** rank (E to S), Hunter License card, save buttons, run again.

## 3. ComfyUI workflows (required for the contest)

Both live in `workflows/` in ComfyUI **API format**. The app finds nodes by **title**, not by node ID, so any workflow with these titles works.

| Title | Node | What the app sets |
|---|---|---|
| `IN_SELFIE` | LoadImage | uploaded selfie filename |
| `IN_IMAGE` | LoadImage | uploaded hunter filename |
| `IN_PROMPT` | CLIPTextEncode | (left as-is; edit the prompt in the JSON) |
| `IN_SEED` | KSampler or RandomNoise | random seed each run |
| `OUT` | SaveImage / SaveAnimatedWEBP / SaveVideo | output the app downloads |

### Workflow 1: Hunter portrait (`hunter_portrait_api.json`)
- **Model:** FLUX.1 Kontext dev (image edit with a reference image), core ComfyUI nodes
- **Prompt goal:** keep face shape, skin tone, hair and expression so the person is recognizable; add a hunter coat with cyan trim and a blade; night city background
- **Settings:** 20 steps, euler / simple, guidance 2.5
- **Upgrade path:** swap in the FLUX 3 edit template from ComfyUI's template browser, title the nodes, export API. That also qualifies for the FLUX 3 bonus.

### Workflow 2: Gate opening clip (`gate_clip_api.json`)
- **Model:** LTX-Video image-to-video, core ComfyUI nodes (`LTXVImgToVideo`, `LTXVConditioning`, `LTXVScheduler`)
- **Output:** 512 × 768 vertical, 97 frames at 24 fps (about 4 seconds), animated WebP
- **Prompt goal:** a rift of blue and violet light tears open behind the hunter, wind in their coat, they turn and step through
- **Upgrade path:** swap in the current LTX template (LTX 2.5) the same way. **LTX must stay the core video model for the $2,000 bonus.**

## 4. The game

| Item | Rule |
|---|---|
| Length | 75 seconds |
| Controls | WASD / arrows or hold the mouse to move; touch: drag anywhere; Space or DASH button to dash |
| Attack | Automatic slash at the nearest enemy (keeps it playable for kids and on phones) |
| Enemies | Imp (fast, 1 hit), Brute (slow, 4 hits), Gate Boss (30 hits, appears at 0:22) |
| Health | 5 hearts, short invincibility after a hit, dash is also invincible |
| Progress | Enemies drop mana shards; shards level you up (faster attacks, a heart back every 2 levels) |
| Score | Imp 25, Brute 80, Boss 600, shard 10, +100 per heart left if you clear the Gate |
| Rank | E 0 · D 400 · C 900 · B 1,500 · A 2,300 · S 3,200 |
| System text | `[SYSTEM] A Gate has opened.` · `Level up.` · `Gate Boss detected.` |

## 5. Share outputs (built for Most Viral)
- **Hunter License:** 1080 × 1350 PNG (Instagram 4:5). Face, name, rank badge, score, kills, level, `#OpenSourceHiggsfield`.
- **Gate clip:** vertical WebP straight from LTX, ready for Reels / TikTok / Shorts.

## 6. Modes
| Mode | When | Hunter image | Gate clip |
|---|---|---|---|
| ComfyUI | Served by `server.py` with ComfyUI running | FLUX output | LTX output |
| Preview | Opened as a static page (no ComfyUI) | In-browser toon filter of the selfie | Built-in animated Gate |

Preview mode exists so judges and friends can play from a link. The demo video shows ComfyUI mode.

## 7. Tech
- **Front end:** one HTML file, canvas 2D, no build step, no dependencies
- **Server:** `server.py`, Python standard library only. Serves the game and proxies `/comfy/*` to ComfyUI (no CORS setup needed). Optional `COMFY_API_KEY` for hosted endpoints.
- **ComfyUI calls:** `POST /upload/image` → `POST /prompt` → poll `GET /history/{id}` → `GET /view`
- **Privacy:** selfies go only to the ComfyUI server you point it at. Nothing is stored by the app.

## 8. Rules check (from the Build Night card)
- [x] Built with ComfyUI (both generation steps are ComfyUI workflows)
- [x] Open-source license (MIT) and setup steps anyone can run
- [x] Lawful and SFW; the player uses their own face, the characters are original
- [ ] GitHub repo pushed
- [ ] Demo video, 2 minutes max
- [ ] Link to try (published preview build)
- [ ] Social post with `#OpenSourceHiggsfield`
- [ ] Entry form before Oct 30, 9am PT

## 9. Demo video script (under 2 minutes)
1. **0:00** Hook: "This is me. This is me as a hunter." Selfie to hunter side by side.
2. **0:10** The Gate clip plays full screen.
3. **0:20** Gameplay, my face on the character, Gate Boss fight.
4. **0:55** Hunter License card at the end.
5. **1:05** Under the hood: the two ComfyUI graphs (FLUX edit, LTX image-to-video), the node-title contract, `server.py` proxy.
6. **1:40** "Clone it, run it on your own ComfyUI." Repo link, `#OpenSourceHiggsfield`.

## 10. Next (after the contest)
- Swap the toon filter for a small open model so preview mode looks closer to the real thing
- 3-pose character sheet from the portrait so the body matches the face
- Carry the hunter into Gatecrashers as an unlockable skin
