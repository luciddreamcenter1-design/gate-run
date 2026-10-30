/* Director: plays a timeline of segments on a 1080x1920 canvas with a film finish
   (grade, grain, vignette, letterbox, title cards) and the shared audio mix, and can
   record the result. Used for the personalized trailer and the one-tap Reel.

   Segment types:
     { type: 'card',  dur, text, sub?, sfx? }
     { type: 'video', src, use: [in, out], card?, sfx?, flash?, kenburns? }
     { type: 'image', img, dur, sfx?, flash? }
     { type: 'end',   dur, sfx? }
   Options: { layer, segments, narration?, record?, onSkip? } -> Promise<Blob|null>  */
const Director = (() => {
  const CW = 1080, CH = 1920, FPS = 30;
  const grain = (() => { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'), d = x.createImageData(256, 256);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } x.putImageData(d, 0, 0); return c; })();

  function pickMime() {
    if (!window.MediaRecorder) return null;
    return ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || null;
  }

  function loadVideo(src) {
    return new Promise((res, rej) => {
      const v = document.createElement('video'); v.src = src; v.preload = 'auto'; v.playsInline = true; v.crossOrigin = 'anonymous';
      v.onloadeddata = () => res(v); v.onerror = () => rej(new Error('video failed: ' + src)); v.load();
    });
  }

  function cover(x, el, w, h, k = 1) {
    const sw = el.videoWidth || el.naturalWidth || el.width, sh = el.videoHeight || el.naturalHeight || el.height;
    const s = Math.max(CW / sw, CH / sh) * k, dw = sw * s, dh = sh * s;
    x.drawImage(el, (CW - dw) / 2, (CH - dh) / 2, dw, dh);
  }

  function title(x, text, sub, a, t, y = .5) {
    if (a <= 0) return;
    x.save(); x.globalAlpha = a; x.textAlign = 'center';
    const s = 1 + (1 - a) * .06 + t * .015; x.translate(CW / 2, CH * y); x.scale(s, s);
    x.shadowColor = 'rgba(56,214,255,.9)'; x.shadowBlur = 40;
    x.fillStyle = '#eef0ff';
    let px = 96; const fit = () => { x.font = `700 ${px}px "Chakra Petch"`; if ('letterSpacing' in x) x.letterSpacing = Math.round(px * .14) + 'px'; };
    fit(); while (px > 40 && x.measureText(text).width > CW * .86) { px -= 4; fit(); }
    x.fillText(text, 0, 0);
    x.shadowBlur = 0; x.fillStyle = '#38d6ff'; x.fillRect(-180 * a, 36, 360 * a, 4);
    if (sub) { x.font = '600 40px "Chakra Petch"'; if ('letterSpacing' in x) x.letterSpacing = '8px'; x.fillStyle = '#9fe8ff'; x.fillText(sub, 0, 104); }
    x.restore();
  }

  function finish(x, t, bars) {
    const v = x.createRadialGradient(CW / 2, CH / 2, CH * .25, CW / 2, CH / 2, CH * .75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)'); x.fillStyle = v; x.fillRect(0, 0, CW, CH);
    x.save(); x.globalAlpha = .07; x.globalCompositeOperation = 'overlay';
    const ox = Math.random() * 256, oy = Math.random() * 256;
    for (let yy = -oy; yy < CH; yy += 256) for (let xx = -ox; xx < CW; xx += 256) x.drawImage(grain, xx, yy);
    x.restore();
    const b = CH * .055 * bars; x.fillStyle = '#000'; x.fillRect(0, 0, CW, b); x.fillRect(0, CH - b, CW, b);
  }

  function endCard(x, t, seg) {
    const g = x.createRadialGradient(CW / 2, CH * .42, 20, CW / 2, CH * .42, CH * .7);
    g.addColorStop(0, '#3a2a8a'); g.addColorStop(.35, '#140f33'); g.addColorStop(1, '#05040b'); x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    const a = Math.min(1, t / .5);
    if (seg.portrait) { const r = 230; x.save(); x.globalAlpha = a; x.beginPath(); x.arc(CW / 2, CH * .36, r, 0, 6.283); x.clip(); x.drawImage(seg.portrait, CW / 2 - r, CH * .36 - r, r * 2, r * 2); x.restore();
      x.save(); x.globalAlpha = a; x.strokeStyle = '#38d6ff'; x.lineWidth = 8; x.shadowColor = '#38d6ff'; x.shadowBlur = 40; x.beginPath(); x.arc(CW / 2, CH * .36, r, 0, 6.283); x.stroke(); x.restore(); }
    x.save(); x.globalAlpha = a; x.textAlign = 'center';
    x.fillStyle = '#38d6ff'; x.font = '600 44px "Chakra Petch"'; if ('letterSpacing' in x) x.letterSpacing = '16px'; x.fillText('GATECRASHERS', CW / 2, CH * .6);
    x.fillStyle = '#eef0ff'; x.font = '700 120px "Chakra Petch"'; if ('letterSpacing' in x) x.letterSpacing = '6px'; x.fillText('GATE RUN', CW / 2, CH * .6 + 130);
    if (seg.line) { x.fillStyle = '#ffd84a'; x.font = '700 52px "Chakra Petch"'; x.fillText(seg.line, CW / 2, CH * .6 + 220); }
    x.fillStyle = '#eef0ff'; x.font = '700 50px "Chakra Petch"'; if ('letterSpacing' in x) x.letterSpacing = '2px'; x.fillText('HOW MANY GATES CAN YOU CRASH?', CW / 2, CH * .6 + 300);
    x.fillStyle = '#38d6ff'; x.font = '600 34px Inter'; if ('letterSpacing' in x) x.letterSpacing = '0px';
    x.fillText((typeof PLAY_URL === 'string' ? PLAY_URL : '').replace(/^https?:\/\//, '').replace(/\/$/, ''), CW / 2, CH * .6 + 352);
    x.fillStyle = '#9a9cc4'; x.font = '500 34px Inter'; x.fillText('Made with ComfyUI · FLUX 3 + LTX-2', CW / 2, CH * .86);
    x.fillStyle = '#ffd84a'; x.font = '700 44px "Chakra Petch"'; x.fillText('#OpenSourceHiggsfield', CW / 2, CH * .86 + 64);
    x.restore();
  }

  async function play({ layer, segments, narration, record }) {
    await document.fonts.ready;
    AK.init();
    const ctxA = AK.ctx;
    if (ctxA && ctxA.state === 'suspended') await ctxA.resume().catch(() => {});
    // preload media
    for (const s of segments) if (s.type === 'video') s.el = await loadVideo(s.src);
    const narr = narration && ctxA ? await fetch(narration).then(r => r.arrayBuffer()).then(b => ctxA.decodeAudioData(b)).catch(() => null) : null;

    const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH; cv.className = 'directorCanvas';
    const x = cv.getContext('2d');
    layer.querySelectorAll('img,video,canvas,.plateHunter').forEach(n => n.remove()); layer.prepend(cv); layer.classList.add('on');

    let t0 = 0; const starts = []; for (const s of segments) { starts.push(t0); s.dur = s.dur ?? (s.use[1] - s.use[0]); t0 += s.dur; }
    const total = t0;

    let rec = null, chunks = [], vt = null, lastPush = 0;
    const mime = record && pickMime();
    if (mime) {
      const stream = cv.captureStream(0);   // frames pushed manually: reliable even when the compositor throttles
      vt = stream.getVideoTracks()[0];
      if (AK.recDest) AK.recDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 9e6 });
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.start(250);
    }
    AK.music(.28);
    if (narr) AK.playBuffer(narr, 1.15, .25), AK.duck(.25, narr.duration);

    const clock = () => ctxA ? ctxA.currentTime : performance.now() / 1000;
    const begin = clock();
    let cur = -1, skipped = false;
    return new Promise(resolve => {
      const done = () => {
        if (cur === 'done') return; cur = 'done';
        segments.forEach(s => s.el && s.el.pause());
        AK.musicOff(.4);
        layer.classList.remove('on');
        if (!rec) return resolve(null);
        rec.onstop = () => resolve(skipped ? null : new Blob(chunks, { type: mime.split(';')[0] }));
        rec.stop();
      };
      const skip = document.getElementById('skip');
      if (skip) skip.onclick = () => { skipped = true; done(); };
      const frame = () => {
        if (cur === 'done') return;
        const t = clock() - begin;
        if (t >= total) return done();
        let i = starts.length - 1; while (starts[i] > t) i--;
        const s = segments[i], lt = t - starts[i];
        if (i !== cur) {   // segment start
          if (cur >= 0 && segments[cur].el) segments[cur].el.pause();
          cur = i;
          if (s.sfx) AK.play(s.sfx, s.sfxVol ?? .9);
          if (s.el) {
            s.el.currentTime = s.use[0]; s.el.muted = false;
            if (!s.el._routed && ctxA) { try { const src = ctxA.createMediaElementSource(s.el), gn = ctxA.createGain(); gn.gain.value = s.vol ?? .8; src.connect(gn).connect(AK.master); s.el._routed = true; } catch (e) {} }
            s.el.play().catch(() => { s.el.muted = true; s.el.play().catch(() => {}); });
          }
        }
        x.filter = 'none'; x.fillStyle = '#000'; x.fillRect(0, 0, CW, CH);
        if (s.type === 'card') {
          title(x, s.text, s.sub, Math.min(1, lt / .35) * Math.min(1, (s.dur - lt) / .3), lt);
        } else if (s.type === 'end') {
          endCard(x, lt, s);
        } else {
          const el = s.el || s.img;
          if ('filter' in x) x.filter = 'contrast(1.1) saturate(1.15)';
          cover(x, el, CW, CH, s.kenburns ? 1 + lt * .02 : 1);
          x.filter = 'none';
          if (s.card) { const a = Math.min(1, Math.max(0, (lt - .6) / .35)) * Math.min(1, Math.max(0, (s.dur - .5 - lt) / .35)); title(x, s.card, s.sub, a, lt, .8); }
        }
        if (s.flash && lt < .18) { x.fillStyle = `rgba(255,255,255,${1 - lt / .18})`; x.fillRect(0, 0, CW, CH); }
        finish(x, t, s.type === 'end' ? 0 : 1);
        if (vt && vt.requestFrame && t - lastPush >= 1 / FPS - .002) { vt.requestFrame(); lastPush = t; }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  return { play, pickMime };
})();
window.Director = Director;
