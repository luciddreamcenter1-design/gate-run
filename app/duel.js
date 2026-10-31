/* Online 1v1 by link. Peer-to-peer over WebRTC (PeerJS for signaling, no game server).
   The host simulates both Crashers and streams state ~30 Hz; the guest sends inputs and draws the host's state.
   Positions are relative to the arena centre so screens of different sizes see the same fight.
   Uses globals from index.html (P, enemies, S, mode, keys, joy, AK, burst, floatText, slashes, COMBO, ...). */
const Duel = (() => {
  const AW = 330, AH = 230, HP = 100, SEND_MS = 33;
  const DMG = { 1: 8, 2: 8, 3: 15, sp: 28 };
  let peer = null, conn = null, role = null, F = null, events = [], phase = 'idle', phaseT = 0, winner = -1;
  let myIn = null, remIn = null, sendT = 0, rival = null, rivalName = 'Rival', rivalPortrait = null, resultCard = null, rematchAsked = false;
  let rivalRoster = null, rivalQuote = '', vsFlags = {};
  const COUNT = 4.2;

  const mkF = side => ({ x: side ? 150 : -150, y: 0, face: side ? -1 : 1, state: 'free', st: 0, step: 0, buf: false, comboT: 0, hp: HP, sp: 0,
    inv: 0, flash: 0, vx: 0, hit: 0, dashCD: 0, ddx: 0, ddy: 0, hitDone: false, moving: false, a: 0, d: 0, s: 0, anim: { name: 'idle', t: 0, p: undefined } });
  const newIn = () => ({ mx: 0, my: 0, atk: 0, dash: 0, sp: 0 });
  const meIdx = () => role === 'host' ? 0 : 1;

  /* ---------- simulation (host) ---------- */
  function step(f, inp, o, dt, idx) {
    f.st += dt; f.dashCD -= dt; f.inv -= dt; f.flash -= dt; f.comboT -= dt; f.hit -= dt;
    const free = f.state === 'free';
    if (inp.dash > f.d) { f.d = inp.dash; if (f.dashCD <= 0 && f.state !== 'sp') { const m = Math.hypot(inp.mx, inp.my); f.ddx = m > .1 ? inp.mx / m : f.face; f.ddy = m > .1 ? inp.my / m : 0; if (Math.abs(f.ddx) > .2) f.face = Math.sign(f.ddx); f.state = 'dash'; f.st = 0; f.dashCD = .55; f.inv = .28; events.push({ k: 'dash', i: idx }); } }
    if (inp.sp > f.s) { f.s = inp.sp; if (f.sp >= 100 && f.state !== 'sp' && f.state !== 'hurt') { f.state = 'sp'; f.st = 0; f.sp = 0; f.hitDone = false; f.inv = 1.2; events.push({ k: 'spstart', i: idx }); } }
    if (inp.atk > f.a) { f.a = inp.atk;
      if (f.state === 'free') attack(f, o, f.comboT > 0 && f.step < 3 ? f.step + 1 : 1, idx);
      else if (f.state === 'atk') f.buf = true;
      else if (f.state === 'dash' && f.st > .06) attack(f, o, 3, idx); }
    f.moving = false;
    if (f.state === 'free') {
      f.x += inp.mx * 250 * dt; f.y += inp.my * 210 * dt; f.moving = Math.hypot(inp.mx, inp.my) > .1;
      if (Math.abs(inp.mx) > .15) f.face = Math.sign(inp.mx); else if (!f.moving) f.face = Math.sign(o.x - f.x) || f.face;
      setA(f, f.moving ? 'run' : 'idle', T);
    } else if (f.state === 'atk') {
      const c = COMBO[f.step];
      if (f.st < c.dur * .45) f.x += f.face * c.lunge * .7 * dt * (1 - f.st / (c.dur * .45));
      if (!f.hitDone && f.st >= c.hit) { f.hitDone = true; strike(f, o, c, DMG[f.step], idx); }
      setA(f, 'combo', 0, ((f.step - 1) + Math.min(1, f.st / c.dur)) / 3);
      if (f.st >= c.dur) { if (f.buf && f.step < 3) attack(f, o, f.step + 1, idx); else { f.state = 'free'; f.comboT = .5; } }
    } else if (f.state === 'dash') {
      f.x += f.ddx * 820 * dt; f.y += f.ddy * 640 * dt; setA(f, 'dash', 0, Math.min(1, f.st / .2) * .7 + .15);
      if (f.st >= .2) f.state = 'free';
    } else if (f.state === 'sp') {
      setA(f, 'special', 0, Math.min(1, f.st / .6));
      if (!f.hitDone && f.st >= .3) { f.hitDone = true; const dx = o.x - f.x; events.push({ k: 'spfire', i: idx });
        if (dx * f.face > -60 && Math.abs(dx) < 520 && Math.abs(o.y - f.y) < 220) hurt(o, f, DMG.sp, 620, .7, idx, true); }
      if (f.st >= .6) f.state = 'free';
    } else if (f.state === 'hurt') {
      f.x += f.vx * dt; f.vx *= Math.pow(.86, dt * 60); setA(f, 'idle', 0);
      if (f.st >= (f.long ? .55 : .3)) f.state = 'free';
    }
    f.x = clamp(f.x, -AW, AW); f.y = clamp(f.y, -AH, AH);
    // keep them from overlapping
    const sx = o.x - f.x, sy = o.y - f.y, sd = Math.hypot(sx, sy * 1.4);
    if (sd < 40 && f.state !== 'dash') { f.x -= sx / (sd || 1) * 40 * dt; f.y -= sy / (sd || 1) * 30 * dt; }
  }
  function setA(f, name, t, p) { f.anim.name = name; f.anim.t = t; f.anim.p = p; }
  function attack(f, o, s, idx) {
    if (Math.abs(o.x - f.x) > 6 && Math.abs(o.x - f.x) < 260) f.face = Math.sign(o.x - f.x);
    Object.assign(f, { state: 'atk', step: s, st: 0, buf: false, hitDone: false });
    events.push({ k: 'swing', i: idx, s });
  }
  function strike(f, o, c, dmg, idx) {
    const dx = o.x - f.x;
    if (dx * f.face < -12 || Math.abs(dx) > c.range + 22 || Math.abs(o.y - f.y) > c.depth + 12) return;
    hurt(o, f, dmg, c.kb * .6, c.launch ? .55 : .3, idx, !!c.launch);
  }
  function hurt(o, f, dmg, kb, stun, idx, big) {
    if (o.inv > 0 || o.state === 'dash') { events.push({ k: 'miss', i: 1 - idx }); return; }
    o.hp = Math.max(0, o.hp - dmg); o.state = 'hurt'; o.st = 0; o.long = stun > .4; o.vx = f.face * kb; o.hit = .12; o.flash = .2; o.inv = big ? .5 : .12;
    f.sp = Math.min(100, f.sp + 9); o.sp = Math.min(100, o.sp + 5);
    events.push({ k: 'hit', i: 1 - idx, dmg, big, x: o.x, y: o.y });
    if (o.hp <= 0 && phase === 'fight') { phase = 'ko'; phaseT = 0; winner = idx; events.push({ k: 'ko', w: idx }); }
  }

  /* ---------- per frame ---------- */
  function update(dt) {
    phaseT += dt;
    if (phase === 'count') {
      if (phaseT > .25 && !vsFlags.v) { vsFlags.v = 1; AK.play('vo_versus', 1.1); }
      if (phaseT > 1.1 && !vsFlags.r) { vsFlags.r = 1; AK.play(rivalRoster ? 'vo_' + rivalRoster : 'vo_challenger', 1.1); }
    } else vsFlags = {};
    readLocalInput();
    if (role === 'host' && F) {
      if (phase === 'count' && phaseT > COUNT) { phase = 'fight'; phaseT = 0; events.push({ k: 'fight' }); }
      if (phase === 'fight' || phase === 'ko') { const slow = phase === 'ko' ? .3 : 1; step(F[0], myIn, F[1], dt * slow, 0); step(F[1], remIn, F[0], dt * slow, 1); }
      if (phase === 'ko' && phaseT > 2.2) { phase = 'result'; phaseT = 0; events.push({ k: 'result', w: winner }); }
      for (const ev of events) handleEvent(ev);
      if ((sendT -= dt * 1000) <= 0 && conn && conn.open) { sendT = SEND_MS; conn.send({ t: 's', F: F.map(pack), ph: phase, pt: phaseT, w: winner, ev: events }); }
      events = [];
    } else if (role === 'guest' && conn && conn.open && (sendT -= dt * 1000) <= 0) { sendT = SEND_MS; conn.send({ t: 'i', ...myIn }); }
    syncView();
  }
  const pack = f => ({ x: Math.round(f.x), y: Math.round(f.y), face: f.face, state: f.state, hp: f.hp, sp: Math.round(f.sp), inv: +f.inv.toFixed(2), flash: +f.flash.toFixed(2), hit: +f.hit.toFixed(2), moving: f.moving, an: f.anim.name, ap: f.anim.p === undefined ? -1 : +f.anim.p.toFixed(3) });
  function unpack(f, d) {
    f.tx = d.x; f.ty = d.y; if (f.x === undefined || Math.abs(f.x - d.x) > 200) { f.x = d.x; f.y = d.y; }
    Object.assign(f, { face: d.face, state: d.state, hp: d.hp, sp: d.sp, inv: d.inv, flash: d.flash, hit: d.hit, moving: d.moving });
    setA(f, d.an, T, d.ap < 0 ? undefined : d.ap);
  }
  function readLocalInput() {
    let dx = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0), dy = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0);
    if (joy) { const jx = joy.x - joy.ox, jy = joy.y - joy.oy, m = Math.hypot(jx, jy); if (m > 8) { dx = jx / Math.max(m, 50); dy = jy / Math.max(m, 50); } }
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    myIn.mx = +dx.toFixed(2); myIn.my = +dy.toFixed(2);
  }
  // map the shared fight into this screen: P is me, enemies[0] is the rival
  function syncView() {
    if (!F) return;
    const me = F[meIdx()], them = F[1 - meIdx()];
    for (const f of F) if (f.tx !== undefined) { f.x += (f.tx - f.x) * .45; f.y += (f.ty - f.y) * .45; }
    Object.assign(P, { x: W / 2 + me.x, y: H / 2 + me.y, face: me.face, state: me.state, sp: me.sp, inv: me.inv, flash: me.flash, moving: me.moving, hp: me.hp, dash: me.state === 'dash' ? .1 : 0, weapon: null });
    P.anim.name = me.anim.name; P.anim.t = me.anim.t; P.anim.p = me.anim.p;
    Object.assign(rival, { x: W / 2 + them.x, y: H / 2 + them.y, face: them.face, hit: them.hit, hp: them.hp, maxhp: HP, state: them.state === 'atk' ? 'atk' : 'chase' });
    rival.anim.name = them.anim.name; rival.anim.t = them.anim.t; rival.anim.p = them.anim.p;
    enemies.length = 0; enemies.push(rival);
  }
  function abs(i) { const f = F[i]; return { x: W / 2 + f.x, y: H / 2 + f.y }; }
  function handleEvent(ev) {
    const mine = ev.i === meIdx(), who = ev.i !== undefined ? (mine ? P : rival) : null;
    if (ev.k === 'swing') { const f = F[ev.i]; slashes.push({ x: W / 2 + f.x, y: H / 2 + f.y, face: f.face, step: ev.s, owner: who, ang: f.face > 0 ? 0 : Math.PI, life: .22, max: .22, delay: COMBO[ev.s].hit, color: mine ? null : '#ff7a8a' }); AK.play('slash', ev.s === 3 ? .7 : .45, ev.s === 3 ? .8 : rand(.95, 1.15)); }
    else if (ev.k === 'hit') { const p = abs(ev.i); burst(p.x, p.y - 10, '#ffffff', ev.big ? 16 : 8, ev.big ? 260 : 170); burst(p.x, p.y - 10, mine ? '#ff4d6d' : '#38d6ff', 8, 200); floatText(p.x, p.y - 50, String(ev.dmg * 37), ev.big ? '#ffd84a' : '#eef0ff'); AK.play(mine ? 'hurt' : 'hit', .8, rand(.9, 1.1)); S.shake = ev.big ? 12 : 6; }
    else if (ev.k === 'miss') { const p = abs(ev.i); floatText(p.x, p.y - 50, 'DODGE', '#9fe8ff'); }
    else if (ev.k === 'dash') { const p = abs(ev.i); burst(p.x, p.y, '#38d6ff', 14, 160); AK.play('dash', .5); }
    else if (ev.k === 'spstart') { AK.play('riser', .6); if (mine) S.cine = { t: 0, dur: 1.1, slow: 0, title: 'GATE SLASH', sub: hunterName.toUpperCase() }; }
    else if (ev.k === 'spfire') { const f = F[ev.i]; slashes.push({ x: W / 2 + f.x + f.face * 120, y: H / 2 + f.y, face: f.face, step: 1, big: true, ang: 0, life: .5, max: .5 }); S.flash = .8; S.shake = 22; AK.play('braam', 1); }
    else if (ev.k === 'fight') { S.cine = { t: 0, dur: 1, slow: 0, title: 'FIGHT!', sub: '' }; AK.play('braam', .9); AK.play('vo_fight', 1.1); }
    else if (ev.k === 'ko') { S.cine = { t: 0, dur: 2.2, slow: 0, title: 'K.O.', sub: (ev.w === meIdx() ? hunterName : rivalName).toUpperCase() + ' WINS' }; S.flash = 1; AK.play('braam', 1); AK.play('vo_ko', 1.1); AK.play(ev.w === meIdx() ? 'win' : 'lose', .8); }
    else if (ev.k === 'result') showResult(ev.w);
  }

  /* ---------- HUD ---------- */
  function hud() {
    if (!F) return;
    const me = F[meIdx()], them = F[1 - meIdx()], top = 14 + ($('#safeTop').offsetHeight || 0), bw = Math.min(260, W / 2 - 50);
    const bar = (x, f, name, por, right) => {
      g.save(); g.fillStyle = 'rgba(16,13,30,.85)'; roundRect(x, top, bw + 52, 52, 12); g.fill();
      const px = right ? x + bw + 26 : x + 26; if (por) { g.save(); g.beginPath(); g.arc(px, top + 26, 20, 0, 6.283); g.clip(); g.drawImage(por, px - 20, top + 6, 40, 40); g.restore(); }
      g.strokeStyle = right ? '#ff4d6d' : '#38d6ff'; g.lineWidth = 2; g.beginPath(); g.arc(px, top + 26, 20, 0, 6.283); g.stroke();
      const bx = right ? x + 8 : x + 52, k = f.hp / HP;
      g.fillStyle = '#2b2550'; roundRect(bx, top + 26, bw - 8, 10, 5); g.fill();
      g.fillStyle = k > .3 ? (right ? '#ff4d6d' : '#38d6ff') : '#ffd84a'; roundRect(right ? bx + (bw - 8) * (1 - k) : bx, top + 26, (bw - 8) * k, 10, 5); g.fill();
      g.fillStyle = '#b18cff'; g.fillRect(right ? bx + (bw - 8) * (1 - f.sp / 100) : bx, top + 40, (bw - 8) * f.sp / 100, 3);
      g.fillStyle = '#eef0ff'; g.font = '700 13px "Chakra Petch"'; g.textAlign = right ? 'right' : 'left'; g.fillText(name.slice(0, 14).toUpperCase(), right ? bx + bw - 8 : bx, top + 19); g.restore();
    };
    bar(10, me, hunterName, portrait, false); bar(W - bw - 62, them, rivalName, rivalPortrait, true);
    g.textAlign = 'center'; g.fillStyle = '#ffd84a'; g.font = '700 16px "Chakra Petch"'; g.fillText('VS', W / 2, top + 32);
    if (phase === 'count') vsSplash();
    const rp = screenPos(rival.x, rival.y); g.font = '700 12px "Chakra Petch"'; g.fillStyle = '#ff9aa8'; g.fillText(rivalName.slice(0, 14), rp.x, rp.y + 20);
    if ($('#spBtn')) $('#spBtn').classList.toggle('ready', me.sp >= 100);
    g.textAlign = 'left';
  }

  function vsSplash() {
    const t = phaseT, a = Math.min(1, t / .3, (COUNT - .2 - t) / .4), sz = Math.min(W * .38, H * .26, 220), mid = H * .46;
    if (a <= 0) return;
    g.save(); g.globalAlpha = Math.max(0, a); g.fillStyle = 'rgba(7,6,13,.72)'; g.fillRect(0, mid - sz * .9, W, sz * 1.95);
    const side = (por, nm, q, col, left) => {
      const k = Math.min(1, t / .45), x = left ? W * .27 - (1 - k) * W * .5 : W * .73 + (1 - k) * W * .5, y = left ? mid - sz * .12 : mid + sz * .12;
      if (por) { g.save(); g.beginPath(); g.arc(x, y, sz / 2, 0, 6.283); g.clip(); g.drawImage(por, x - sz / 2, y - sz / 2, sz, sz); g.restore(); }
      g.strokeStyle = col; g.lineWidth = 4; g.shadowColor = col; g.shadowBlur = 20; g.beginPath(); g.arc(x, y, sz / 2, 0, 6.283); g.stroke(); g.shadowBlur = 0;
      g.textAlign = 'center'; g.fillStyle = col; g.font = '700 ' + Math.round(sz * .2) + 'px "Chakra Petch"'; g.fillText(nm.toUpperCase().slice(0, 12), x, y + sz * .5 + sz * .2);
      if (q && t > (left ? .5 : 1.1)) { g.fillStyle = '#eef0ff'; g.font = 'italic 500 ' + Math.round(Math.max(11, sz * .075)) + 'px Inter'; g.fillText('“' + q + '”', clamp(x, W * .3, W * .7), y + sz * .5 + sz * .33); }
    };
    side(portrait, hunterName, myQuote(), '#38d6ff', true); side(rivalPortrait, rivalName, rivalQuote, '#ff4d6d', false);
    g.textAlign = 'center'; g.fillStyle = '#ffd84a'; g.shadowColor = '#ffd84a'; g.shadowBlur = 30; g.font = '700 ' + Math.round(sz * .45) + 'px "Chakra Petch"'; g.fillText('VS', W / 2, mid + sz * .14); g.shadowBlur = 0;
    if (t > 2.8) { g.fillStyle = '#eef0ff'; g.font = '700 ' + Math.round(sz * .22) + 'px "Chakra Petch"'; g.fillText('READY', W / 2, mid + sz * .95); }
    g.restore();
  }
  const myQuote = () => (typeof fighter === 'function' ? fighter().quote : '');

  /* ---------- networking ---------- */
  const profile = async () => {
    const p = { t: 'hello', name: hunterName, portrait: portrait ? portrait.toDataURL('image/jpeg', .8) : null, sprites: null, roster: window.personalSprites ? null : rosterPick, quote: myQuote() };
    if (window.personalSprites) {   // send my own animated Crasher at half resolution
      const half = c => { const h = document.createElement('canvas'); h.width = c.width / 2; h.height = c.height / 2; h.getContext('2d').drawImage(c, 0, 0, h.width, h.height); return h.toDataURL('image/png'); };
      p.sprites = { anchor: personalSprites.anchor, anims: Object.fromEntries(Object.entries(personalSprites.anims).map(([k, a]) => [k, { img: half(a.canvas), cols: a.cols, rows: a.rows, n: a.n, loop: a.loop }])) };
    }
    if (role === 'host' && arena) p.arena = { id: arena.id, tint: arena.tint, image: arena.id === 'mine' && arena.image ? await toDataURL(await (await fetch(arena.image)).blob()) : null };
    return p;
  };
  async function onHello(d) {
    rivalName = d.name || 'Rival'; rivalRoster = d.roster || null; rivalQuote = d.quote || '';
    if (d.portrait) rivalPortrait = await loadImg(d.portrait).catch(() => null);
    if (d.sprites && window.setRivalSprites) {
      const anims = {};
      for (const [k, a] of Object.entries(d.sprites.anims)) { const img = await loadImg(a.img); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); anims[k] = { canvas: c, cols: a.cols, rows: a.rows, n: a.n, loop: a.loop }; }
      window.setRivalSprites({ anchor: d.sprites.anchor, anims });
    } else if (window.setRivalSprites) { window.setRivalSprites(null); window.setRivalRoster && window.setRivalRoster(d.roster); }
    if (d.arena) { const pre = ARENAS.find(a => a.id === d.arena.id && !a.custom); applyArena(pre ? { id: pre.id, image: 'arenas/' + pre.id + '.jpg', video: 'arenas/' + pre.id + '_loop.mp4', ground: 'arenas/' + pre.id + '_ground.jpg', tint: pre.tint } : { id: 'rival', image: d.arena.image, tint: d.arena.tint }); }
    if (role === 'host') begin();
  }
  function wire(c) {
    conn = c;
    c.on('open', async () => { $('#duelStatus').textContent = 'Connected. Exchanging Crashers…'; c.send(await profile()); });
    c.on('data', d => {
      if (d.t === 'hello') onHello(d);
      else if (d.t === 'i' && role === 'host') Object.assign(remIn, d);
      else if (d.t === 's' && role === 'guest') { if (!F) begin(); d.F.forEach((x, i) => unpack(F[i], x)); if (d.ph !== phase) { phase = d.ph; phaseT = d.pt; } d.ev.forEach(handleEvent); }
      else if (d.t === 'rematch') { if (role === 'host') reset(); else hideResult(); }
    });
    c.on('close', () => { if (mode === 'duel' || phase !== 'idle') { toast(rivalName + ' left the arena.'); exit(); } });
  }
  function newPeer(id) {
    if (!window.Peer) { toast('Online play needs a network connection.'); return null; }
    const p = new Peer(id, { debug: 1 });
    p.on('error', e => { $('#duelStatus').textContent = 'Connection problem: ' + (e.type || e.message); console.warn('peer', e); });
    return p;
  }
  function host() {
    role = 'host'; const id = 'gaterun-' + Math.random().toString(36).slice(2, 10);
    peer = newPeer(id); if (!peer) return;
    const link = PLAY_URL + '?duel=' + id;
    show('sDuel'); $('#duelTitle').textContent = 'Challenge a friend'; $('#duelLink').value = link; $('#duelLinkRow').style.display = '';
    $('#duelStatus').textContent = 'Opening your arena…'; $('#duelAccept').style.display = 'none';
    peer.on('open', () => { $('#duelStatus').textContent = 'Send the link. Waiting for your opponent…'; });
    peer.on('connection', c => { if (conn) return c.close(); wire(c); });
  }
  function join(id) {
    role = 'guest'; peer = newPeer(); if (!peer) return;
    $('#duelStatus').textContent = 'Connecting…';
    peer.on('open', () => wire(peer.connect(id, { reliable: true })));
  }
  function begin() {
    F = [mkF(0), mkF(1)]; myIn = myIn || newIn(); remIn = remIn || newIn(); events = []; phase = 'count'; phaseT = 0; winner = -1;
    rival = rival || { type: 'rival', r: 20, z: 0, wob: 0, e: true, anim: { name: 'idle', t: 0, p: undefined } };
    P = P || {}; P.anim = P.anim || { name: 'idle', t: 0 }; P.r = 20;
    S = { score: 0, kills: 0, shake: 0, msg: '', msgT: 0, tele: [], pickups: [], cine: null, flash: 0, combo: 0, comboT: 0 };
    enemies = []; shards = []; parts = []; texts = []; slashes = [];
    hideResult(); show(''); mode = 'duel'; T = 0; AK.init(); AK.music(.3);
    document.querySelectorAll('.tbtn').forEach(b => b.style.display = isTouch ? 'block' : 'none');
  }
  function reset() { if (role === 'host') { begin(); conn && conn.send({ t: 'rematch' }); } else { conn && conn.send({ t: 'rematch' }); } }
  function exit() {
    try { conn && conn.close(); peer && peer.destroy(); } catch (e) {}
    conn = peer = F = null; role = null; phase = 'idle'; mode = 'menu'; enemies = []; P = null;
    window.setRivalSprites && window.setRivalSprites(null);
    document.querySelectorAll('.tbtn').forEach(b => b.style.display = 'none'); AK.musicOff();
    hideResult(); history.replaceState(null, '', location.pathname); show('sStart');
  }

  /* ---------- result + share ---------- */
  function card(won) {
    const w = 1080, h = 1350, c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    const bg = x.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#0b0918'); bg.addColorStop(1, '#2a1245'); x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.textAlign = 'center'; x.fillStyle = '#38d6ff'; x.font = '600 30px "Chakra Petch"'; x.fillText('G A T E C R A S H E R S   ·   1 V 1', w / 2, 90);
    x.fillStyle = won ? '#ffd84a' : '#ff4d6d'; x.font = '700 120px "Chakra Petch"'; x.fillText(won ? 'VICTORY' : 'DEFEAT', w / 2, 220);
    const face = (img, cx, ring, nm) => { const r = 200; x.save(); x.beginPath(); x.arc(cx, 560, r, 0, 6.283); x.clip(); x.fillStyle = '#140f33'; x.fillRect(cx - r, 360, r * 2, r * 2); if (img) x.drawImage(img, cx - r, 360, r * 2, r * 2); x.restore();
      x.strokeStyle = ring; x.lineWidth = 10; x.shadowColor = ring; x.shadowBlur = 30; x.beginPath(); x.arc(cx, 560, r, 0, 6.283); x.stroke(); x.shadowBlur = 0;
      x.fillStyle = '#eef0ff'; x.font = '700 50px "Chakra Petch"'; x.fillText(nm.toUpperCase().slice(0, 12), cx, 840); };
    const meWon = winner === meIdx();
    face(meWon ? portrait : rivalPortrait, 290, '#ffd84a', meWon ? hunterName : rivalName); face(meWon ? rivalPortrait : portrait, 790, '#5a5080', meWon ? rivalName : hunterName);
    x.fillStyle = '#ffd84a'; x.font = '700 70px "Chakra Petch"'; x.fillText('K.O.', w / 2, 590);
    x.fillStyle = '#9a9cc4'; x.font = '500 34px Inter'; x.fillText((meWon ? hunterName : rivalName) + ' wins with ' + F[winner].hp + ' HP left', w / 2, 930);
    x.fillStyle = '#eef0ff'; x.font = '700 46px "Chakra Petch"'; x.fillText('THINK YOU CAN TAKE ME?', w / 2, 1080);
    x.fillStyle = '#38d6ff'; x.font = '600 32px Inter'; x.fillText(PLAY_URL.replace(/^https?:\/\//, '').replace(/\/$/, ''), w / 2, 1130);
    x.fillStyle = '#ffd84a'; x.font = '700 32px "Chakra Petch"'; x.fillText('#OpenSourceHiggsfield', w / 2, 1280);
    return c.toDataURL('image/png');
  }
  function showResult(w) {
    winner = w; const won = w === meIdx(); resultCard = card(won);
    $('#duelResImg').src = resultCard; $('#duelResTitle').textContent = won ? 'You won the 1v1' : rivalName + ' won this one';
    show('sDuelRes'); document.querySelectorAll('.tbtn').forEach(b => b.style.display = 'none'); AK.musicOff(1);
  }
  function hideResult() { const r = $('#sDuelRes'); if (r) r.classList.remove('on'); }
  async function share() {
    const won = winner === meIdx(), text = (won ? 'I just beat ' + rivalName : rivalName + ' just beat me') + ' in a Gate Run 1v1. Think you can take me? ' + PLAY_URL + ' #OpenSourceHiggsfield';
    const blob = await (await fetch(resultCard)).blob(), file = new File([blob], 'gate-run-1v1.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { return await navigator.share({ files: [file], text }); } catch (e) { if (e.name === 'AbortError') return; } }
    download(resultCard, 'gate-run-1v1.png'); try { await navigator.clipboard.writeText(text); toast('Card saved, caption copied'); } catch (e) {}
  }

  return {
    host, join, update, hud, exit, share, reset,
    debug: () => ({ role, peerId: peer && peer.id, peerOpen: !!(peer && peer.open), disconnected: !!(peer && peer.disconnected), conn: !!conn, connOpen: !!(conn && conn.open), ice: conn && conn.peerConnection && conn.peerConnection.iceConnectionState, phase }),
    press: k => { if (myIn && phase === 'fight') myIn[k]++; },
    get active() { return mode === 'duel'; },
  };
})();
window.Duel = Duel;
