(function () {
'use strict';
var D = window.Damka;
var NTFY = 'https://ntfy.sh';
var PREFIX = 'damka-kiosk-v1-';
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var $ = function (id) { return document.getElementById(id); };

/* ---------- small storage helpers ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function rid(n) { var s = ''; var a = new Uint32Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += CODE_CHARS[a[i] % CODE_CHARS.length]; return s; }
var myId = lsGet('dmk_id') || rid(12); lsSet('dmk_id', myId);
var myName = lsGet('dmk_name') || '';
$('nameIn').value = myName;

/* ---------- sound + haptics ---------- */
var soundOn = lsGet('dmk_sound') !== '0';
var actx = null;
function syncSoundBtn() { $('soundBtn').setAttribute('aria-pressed', String(soundOn)); $('soundBtn').textContent = soundOn ? '🔊' : '🔇'; }
syncSoundBtn();
$('soundBtn').onclick = function () { soundOn = !soundOn; lsSet('dmk_sound', soundOn ? '1' : '0'); syncSoundBtn(); if (soundOn) beep('move'); };
function beep(kind) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (kind === 'crack' || kind === 'whoosh') { noise(kind); return; }
    if (kind === 'king' || kind === 'win') { [0, .09, .18].forEach(function (d, n) { tone([660, 830, 990][n] * (kind === 'win' ? 1 : 1.2), .25, 'triangle', d); }); return; }
    var t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    var spec = { move: [520, 0.06, 'triangle'], cap: [180, 0.12, 'square'], emo: [990, 0.08, 'sine'], tick: [1400, 0.025, 'triangle'] }[kind] || [440, .05, 'sine'];
    o.type = spec[2]; o.frequency.setValueAtTime(spec[0], t);
    if (kind === 'king' || kind === 'win') o.frequency.exponentialRampToValueAtTime(spec[0] * 2, t + spec[1]);
    if (kind === 'cap') o.frequency.exponentialRampToValueAtTime(70, t + spec[1]);
    g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + spec[1]);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + spec[1] + 0.02);
  } catch (e) {}
}
function tone(f, dur, type, delay) {
  var t = actx.currentTime + (delay || 0), o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.14, t + .01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + .02);
}
function noise(kind) {
  var t = actx.currentTime, len = kind === 'crack' ? .18 : .22;
  var buf = actx.createBuffer(1, Math.floor(actx.sampleRate * len), actx.sampleRate), d = buf.getChannelData(0);
  for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, kind === 'crack' ? 3 : 1.5);
  var src = actx.createBufferSource(); src.buffer = buf;
  var f = actx.createBiquadFilter(); f.type = kind === 'crack' ? 'highpass' : 'bandpass';
  f.frequency.setValueAtTime(kind === 'crack' ? 1200 : 600, t);
  if (kind === 'whoosh') f.frequency.exponentialRampToValueAtTime(2400, t + len);
  var g = actx.createGain(); g.gain.setValueAtTime(kind === 'crack' ? .5 : .12, t);
  src.connect(f); f.connect(g); g.connect(actx.destination); src.start(t);
  if (kind === 'crack') tone(140, .14, 'square', 0);
}
function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

/* ---------- toast / live region ---------- */
var toastT;
function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600); }
function say(msg) { var l = $('live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }

/* ---------- state ---------- */
var mode = null;          // 'online' | 'local'
var room = null;          // online room state
var game = null;          // engine game
var seen = {};            // ntfy message ids
var es = null, lastMsgId = null, pingTimer = null, reconnectTimer = null;
var mySide = 0;           // 1 white, -1 black, 0 spectator
var sel = null;           // { from, path:[...], cands:[moves] }
var animating = false;
var pieceAt = {};         // square -> piece element
var focusSq = null;
var localGames = 0;
var wasMyTurn = false;

function freshRoom(code) {
  return { code: code, g: 0, seats: { w: null, b: null }, names: {}, moves: [], result: null, drawOffer: null, lastSeen: {}, ready: false };
}

/* ---------- networking (ntfy.sh pub/sub) ---------- */
function topic() { return PREFIX + room.code; }
function publish(msg, ephemeral) {
  msg.id = myId; msg.v = 1;
  return fetch(NTFY + '/' + topic() + (ephemeral ? '?cache=no' : ''), { method: 'POST', body: JSON.stringify(msg) })
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); })
    .catch(function () { toast('אין חיבור לשרת. בודק שוב…'); throw new Error('net'); });
}
function handleRaw(ev) {
  if (!ev || ev.event !== 'message' || seen[ev.id]) return;
  seen[ev.id] = 1; lastMsgId = ev.id;
  var m; try { m = JSON.parse(ev.message); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.id !== 'string') return;
  onMsg(m, room.ready);
}
function loadHistory() {
  return fetch(NTFY + '/' + topic() + '/json?poll=1&since=all')
    .then(function (r) { if (!r.ok) throw new Error('http'); return r.text(); })
    .then(function (txt) {
      txt.split('\n').forEach(function (line) { if (!line.trim()) return; try { handleRaw(JSON.parse(line)); } catch (e) {} });
    });
}
function openStream() {
  if (es) es.close();
  var since = lastMsgId || Math.floor(Date.now() / 1000) - 5;
  try { es = new EventSource(NTFY + '/' + topic() + '/sse?since=' + since); } catch (e) { scheduleReconnect(); return; }
  es.onmessage = function (e) { try { handleRaw(JSON.parse(e.data)); } catch (x) {} };
  es.onerror = function () { scheduleReconnect(); };
}
function scheduleReconnect() {
  if (es) { es.close(); es = null; }
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(function () { if (mode === 'online') { loadHistory().catch(function () {}).then(openStream); } }, 2500);
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && mode === 'online') { loadHistory().catch(function () {}).then(function () { openStream(); ping(); }); }
});
function ping() { if (mode === 'online') publish({ t: 'ping', name: myName }, true).catch(function () {}); }

/* ---------- message reducer ---------- */
function seatOf(id) { return room.seats.w === id ? 1 : room.seats.b === id ? -1 : 0; }
function onMsg(m, live) {
  if (m.name && typeof m.name === 'string') room.names[m.id] = m.name.slice(0, 16);
  room.lastSeen[m.id] = Date.now();
  switch (m.t) {
    case 'seat':
      if ((m.side === 'w' || m.side === 'b') && !room.seats[m.side] && seatOf(m.id) === 0) room.seats[m.side] = m.id;
      break;
    case 'move':
      if (m.g !== room.g || m.n !== room.moves.length || room.result) break;
      if (seatOf(m.id) !== game.side || !Array.isArray(m.path)) break;
      var before = game.board.slice();
      var mv = D.play(game, m.path.map(Number));
      if (!mv) break;
      room.moves.push(m.path); room.drawOffer = null;
      if (live) animateMove(mv, before, m.id !== myId);
      if (game.result) room.result = { winner: game.result.winner, reason: game.result.reason };
      break;
    case 'resign':
      if (m.g === room.g && !room.result && seatOf(m.id)) room.result = { winner: -seatOf(m.id), reason: 'resign' };
      break;
    case 'drawoffer':
      if (m.g === room.g && !room.result && seatOf(m.id)) room.drawOffer = { by: m.id, n: room.moves.length };
      break;
    case 'drawreply':
      if (m.g === room.g && !room.result && room.drawOffer && room.drawOffer.by !== m.id && seatOf(m.id)) {
        if (m.yes && room.drawOffer.n === room.moves.length) room.result = { winner: 0, reason: 'agreed' };
        else if (live && room.drawOffer.by === myId) toast('היריב רוצה להמשיך לשחק');
        room.drawOffer = null;
      }
      break;
    case 'new':
      if (m.g === room.g + 1 && room.result && seatOf(m.id)) {
        room.g = m.g; room.moves = []; room.result = null; room.drawOffer = null;
        var w = room.seats.w; room.seats.w = room.seats.b; room.seats.b = w;
        game = D.newGame(); sel = null;
        if (live) { closeDlg($('endDlg')); toast('משחק חדש! הצבעים התחלפו'); }
      }
      break;
    case 'emo':
      if (live && m.id !== myId && typeof m.e === 'string' && ['👏','🔥','😂','😱','🤝'].indexOf(m.e) !== -1) floatEmo(m.e, true);
      break;
  }
  if (live) render();
}

/* ---------- entering rooms ---------- */
function saveName() { myName = ($('nameIn').value || '').trim().slice(0, 16) || 'שחקן'; lsSet('dmk_name', myName); }
function startOnline(code, creating) {
  saveName();
  mode = 'online'; room = freshRoom(code); game = D.newGame(); seen = {}; lastMsgId = null; sel = null;
  showGame();
  setStatus('מתחבר לחדר…');
  try { history.replaceState(null, '', location.pathname + '?r=' + code); } catch (e) {}
  lsSet('dmk_last', code);
  loadHistory().then(function () {
    room.ready = true;
    var mine = seatOf(myId);
    if (!creating && !room.seats.w && !room.seats.b) {
      leave(); $('codeIn').value = code;
      $('joinErr').textContent = 'לא מצאתי חדר עם הקוד ' + code + '. בדוק את הקוד, או בקש מהחבר לפתוח חדר חדש.';
      throw new Error('noroom');
    }
    if (!mine) {
      if (creating || !room.seats.w) return publish({ t: 'seat', side: 'w', name: myName });
      if (!room.seats.b) return publish({ t: 'seat', side: 'b', name: myName });
      toast('החדר מלא. אתה צופה במשחק.');
    } else {
      publish({ t: 'ping', name: myName }, true).catch(function () {});
    }
  }).then(function () { return true; }, function (e) {
    if (e && e.message === 'noroom') return false;
    if (!room) return false;
    room.ready = true;
    setStatus('אין חיבור לשרת המשחק. בדוק אינטרנט ונסה שוב.');
    return true;
  }).then(function (go) {
    if (!go || !room) return;
    openStream(); render(true);
    clearInterval(pingTimer); pingTimer = setInterval(function () { ping(); render(); }, 20000);
    setTimeout(ping, 800);
  });
}
function startLocal() {
  saveName();
  mode = 'local'; room = freshRoom('LOCAL'); room.ready = true; game = D.newGame(); sel = null; localGames++;
  room.seats.w = 'L1'; room.seats.b = 'L2'; room.names.L1 = 'לבן'; room.names.L2 = 'שחור';
  showGame(); render(true);
}
function leave() {
  if (es) es.close(); es = null; clearInterval(pingTimer); clearTimeout(reconnectTimer);
  mode = null; room = null;
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  $('game').hidden = true; $('home').hidden = false;
}
function showGame() { $('home').hidden = true; $('game').hidden = false; buildBoard(); }

$('createBtn').onclick = function () { startOnline(rid(5), true); };
$('joinBtn').onclick = function () {
  var c = ($('codeIn').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 5) { $('joinErr').textContent = 'הקוד צריך להיות 5 תווים, באותיות באנגלית או ספרות.'; $('codeIn').focus(); return; }
  $('joinErr').textContent = ''; startOnline(c, false);
};
$('codeIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('joinBtn').click(); });
$('localBtn').onclick = startLocal;
$('leaveBtn').onclick = function () { confirmAsk('לצאת מהמשחק? אפשר לחזור עם אותו קישור.', leave); };
$('rulesBtn').onclick = function () { openDlg($('rulesDlg')); };

/* ---------- dialogs ---------- */
function openDlg(d) { if (d.open) return; if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
function closeDlg(d) { if (d.close && d.open) d.close(); else d.removeAttribute('open'); }
var confirmCb = null;
function confirmAsk(text, cb) { $('confirmText').textContent = text; confirmCb = cb; openDlg($('confirmDlg')); }
$('confirmYes').onclick = function () { closeDlg($('confirmDlg')); if (confirmCb) confirmCb(); };
$('confirmNo').onclick = function () { closeDlg($('confirmDlg')); };
$('endClose').onclick = function () { closeDlg($('endDlg')); };

/* ---------- wood textures (generated once, so the board has real grain) ---------- */
function woodTex(base, dark, light, w, h, rings) {
  try {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    for (var n = 0; n < (rings || 90); n++) {
      var y0 = Math.random() * h, amp = 2 + Math.random() * 7, f = .004 + Math.random() * .012, ph = Math.random() * 6;
      x.strokeStyle = Math.random() < .55 ? dark : light;
      x.globalAlpha = .08 + Math.random() * .22;
      x.lineWidth = .6 + Math.random() * 2.2;
      x.beginPath();
      for (var px = 0; px <= w; px += 4) { var py = y0 + Math.sin(px * f + ph) * amp + Math.sin(px * f * 3.1 + ph) * amp * .3; if (px) x.lineTo(px, py); else x.moveTo(px, py); }
      x.stroke();
    }
    // pores / noise
    var img = x.getImageData(0, 0, w, h), d = img.data;
    for (var i = 0; i < d.length; i += 4) { var k = (Math.random() - .5) * 14; d[i] += k; d[i + 1] += k; d[i + 2] += k; }
    x.putImageData(img, 0, 0);
    return 'url(' + c.toDataURL('image/jpeg', .82) + ')';
  } catch (e) { return ''; }
}
(function () {
  var rs = document.documentElement.style;
  var t1 = woodTex('#6b381b', '#3e1c09', '#8c4c26', 360, 360, 110); if (t1) rs.setProperty('--tex-dark', t1);
  var t2 = woodTex('#e3c189', '#c49a5c', '#f6e2b8', 360, 360, 80); if (t2) rs.setProperty('--tex-light', t2);
  var t3 = woodTex('#4a2410', '#261005', '#6b3518', 420, 420, 140); if (t3) rs.setProperty('--tex-frame', t3);
})();

/* ---------- board ---------- */
function flipped() { return mode === 'online' && mySide === -1; }
function view(i) { var p = D.rc(i); return flipped() ? [7 - p[0], 7 - p[1]] : p; }
function buildBoard() {
  var b = $('board'); b.innerHTML = '';
  var files = $('files'), ranks = $('ranks'); files.innerHTML = ''; ranks.innerHTML = '';
  for (var vr = 0; vr < 8; vr++) {
    for (var vc = 0; vc < 8; vc++) {
      var r = flipped() ? 7 - vr : vr, c = flipped() ? 7 - vc : vc, i = D.idx(r, c);
      var el = document.createElement('button');
      el.className = 'sq' + (D.isDark(i) ? ' dark' : '');
      el.dataset.i = i; el.type = 'button';
      el.setAttribute('role', 'gridcell');
      el.tabIndex = -1;
      // each square shows a different slice of the grain, like real cut wood
      el.style.backgroundPosition = ((i * 37) % 100) + '% ' + ((i * 61) % 100) + '%';
      if (!D.isDark(i)) el.setAttribute('aria-hidden', 'true');
      b.appendChild(el);
    }
    var rr = document.createElement('span'); rr.textContent = flipped() ? vr + 1 : 8 - vr; ranks.appendChild(rr);
    var ff = document.createElement('span'); ff.textContent = 'abcdefgh'[flipped() ? 7 - vr : vr]; files.appendChild(ff);
  }
  b.onclick = function (e) { var t = e.target.closest('.sq'); if (t && D.isDark(+t.dataset.i)) { ripple(t); tap(+t.dataset.i); } };
  b.onkeydown = onBoardKey;
  $('pieces').innerHTML = ''; pieceAt = {};
  layoutPieces(true);
  sizeFx();
}
function ripple(sq) {
  if (reduced) return;
  var r = document.createElement('span'); r.className = 'rip'; sq.appendChild(r);
  setTimeout(function () { r.remove(); }, 520);
}
function sqEl(i) { return $('board').querySelector('[data-i="' + i + '"]'); }
function placePiece(el, i) { var v = view(i); el.style.transform = 'translate(' + (v[1] * 100) + '%,' + (v[0] * 100) + '%)'; }
function pieceClass(v) { return 'pc ' + (v > 0 ? 'w' : 'b') + (Math.abs(v) === 2 ? ' k' : ''); }
function makePiece(v) {
  var el = document.createElement('div');
  el.className = pieceClass(v);
  el.innerHTML = '<div class="shadow"></div><div class="disc"><svg class="crown"><use href="#crown"/></svg></div>';
  return el;
}
var dealtFor = null;
function layoutPieces(force) {
  var box = $('pieces'); var b = game.board;
  if (force) { box.innerHTML = ''; pieceAt = {}; }
  var ok = !force;
  if (ok) for (var i = 0; i < 64; i++) { var has = !!pieceAt[i], want = b[i] !== 0; if (has !== want) { ok = false; break; } }
  if (!ok) {
    box.innerHTML = ''; pieceAt = {};
    // deal the pieces onto the board once per new game
    var dealKey = room ? room.code + ':' + room.g + ':' + (mode === 'local' ? localGames : 0) : null;
    var deal = !reduced && game.history.length === 0 && dealKey !== dealtFor;
    if (deal) dealtFor = dealKey;
    for (var j = 0; j < 64; j++) if (b[j]) {
      var el = makePiece(b[j]); placePiece(el, j); box.appendChild(el); pieceAt[j] = el;
      if (deal) {
        el.classList.add('deal');
        var v = view(j), delay = (v[0] < 4 ? v[0] : 7 - v[0]) * 90 + v[1] * 28 + (v[0] < 4 ? 0 : 140);
        el.querySelector('.disc').style.animationDelay = delay + 'ms';
        el.querySelector('.shadow').style.animationDelay = delay + 'ms';
        (function (e2, d2) { setTimeout(function () { if (soundOn) tick2(); e2.classList.remove('deal'); }, d2 + 600); })(el, delay);
      }
    }
  } else {
    for (var k in pieceAt) { var e3 = pieceAt[k]; placePiece(e3, +k); var keep = e3.className.match(/\b(lift|can|threat|dead|crowned)\b/g) || []; e3.className = pieceClass(b[k]) + (keep.length ? ' ' + keep.join(' ') : ''); }
  }
}
var lastTick = 0;
function tick2() { var t = Date.now(); if (t - lastTick > 60) { lastTick = t; beep('tick'); } }
function restart(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function hop(el) { restart(el.querySelector('.disc'), 'hop'); restart(el.querySelector('.shadow'), 'hop'); }
function land(el) { var d = el.querySelector('.disc'); d.classList.remove('hop'); restart(d, 'land'); setTimeout(function () { d.classList.remove('land'); }, 340); }
function shake(big) { if (reduced) return; var s = $('stage'); s.classList.remove('shake', 'shake-big'); void s.offsetWidth; s.classList.add(big ? 'shake-big' : 'shake'); setTimeout(function () { s.classList.remove('shake', 'shake-big'); }, 560); }
function combo(n) {
  if (n < 2) return;
  var words = { 2: 'דאבל!', 3: 'טריפל!!', 4: 'מטורף!!!' };
  var el = document.createElement('div'); el.className = 'combo'; el.textContent = words[n] || ('x' + n + ' 🔥');
  $('boardWrap').appendChild(el); setTimeout(function () { el.remove(); }, 1150);
}

/* ---------- animation ---------- */
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateMove(mv, before, fromOpponent) {
  animating = true;
  var el = pieceAt[mv.path[0]];
  drawPaths(true);
  if (!el || reduced) { animating = false; layoutPieces(false); afterMoveFx(mv, fromOpponent); render(); return; }
  delete pieceAt[mv.path[0]];
  el.classList.remove('can', 'threat');
  el.classList.add('lift');
  var seq = Promise.resolve();
  mv.path.slice(1).forEach(function (to, n) {
    seq = seq.then(function () { placePiece(el, to); hop(el); beep(mv.caps.length ? 'whoosh' : 'move'); return wait(250); }).then(function () {
      var c = mv.caps[n];
      if (c === undefined) return;
      var p = pieceAt[c];
      shatter(c, before[c] > 0);
      beep('crack'); buzz(30); shake(n > 0);
      if (p) { p.classList.add('gone'); delete pieceAt[c]; setTimeout(function () { p.remove(); }, 300); }
      bumpCount(before[c] > 0 ? 'cntW' : 'cntB');
      return wait(90); // tiny hit-stop so each capture lands
    });
  });
  seq.then(function () {
    var to = mv.path[mv.path.length - 1];
    el.classList.remove('lift'); land(el); dust(to);
    pieceAt[to] = el;
    if (mv.promote) {
      el.classList.add('k'); restart(el, 'crowned'); setTimeout(function () { el.classList.remove('crowned'); }, 820);
      crownFx(to); beep('king'); buzz([30, 30, 80]);
    }
    combo(mv.caps.length);
    animating = false; layoutPieces(false); afterMoveFx(mv, fromOpponent); render();
  });
}
function bumpCount(id) { var b = $(id); restart(b, 'bump'); }
function afterMoveFx(mv, fromOpponent) {
  var who = mv.side === 1 ? 'לבן' : 'שחור';
  say(who + ' שיחק ' + D.notation(mv) + (mv.caps.length ? ', אכל ' + mv.caps.length : '') + (mv.promote ? ', והפך למלך' : ''));
  if (fromOpponent && mode === 'online') buzz(mv.caps.length ? [40, 40, 40] : 30);
}

/* ---------- path overlay ---------- */
var pathsKey = '';
function center(i) { var v = view(i); return (v[1] + .5) + ',' + (v[0] + .5); }
function drawPaths(clear) {
  var svg = $('paths');
  var key = '', html = '';
  if (!clear && sel && sel.path.length > 1) {
    key = 'c' + sel.path.join('-');
    html = '<polyline class="chain" points="' + sel.path.map(center).join(' ') + '"/>' +
      sel.path.map(function (p) { var c = center(p).split(','); return '<circle class="node" cx="' + c[0] + '" cy="' + c[1] + '" r=".07"/>'; }).join('');
  } else if (!clear && !sel) {
    var last = game && game.history[game.history.length - 1];
    if (last) { key = 't' + game.history.length + last.path.join('-') + flipped(); html = '<polyline class="trail" pathLength="20" points="' + last.path.map(center).join(' ') + '"/>'; }
  }
  if (key === pathsKey) return;
  pathsKey = key; svg.innerHTML = html;
}

/* ---------- particles ---------- */
var fx = $('fx'), fctx = fx.getContext('2d'), parts = [], fxRun = false;
function sizeFx() { var r = fx.getBoundingClientRect(); var d = Math.min(window.devicePixelRatio || 1, 2); fx.width = r.width * d; fx.height = r.height * d; fctx.setTransform(d, 0, 0, d, 0, 0); }
window.addEventListener('resize', sizeFx);
function sqCenter(i) {
  var r = fx.getBoundingClientRect(), pc = $('pieces').getBoundingClientRect();
  var cell = pc.width / 8, v = view(i);
  return { x: pc.left - r.left + (v[1] + .5) * cell, y: pc.top - r.top + (v[0] + .5) * cell, cell: cell };
}
function addP(p) { parts.push(p); if (!fxRun) { fxRun = true; requestAnimationFrame(tick); } }
function shatter(i, white) {
  if (reduced) return;
  var c = sqCenter(i), cols = white ? ['#fffaf0', '#e9dcc2', '#c9b48c'] : ['#3b3e4c', '#1e1f28', '#6a6d7c'];
  addP({ k: 'ring', x: c.x, y: c.y, r: c.cell * .2, vr: c.cell * .09, life: 1, c: '#ffd36a', w: 4 });
  addP({ k: 'flash', x: c.x, y: c.y, r: c.cell * .9, life: 1 });
  for (var n = 0; n < 16; n++) {
    var a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
    addP({ k: 'shard', x: c.x, y: c.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2, rot: Math.random() * 6, vrot: (Math.random() - .5) * .5, life: 1, c: cols[n % 3], s: c.cell * (.08 + Math.random() * .12), g: .22 });
  }
  for (var m = 0; m < 12; m++) {
    var b = Math.random() * Math.PI * 2, t = 3 + Math.random() * 6;
    addP({ k: 'spark', x: c.x, y: c.y, vx: Math.cos(b) * t, vy: Math.sin(b) * t, life: 1, c: '#ffc23d', g: .05 });
  }
}
function dust(i) {
  if (reduced) return;
  var c = sqCenter(i);
  for (var n = 0; n < 10; n++) {
    var dir = n % 2 ? 1 : -1;
    addP({ k: 'dot', x: c.x + dir * c.cell * .25, y: c.y + c.cell * .25, vx: dir * (.6 + Math.random() * 1.6), vy: -Math.random() * .8, life: .7, c: 'rgba(240,215,170,.9)', r: 1.5 + Math.random() * 2.5, g: .02, decay: .03 });
  }
}
function crownFx(i) {
  if (reduced) return;
  var c = sqCenter(i);
  addP({ k: 'beam', x: c.x, y: c.y, w: c.cell * .9, life: 1 });
  addP({ k: 'ring', x: c.x, y: c.y, r: c.cell * .3, vr: c.cell * .07, life: 1, c: '#fff1b0', w: 3 });
  for (var n = 0; n < 34; n++) {
    var a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 5;
    addP({ k: 'star', x: c.x, y: c.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2.5, life: 1.2, c: n % 3 ? '#ffd86b' : '#fff7d6', r: 2 + Math.random() * 3, g: .08, rot: Math.random() * 6 });
  }
}
function star(x, y, r, rot) {
  fctx.beginPath();
  for (var i = 0; i < 8; i++) { var rr = i % 2 ? r * .4 : r, a = rot + i * Math.PI / 4; fctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  fctx.closePath(); fctx.fill();
}
function tick() {
  var r = fx.getBoundingClientRect();
  fctx.clearRect(0, 0, r.width, r.height);
  parts = parts.filter(function (p) { return p.life > 0; });
  parts.forEach(function (p) {
    fctx.save();
    fctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    switch (p.k) {
      case 'ring':
        p.r += p.vr; p.vr *= .92; p.life -= .045;
        fctx.strokeStyle = p.c; fctx.lineWidth = p.w * p.life; fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, 7); fctx.stroke(); break;
      case 'flash':
        p.life -= .12; fctx.globalCompositeOperation = 'lighter';
        var g = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r); g.addColorStop(0, 'rgba(255,240,200,.9)'); g.addColorStop(1, 'rgba(255,200,80,0)');
        fctx.fillStyle = g; fctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); break;
      case 'shard':
        p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= .98; p.rot += p.vrot; p.life -= .022;
        fctx.translate(p.x, p.y); fctx.rotate(p.rot); fctx.fillStyle = p.c;
        fctx.beginPath(); fctx.moveTo(-p.s, -p.s * .5); fctx.lineTo(p.s, -p.s * .2); fctx.lineTo(p.s * .2, p.s * .7); fctx.closePath(); fctx.fill(); break;
      case 'spark':
        p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= .93; p.vy *= .93; p.life -= .04;
        fctx.globalCompositeOperation = 'lighter'; fctx.strokeStyle = p.c; fctx.lineWidth = 2; fctx.lineCap = 'round';
        fctx.beginPath(); fctx.moveTo(p.x, p.y); fctx.lineTo(p.x - p.vx * 2.5, p.y - p.vy * 2.5); fctx.stroke(); break;
      case 'beam':
        p.life -= .025; fctx.globalCompositeOperation = 'lighter';
        var bg = fctx.createLinearGradient(0, p.y, 0, 0); bg.addColorStop(0, 'rgba(255,220,120,.85)'); bg.addColorStop(1, 'rgba(255,220,120,0)');
        var w = p.w * (0.4 + p.life * .6); fctx.fillStyle = bg; fctx.fillRect(p.x - w / 2, 0, w, p.y); break;
      case 'star':
        p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= .97; p.rot += .15; p.life -= .02;
        fctx.globalCompositeOperation = 'lighter'; fctx.fillStyle = p.c; star(p.x, p.y, p.r, p.rot); break;
      default: // dot / confetti
        p.x += p.vx; p.y += p.vy; p.vy += (p.g === undefined ? .12 : p.g); p.life -= (p.decay || .025);
        if (p.rect) { fctx.translate(p.x, p.y); fctx.rotate(p.rot += p.vrot); fctx.fillStyle = p.c; fctx.fillRect(-p.r, -p.r * .5, p.r * 2, p.r); }
        else { fctx.fillStyle = p.c; fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, 7); fctx.fill(); }
    }
    fctx.restore();
  });
  if (parts.length) requestAnimationFrame(tick); else { fxRun = false; fctx.clearRect(0, 0, r.width, r.height); }
}
function confetti() {
  if (reduced) return;
  var r = fx.getBoundingClientRect();
  var cols = ['#ffc23d', '#f6f0e4', '#7be0a8', '#ff7a6b', '#e9cf9f'];
  for (var k = 0; k < 160; k++) addP({ x: Math.random() * r.width, y: -10 - Math.random() * 120, vx: (Math.random() - .5) * 2.5, vy: 1 + Math.random() * 3, life: 2, decay: .01, g: .05, c: cols[k % 5], r: 3 + Math.random() * 4, rect: true, rot: Math.random() * 6, vrot: (Math.random() - .5) * .3 });
}
function floatEmo(e, theirs) {
  var el = document.createElement('div'); el.className = 'float-emo'; el.textContent = e;
  var r = $(theirs ? 'plTop' : 'plBottom').getBoundingClientRect();
  el.style.left = (r.left + r.width / 2 - 32) + 'px'; el.style.top = (r.top + (theirs ? 40 : -20)) + 'px';
  document.body.appendChild(el); setTimeout(function () { el.remove(); }, 1900);
  beep('emo'); if (theirs) buzz(20);
}


/* ---------- input ---------- */
function canAct() {
  if (!room || !room.ready || room.result || animating) return false;
  if (mode === 'local') return true;
  return mySide !== 0 && game.side === mySide && room.seats.w && room.seats.b;
}
function tap(i) {
  if (!canAct()) {
    if (room && room.result) return;
    if (mode === 'online' && mySide && game.side !== mySide) toast('זה התור של היריב');
    return;
  }
  focusSq = i;
  var legal = game.legal;
  if (sel) {
    var step = sel.path.length;
    var next = sel.cands.filter(function (m) { return m.path[step] === i; });
    if (next.length) {
      var path = sel.path.concat([i]);
      var done = next.filter(function (m) { return m.path.length === path.length; });
      if (done.length && next.length === done.length) { commit(done[0]); return; }
      sel = { from: sel.from, path: path, cands: next.filter(function (m) { return m.path.length > path.length; }) };
      // show the partial chain
      var el = pieceAt[sel.from]; if (el) { placePiece(el, i); hop(el); }
      beep('whoosh'); render(); return;
    }
    if (i === sel.path[0] && sel.path.length === 1) { sel = null; render(); say('הבחירה בוטלה'); return; }
    if (sel.path.length > 1) { toast('צריך להמשיך את שרשרת האכילה עד הסוף'); return; }
  }
  var mine = legal.filter(function (m) { return m.path[0] === i; });
  if (mine.length) {
    sel = { from: i, path: [i], cands: mine }; beep('move');
    say('נבחר כלי ב-' + D.name(i) + '. אפשר לזוז אל ' + uniq(mine.map(function (m) { return D.name(m.path[1]); })).join(', '));
    render(); return;
  }
  if (game.board[i] && D.sideOf(game.board[i]) === game.side) {
    if (legal.length && legal[0].caps.length) { toast('חובה לאכול! הכלים שיכולים לאכול מסומנים'); say('חובה לאכול'); }
    else toast('לכלי הזה אין מהלך כרגע');
  }
}
function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function cancelSel() { if (!sel) return; var el = pieceAt[sel.from]; if (el) placePiece(el, sel.from); sel = null; render(); }
$('cancelBtn').onclick = cancelSel;
function commit(mv) {
  var path = mv.path.slice();
  var el = pieceAt[sel.from]; if (el) placePiece(el, sel.from);
  sel = null;
  if (mode === 'local') {
    var before = game.board.slice(); var m = D.play(game, path);
    if (game.result) room.result = { winner: game.result.winner, reason: game.result.reason };
    animateMove(m, before, false); render(); return;
  }
  // optimistic: apply locally via the reducer
  var msg = { t: 'move', g: room.g, n: room.moves.length, path: path };
  onMsg({ t: 'move', g: msg.g, n: msg.n, path: path, id: myId }, true);
  publish(msg).catch(function () { toast('המהלך לא נשלח. בודק חיבור…'); });
}
function onBoardKey(e) {
  var keys = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  var cur = document.activeElement && document.activeElement.dataset ? +document.activeElement.dataset.i : NaN;
  if (isNaN(cur)) return;
  if (keys[e.key]) {
    e.preventDefault();
    var v = view(cur), d = keys[e.key], nr = v[0] + d[0], nc = v[1] + d[1];
    // move along the visual grid; skip light squares by stepping diagonally
    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) return;
    var r = flipped() ? 7 - nr : nr, c = flipped() ? 7 - nc : nc, i = D.idx(r, c);
    if (!D.isDark(i)) { var c2 = c + (c < 7 ? 1 : -1); i = D.idx(r, c2); }
    focusTo(i);
  } else if (e.key === 'Escape') { cancelSel(); }
}
function focusTo(i) {
  var all = $('board').querySelectorAll('.sq.dark'); all.forEach(function (s) { s.tabIndex = -1; });
  var el = sqEl(i); if (el) { el.tabIndex = 0; el.focus(); focusSq = i; }
}

/* ---------- actions ---------- */
$('resignBtn').onclick = function () {
  if (!room || room.result) return;
  if (mode === 'local') { confirmAsk('להיכנע בשם ' + (game.side === 1 ? 'הלבן' : 'השחור') + '?', function () { room.result = { winner: -game.side, reason: 'resign' }; render(); }); return; }
  confirmAsk('להיכנע ולסיים את המשחק?', function () { publish({ t: 'resign', g: room.g }).catch(function () {}); onMsg({ t: 'resign', g: room.g, id: myId }, true); });
};
$('drawBtn').onclick = function () {
  if (!room || room.result) return;
  if (mode === 'local') { confirmAsk('לסיים בתיקו?', function () { room.result = { winner: 0, reason: 'agreed' }; render(); }); return; }
  if (room.drawOffer && room.drawOffer.by === myId) { toast('כבר הצעת תיקו, מחכים לתשובה'); return; }
  publish({ t: 'drawoffer', g: room.g }).then(function () { toast('הצעת התיקו נשלחה'); }).catch(function () {});
};
$('drawYes').onclick = function () { publish({ t: 'drawreply', g: room.g, yes: true }).catch(function () {}); };
$('drawNo').onclick = function () { publish({ t: 'drawreply', g: room.g, yes: false }).catch(function () {}); };
$('rematchBtn').onclick = function () {
  closeDlg($('endDlg'));
  if (mode === 'local') { game = D.newGame(); room.result = null; sel = null; localGames++; layoutPieces(true); render(true); return; }
  publish({ t: 'new', g: room.g + 1 }).catch(function () {});
};
$('react').onclick = function (e) {
  var b = e.target.closest('button'); if (!b) return;
  floatEmo(b.dataset.e, false);
  if (mode === 'online') publish({ t: 'emo', e: b.dataset.e }, true).catch(function () {});
};
function shareUrl() { return location.origin + location.pathname + '?r=' + room.code; }
$('shareBtn').onclick = function () {
  var data = { title: 'דמקה', text: 'בוא לשחק איתי דמקה! קוד החדר: ' + room.code, url: shareUrl() };
  if (navigator.share) navigator.share(data).catch(function () {}); else $('copyBtn').click();
};
$('copyBtn').onclick = function () {
  var u = shareUrl();
  (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { toast('הקישור הועתק'); }, function () { toast(u); });
};

/* ---------- render ---------- */
var lastFlip = null, shownResultFor = null;
function setStatus(t, pill) { var s = $('status'); s.textContent = ''; if (pill) { var p = document.createElement('span'); p.className = 'pill'; p.textContent = pill; s.appendChild(p); } s.appendChild(document.createTextNode(t)); }
function nameFor(id, fallback) { return (id && room.names[id]) || fallback; }
function fillPlayer(el, side, id, isMe) {
  el.querySelector('.chip').className = 'chip ' + (side === 1 ? 'w' : 'b');
  el.querySelector('.nm').textContent = id ? nameFor(id, 'שחקן') + (isMe && mode === 'online' ? ' (אתה)' : '') : 'מחכה לשחקן…';
  var online = mode === 'local' || (id && (id === myId || Date.now() - (room.lastSeen[id] || 0) < 50000));
  el.querySelector('.online').className = 'online' + (online && id ? ' on' : '');
  el.querySelector('.st').textContent = (side === 1 ? 'לבן' : 'שחור') + (mode === 'online' && id && id !== myId ? (online ? ' · מחובר' : ' · לא מחובר') : '');
  el.classList.toggle('turn', !room.result && game.side === side && !!room.seats.w && !!room.seats.b);
  el.setAttribute('aria-label', (side === 1 ? 'לבן: ' : 'שחור: ') + el.querySelector('.nm').textContent + (el.classList.contains('turn') ? ', בתור' : ''));
}
function render(force) {
  if (!room || $('game').hidden) return;
  mySide = mode === 'online' ? seatOf(myId) : 0;
  if (lastFlip !== flipped()) { lastFlip = flipped(); buildBoard(); }
  if (force) layoutPieces(true); else if (!animating) layoutPieces(false);

  var bottomSide = flipped() ? -1 : 1;
  fillPlayer($('plBottom'), bottomSide, bottomSide === 1 ? room.seats.w : room.seats.b, true);
  fillPlayer($('plTop'), -bottomSide, -bottomSide === 1 ? room.seats.w : room.seats.b, false);

  var waiting = mode === 'online' && room.ready && (!room.seats.w || !room.seats.b);
  $('waitBanner').hidden = !(waiting && mySide !== 0);
  $('bigCode').textContent = room.code;
  $('roomHint').textContent = mode === 'online' ? 'קוד החדר: ' + room.code + (mySide === 0 && room.seats.b ? ' · אתה צופה' : '') : 'משחק על מכשיר אחד: מעבירים את הטלפון בין התורות.';

  var cnt = D.count(game.board);
  $('cntW').textContent = cnt.w; $('cntB').textContent = cnt.b;
  $('moveNo').textContent = 'מהלך ' + (Math.floor(room.moves.length / 2) + 1 + (mode === 'local' ? Math.floor(game.history.length / 2) : 0));

  // status line
  if (!room.ready) setStatus('מתחבר לחדר…');
  else if (room.result) setStatus(resultText().short);
  else if (waiting) setStatus('מחכים שהחבר ייכנס…');
  else {
    var mustCap = game.legal.length && game.legal[0].caps.length;
    var turnName = game.side === 1 ? 'לבן' : 'שחור';
    if (mode === 'local') setStatus('התור של ה' + turnName, mustCap ? 'חובה לאכול' : null);
    else if (mySide === game.side) setStatus(sel && sel.path.length > 1 ? 'המשך את שרשרת האכילה' : 'התור שלך', mustCap ? 'חובה לאכול' : null);
    else if (mySide) setStatus('היריב חושב…');
    else setStatus('התור של ה' + turnName);
  }

  // squares
  var movable = {}, targets = {}, capTargets = {};
  if (canAct()) {
    if (sel) sel.cands.forEach(function (m) { var t = m.path[sel.path.length]; if (t !== undefined) { targets[t] = 1; if (m.caps.length) capTargets[t] = 1; } });
    else game.legal.forEach(function (m) { movable[m.path[0]] = 1; });
  }
  var last = game.history[game.history.length - 1];
  var lastSet = {}; if (last) last.path.forEach(function (p) { lastSet[p] = 1; });
  var anyFocusable = false;
  $('board').querySelectorAll('.sq.dark').forEach(function (s) {
    var i = +s.dataset.i, v = game.board[i];
    s.classList.toggle('movable', !!movable[i]);
    s.classList.toggle('target', !!targets[i]);
    s.classList.toggle('capt', !!capTargets[i]);
    s.classList.toggle('sel', !!sel && sel.path[sel.path.length - 1] === i);
    s.classList.toggle('last', !!lastSet[i] && !sel);
    var piece = v === 0 ? 'ריקה' : (v > 0 ? 'לבן' : 'שחור') + (Math.abs(v) === 2 ? ' מלך' : '');
    var extra = movable[i] ? ', אפשר להזיז' : targets[i] ? ', יעד אפשרי' : '';
    s.setAttribute('aria-label', D.name(i) + ', ' + piece + extra);
    if (i === focusSq) { s.tabIndex = 0; anyFocusable = true; } else s.tabIndex = -1;
  });
  if (!anyFocusable) { var first = $('board').querySelector('.sq.movable') || $('board').querySelector('.sq.dark'); if (first) first.tabIndex = 0; }
  // piece states: can move, under threat, captured mid-chain, lifted
  if (!animating) {
    var threat = {}, dead = {};
    if (canAct()) {
      if (sel) {
        sel.cands.forEach(function (m) { var c = m.caps[sel.path.length - 1]; if (c !== undefined) threat[c] = 1; });
        sel.cands[0].caps.slice(0, sel.path.length - 1).forEach(function (c) { dead[c] = 1; });
      } else game.legal.forEach(function (m) { if (m.caps.length) threat[m.caps[0]] = 1; });
    }
    for (var k in pieceAt) {
      var pe = pieceAt[k], ki = +k;
      pe.classList.toggle('can', !sel && !!movable[ki]);
      pe.classList.toggle('threat', !!threat[ki] && !dead[ki]);
      pe.classList.toggle('dead', !!dead[ki]);
    }
    if (sel && pieceAt[sel.from]) pieceAt[sel.from].classList.add('lift');
    else for (var q in pieceAt) pieceAt[q].classList.remove('lift');
  }
  drawPaths(false);
  var myTurn = canAct() && !waiting;
  $('stage').classList.toggle('myturn', myTurn);
  if (myTurn && !wasMyTurn && mode === 'online') { restart($('status'), 'flash'); beep('tick'); }
  wasMyTurn = myTurn;

  $('cancelBtn').hidden = !sel;
  var playing = !room.result && room.ready && !waiting;
  $('drawBtn').disabled = !playing || (mode === 'online' && !mySide);
  $('resignBtn').disabled = !playing || (mode === 'online' && !mySide);
  $('react').hidden = mode !== 'online' || !mySide;

  // draw offer banner
  var offerToMe = mode === 'online' && room.drawOffer && room.drawOffer.by !== myId && mySide && !room.result;
  $('drawBanner').hidden = !offerToMe;
  if (offerToMe) $('drawText').textContent = nameFor(room.drawOffer.by, 'היריב') + ' מציע תיקו.';

  // end of game
  var rkey = room.result ? room.g + ':' + room.moves.length + ':' + room.result.reason : null;
  if (room.result && shownResultFor !== rkey && room.ready && !animating) {
    shownResultFor = rkey;
    var rt = resultText();
    $('endBig').textContent = rt.big; $('endText').textContent = rt.long;
    $('rematchBtn').hidden = mode === 'online' && !mySide;
    openDlg($('endDlg'));
    if (rt.win) { confetti(); beep('win'); buzz([60, 40, 120]); }
    say(rt.big + '. ' + rt.long);
  }
}
function resultText() {
  var r = room.result, why = { captured: 'כל הכלים נאכלו', blocked: 'לא נשארו מהלכים', resign: 'כניעה', agreed: 'בהסכמה', repetition: 'אותו מצב חזר 3 פעמים', kings15: '15 מהלכים של מלכים בלי אכילה' }[r.reason];
  if (r.winner === 0) return { big: 'תיקו', short: 'תיקו (' + why + ')', long: why, win: false };
  var winName = r.winner === 1 ? 'הלבן' : 'השחור';
  if (mode === 'online' && mySide) {
    var iWon = r.winner === mySide;
    return { big: iWon ? 'ניצחת!' : 'הפסדת', short: (iWon ? 'ניצחת' : 'הפסדת') + ' · ' + why, long: why + '.', win: iWon };
  }
  var wid = r.winner === 1 ? room.seats.w : room.seats.b;
  return { big: mode === 'local' ? winName + ' ניצח!' : nameFor(wid, winName) + ' ניצח', short: winName + ' ניצח · ' + why, long: why + '.', win: true };
}

/* ---------- boot ---------- */
var params = new URLSearchParams(location.search);
var r0 = (params.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (r0.length === 5) {
  if (!myName) { $('codeIn').value = r0; $('nameIn').focus(); $('joinErr').textContent = ''; toast('כתוב את השם שלך ולחץ "הצטרפות למשחק"'); }
  else startOnline(r0, false);
}
})();
