(function () {
'use strict';
var B = window.BS;
var NTFY = 'https://ntfy.sh';
var PREFIX = 'battleship-kiosk-v1-';
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var $ = function (id) { return document.getElementById(id); };
var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- storage ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function rid(n) { var s = ''; var a = new Uint32Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += CODE_CHARS[a[i] % CODE_CHARS.length]; return s; }
var myId = lsGet('dmk_id') || rid(12); lsSet('dmk_id', myId);
var myName = lsGet('dmk_name') || '';
$('nameIn').value = myName;
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* ---------- sound + haptics ---------- */
var soundOn = lsGet('bs_sound') !== '0', actx = null;
function syncSound() { $('soundBtn').setAttribute('aria-pressed', String(soundOn)); $('soundBtn').textContent = soundOn ? '🔊' : '🔇'; }
syncSound();
$('soundBtn').onclick = function () { soundOn = !soundOn; lsSet('bs_sound', soundOn ? '1' : '0'); syncSound(); if (soundOn) sfx('ping'); };
function ctx() { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); return actx; }
function tone(f, dur, type, delay, vol, f2) {
  var a = ctx(), t = a.currentTime + (delay || 0), o = a.createOscillator(), g = a.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || .15, t + .01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + .05);
}
function noise(dur, type, freq, vol, freq2, delay) {
  var a = ctx(), t = a.currentTime + (delay || 0), n = Math.floor(a.sampleRate * dur);
  var buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  var src = a.createBufferSource(); src.buffer = buf;
  var f = a.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); if (freq2) f.frequency.exponentialRampToValueAtTime(freq2, t + dur);
  var g = a.createGain(); g.gain.setValueAtTime(vol, t);
  src.connect(f); f.connect(g); g.connect(a.destination); src.start(t);
}
function sfx(kind) {
  if (!soundOn) return;
  try {
    if (kind === 'whistle') tone(1400, .6, 'sine', 0, .06, 500);
    else if (kind === 'boom') { noise(1.1, 'lowpass', 900, .9, 80); tone(70, .7, 'sine', 0, .35, 35); }
    else if (kind === 'bigboom') { noise(1.8, 'lowpass', 1200, 1, 60); tone(60, 1.2, 'sine', 0, .45, 28); noise(.9, 'lowpass', 600, .6, 70, .35); }
    else if (kind === 'splash') { noise(.7, 'bandpass', 2400, .35, 600); tone(300, .25, 'sine', 0, .05, 120); }
    else if (kind === 'ping') { tone(1250, .5, 'sine', 0, .12); tone(1250, .5, 'sine', .35, .04); }
    else if (kind === 'place') tone(520, .08, 'triangle', 0, .14, 700);
    else if (kind === 'bad') tone(180, .18, 'square', 0, .08, 120);
    else if (kind === 'win') [523, 659, 784, 1047].forEach(function (f, i) { tone(f, .3, 'triangle', i * .12, .14); });
    else if (kind === 'lose') [392, 330, 262].forEach(function (f, i) { tone(f, .4, 'triangle', i * .18, .12); });
  } catch (e) {}
}
function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

/* ---------- toast / live ---------- */
var toastT;
function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600); }
function say(msg) { var l = $('live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }

/* ---------- state ---------- */
var room = null, seen = {}, es = null, lastMsgId = null, pingTimer = null, reconnectTimer = null;
var myLayout = [], salt = null;
var view = 'mine', selShip = null, selDir = 'h', aim = null, weapon = 'shot', wdir = 'h';
var held = {}, shotTime = {}, answered = {}, revealSent = {}, endShownFor = null, autoTimer = null, wasMyTurn = false;
var verifyCache = {};

function freshRoom(code) {
  return { code: code, g: 0, seats: { a: null, b: null }, names: {}, ready: { a: null, b: null }, shots: [], over: null, reveals: {}, lastSeen: {}, loaded: false };
}
function seatKey(id) { return !room ? null : room.seats.a === id ? 'a' : room.seats.b === id ? 'b' : null; }
function other(k) { return k === 'a' ? 'b' : 'a'; }
function me() { return seatKey(myId); }
function opp() { var m = me(); return m ? other(m) : null; }
function shooterSeat(n) {
  var cur = room.g % 2 === 0 ? 'a' : 'b';
  for (var k = 0; k < n && k < room.shots.length; k++) { var s = room.shots[k]; if (!s.res || !B.extraTurn(s)) cur = other(cur); }
  return cur;
}
function sunkShipsOf(seat) {
  var out = {};
  room.shots.forEach(function (s) { if (s.by === other(seat) && s.res) s.res.cells.forEach(function (c) { if (c.sunk) out[c.sunk] = 1; }); });
  return out;
}
function usesLeft(seat, w) {
  var W = B.WEAPONS[w]; if (!W) return 0;
  if (W.ship && sunkShipsOf(seat)[W.ship]) return 0;
  if (W.uses === Infinity) return Infinity;
  return Math.max(0, W.uses - room.shots.filter(function (s) { return s.by === seat && s.w === w; }).length);
}
function firedCells(shots) { var out = []; shots.forEach(function (s) { if (s.res) s.res.cells.forEach(function (c) { out.push(c.i); }); }); return out; }
function bothReady() { return !!(room.ready.a && room.ready.b); }
function lastResolved() { var s = room.shots; return !s.length || (!!s[s.length - 1].res && !held[s[s.length - 1].n]); }
function lastAnswered() { var s = room.shots; return !s.length || !!s[s.length - 1].res; }
function inBattle() { return bothReady() && !room.over; }
function isMyTurn() { return inBattle() && !!me() && lastResolved() && shooterSeat(room.shots.length) === me(); }
function myShots() { return room.shots.filter(function (s) { return s.by === me(); }); }
function oppShots() { return room.shots.filter(function (s) { return s.by === opp(); }); }
function lkey() { return 'bs_L_' + room.code + '_' + room.g + '_' + myId; }
function saveLocal() { lsSet(lkey(), JSON.stringify({ layout: myLayout, salt: salt })); }
function loadLocal() {
  myLayout = []; salt = null;
  try { var d = JSON.parse(lsGet(lkey()) || 'null'); if (d) { myLayout = (d.layout || []).filter(function (s) { return B.spec(s.id); }); salt = d.salt || null; } } catch (e) {}
  selShip = nextUnplaced(); selDir = 'h';
}
function nextUnplaced() { for (var i = 0; i < B.FLEET.length; i++) if (!shipById(B.FLEET[i].id)) return B.FLEET[i].id; return null; }
function shipById(id) { for (var i = 0; i < myLayout.length; i++) if (myLayout[i].id === id) return myLayout[i]; return null; }

/* ---------- networking (ntfy.sh) ---------- */
function topic() { return PREFIX + room.code; }
function publish(msg, ephemeral) {
  msg.id = myId; msg.v = 1;
  return fetch(NTFY + '/' + topic() + (ephemeral ? '?cache=no' : ''), { method: 'POST', body: JSON.stringify(msg) })
    .then(function (r) { if (!r.ok) throw new Error('http'); })
    .catch(function () { toast('אין חיבור לשרת. בודק שוב…'); throw new Error('net'); });
}
function handleRaw(ev) {
  if (!ev || ev.event !== 'message' || seen[ev.id] || !room) return;
  seen[ev.id] = 1; lastMsgId = ev.id;
  var m; try { m = JSON.parse(ev.message); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.id !== 'string') return;
  onMsg(m, room.loaded);
}
function loadHistory() {
  return fetch(NTFY + '/' + topic() + '/json?poll=1&since=all')
    .then(function (r) { if (!r.ok) throw new Error('http'); return r.text(); })
    .then(function (txt) { txt.split('\n').forEach(function (line) { if (!line.trim()) return; try { handleRaw(JSON.parse(line)); } catch (e) {} }); });
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
  reconnectTimer = setTimeout(function () { if (room) loadHistory().catch(function () {}).then(function () { openStream(); afterSync(); }); }, 2500);
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && room) loadHistory().catch(function () {}).then(function () { openStream(); ping(); afterSync(); });
});
function ping() { if (room) publish({ t: 'ping', name: myName }, true).catch(function () {}); }

/* ---------- reducer ---------- */
function onMsg(m, live) {
  if (m.name && typeof m.name === 'string') room.names[m.id] = m.name.slice(0, 16);
  room.lastSeen[m.id] = Date.now();
  var k = seatKey(m.id);
  switch (m.t) {
    case 'seat':
      if ((m.side === 'a' || m.side === 'b') && !room.seats[m.side] && !k) room.seats[m.side] = m.id;
      break;
    case 'ready':
      if (m.g === room.g && k && !room.ready[k] && typeof m.commit === 'string') {
        room.ready[k] = m.commit.slice(0, 80);
        if (live && k !== me()) { sfx('ping'); toast('היריב סידר את הצי'); }
        if (live && bothReady() && me()) {
          setTimeout(function () { if (!room || !inBattle()) return; bigText('לקרב!'); sfx('bigboom'); setView(isMyTurn() ? 'enemy' : 'mine'); }, 500);
        }
      }
      break;
    case 'shot':
      if (m.g !== room.g || room.over || !bothReady() || m.n !== room.shots.length || !lastAnswered()) break;
      if (!k || k !== shooterSeat(m.n)) break;
      var idx = Number(m.i); if (!(idx >= 0 && idx < 100 && idx % 1 === 0)) break;
      var w = B.WEAPONS[m.w] ? m.w : 'shot';
      if (usesLeft(k, w) < 1) break;
      var s = { n: m.n, by: k, idx: idx, w: w, d: m.d === 'v' ? 'v' : 'h', res: null };
      room.shots.push(s); shotTime[m.n] = Date.now();
      if (live) shellFx(s);
      maybeAnswer(live);
      break;
    case 'result':
      var sh = room.shots[m.n];
      if (!sh || m.g !== room.g || sh.res || !k || k === sh.by) break;
      var rc = (Array.isArray(m.r) ? m.r : []).slice(0, 10).map(function (c) {
        c = c || {};
        var sunk = typeof c.sunk === 'string' && B.spec(c.sunk) ? c.sunk : null;
        var cs = sunk && Array.isArray(c.cells) ? c.cells.map(Number).filter(function (x) { return x >= 0 && x < 100; }) : null;
        return { i: Number(c.i), hit: !!c.hit, sunk: sunk, cells: cs && cs.length === B.spec(sunk).len ? cs : null };
      }).filter(function (c) { return c.i >= 0 && c.i < 100 && c.i % 1 === 0; });
      sh.res = { cells: rc, over: !!m.over, found: sh.w === 'sonar' ? !!m.found : null };
      if (sh.res.over) room.over = { winner: sh.by, reason: 'fleet' };
      if (live) resultFx(sh);
      break;
    case 'resign':
      if (m.g === room.g && !room.over && k) room.over = { winner: other(k), reason: 'resign' };
      break;
    case 'reveal':
      if (m.g === room.g && k && Array.isArray(m.layout) && typeof m.salt === 'string') room.reveals[k] = { layout: m.layout, salt: m.salt };
      break;
    case 'new':
      if (m.g === room.g + 1 && room.over && k) {
        room.g = m.g; room.ready = { a: null, b: null }; room.shots = []; room.over = null; room.reveals = {};
        held = {}; aim = null; weapon = 'shot'; loadLocal(); clearBoardEls();
        if (live) { closeDlg($('endDlg')); toast('משחק חדש! סדרו את הצי מחדש'); setView('mine'); }
      }
      break;
    case 'emo':
      if (live && m.id !== myId && ['💥', '😂', '😱', '🫡', '🔥'].indexOf(m.e) !== -1) floatEmo(m.e, true);
      break;
  }
  if (live) { maybeReveal(); render(); }
}

// I'm the defender: answer the newest unanswered shot with the truth from my private layout.
function maybeAnswer() {
  if (!room.loaded) return;
  var s = room.shots[room.shots.length - 1];
  if (!s || s.res || s.by !== opp() || answered[room.g + ':' + s.n]) return;
  if (!B.validLayout(myLayout) || !room.ready[me()]) return;
  answered[room.g + ':' + s.n] = 1;
  var prior = firedCells(oppShots().filter(function (x) { return x.n < s.n; }));
  var r = B.volley(myLayout, prior, s.w, s.idx, s.d);
  var msg = { t: 'result', g: room.g, n: s.n, r: r.cells, over: r.over, found: r.found };
  publish(msg).catch(function () { answered[room.g + ':' + s.n] = 0; });
  onMsg({ t: 'result', g: msg.g, n: msg.n, r: r.cells, over: r.over, found: r.found, id: myId }, room.loaded);
}
function maybeReveal() {
  if (!room.over || !me() || revealSent[room.code + room.g] || !B.validLayout(myLayout) || !salt) return;
  revealSent[room.code + room.g] = 1;
  publish({ t: 'reveal', g: room.g, layout: myLayout, salt: salt }).catch(function () { revealSent[room.code + room.g] = 0; });
}
function afterSync() { if (!room) return; maybeAnswer(); maybeReveal(); render(); }

/* ---------- fairness check ---------- */
function sha(str) {
  try {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  } catch (e) {
    var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Promise.resolve('f' + (h >>> 0).toString(16));
  }
}
function verifyOpp() {
  var o = opp(), rv = o && room.reveals[o];
  if (!rv) return Promise.resolve(null);
  var key = room.g + ':' + JSON.stringify(rv);
  if (verifyCache[key] !== undefined) return Promise.resolve(verifyCache[key]);
  return sha(B.canonical(rv.layout) + '|' + rv.salt).then(function (h) {
    var shots = myShots().filter(function (s) { return s.res; }).map(function (s) { return { w: s.w, i: s.idx, d: s.d, res: s.res }; });
    var ok = h === room.ready[o] && B.auditVolleys(rv.layout, shots);
    verifyCache[key] = ok; return ok;
  });
}

/* ---------- rooms ---------- */
function saveName() { myName = ($('nameIn').value || '').trim().slice(0, 16) || 'קפטן'; lsSet('dmk_name', myName); }
function startRoom(code, creating) {
  saveName();
  room = freshRoom(code); seen = {}; lastMsgId = null; held = {}; answered = {}; aim = null; endShownFor = null;
  $('home').hidden = true; $('game').hidden = false;
  buildGrid(); loadLocal(); setView('mine', true);
  setStatus('מתחבר לחדר…');
  try { history.replaceState(null, '', location.pathname + '?r=' + code); } catch (e) {}
  loadHistory().then(function () {
    room.loaded = true;
    loadLocal();
    if (!creating && !room.seats.a && !room.seats.b) {
      leave(); $('codeIn').value = code;
      $('joinErr').textContent = 'לא מצאתי חדר עם הקוד ' + code + '. בדוק את הקוד, או בקש מהחבר לפתוח חדר חדש.';
      throw new Error('noroom');
    }
    if (!me()) {
      if (creating || !room.seats.a) return publish({ t: 'seat', side: 'a', name: myName });
      if (!room.seats.b) return publish({ t: 'seat', side: 'b', name: myName });
      toast('החדר מלא. אתה צופה.');
    } else ping();
  }).then(function () { return true; }, function (e) {
    if (e && e.message === 'noroom') return false;
    if (!room) return false;
    room.loaded = true; setStatus('אין חיבור לשרת המשחק. בדוק אינטרנט ונסה שוב.'); return true;
  }).then(function (go) {
    if (!go || !room) return;
    openStream(); afterSync();
    if (inBattle()) setView(isMyTurn() ? 'enemy' : 'mine', true);
    clearInterval(pingTimer); pingTimer = setInterval(function () { ping(); render(); }, 20000);
    setTimeout(ping, 800);
  });
}
function leave() {
  if (es) es.close(); es = null; clearInterval(pingTimer); clearTimeout(reconnectTimer);
  room = null;
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  $('game').hidden = true; $('home').hidden = false;
}
$('createBtn').onclick = function () { startRoom(rid(5), true); };
$('joinBtn').onclick = function () {
  var c = ($('codeIn').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 5) { $('joinErr').textContent = 'הקוד צריך להיות 5 תווים, באותיות באנגלית או ספרות.'; $('codeIn').focus(); return; }
  $('joinErr').textContent = ''; startRoom(c, false);
};
$('codeIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('joinBtn').click(); });
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

/* ---------- board ---------- */
var shipEls = {}, markEls = {};
function cs() { return $('grid').getBoundingClientRect ? $('grid').offsetWidth / 10 : 34; }
function syncCs() { document.documentElement.style.setProperty('--cs', cs() + 'px'); }
window.addEventListener('resize', function () { syncCs(); clearBoardEls(); render(); sizeFx(); });
function buildGrid() {
  var g = $('grid'); g.innerHTML = '';
  for (var i = 0; i < 100; i++) {
    var c = document.createElement('button');
    c.type = 'button'; c.className = 'cell'; c.dataset.i = i; c.tabIndex = i === 0 ? 0 : -1;
    c.setAttribute('role', 'gridcell');
    g.appendChild(c);
  }
  var x = $('coordX'), y = $('coordY'); x.innerHTML = ''; y.innerHTML = '';
  for (var k = 0; k < 10; k++) { var a = document.createElement('span'); a.textContent = 'ABCDEFGHIJ'[k]; x.appendChild(a); var b = document.createElement('span'); b.textContent = k + 1; y.appendChild(b); }
  g.onclick = function (e) { var t = e.target.closest('.cell'); if (t) cellTap(+t.dataset.i); };
  g.onkeydown = function (e) {
    var cur = document.activeElement && document.activeElement.dataset ? +document.activeElement.dataset.i : NaN;
    if (isNaN(cur)) return;
    var d = { ArrowUp: -10, ArrowDown: 10, ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    var n = cur + d; if (n < 0 || n > 99 || (Math.abs(d) === 1 && Math.floor(n / 10) !== Math.floor(cur / 10))) return;
    focusCell(n);
  };
  setTimeout(function () { syncCs(); sizeFx(); render(); }, 0);
}
function focusCell(i) { var all = $('grid').children; for (var k = 0; k < all.length; k++) all[k].tabIndex = -1; all[i].tabIndex = 0; all[i].focus(); }
function clearBoardEls() { $('ships').innerHTML = ''; $('marks').innerHTML = ''; shipEls = {}; markEls = {}; }
function setView(v, quiet) {
  if (view === v && !quiet) return;
  var changed = view !== v;
  view = v; aim = null; clearBoardEls();
  if (changed && !quiet && !reduced) { var b = $('board3d'); b.classList.remove('swap'); void b.offsetWidth; b.classList.add('swap'); }
  render();
}
$('tabEnemy').onclick = function () { if (placing()) { toast('קודם צריך לסדר את הצי'); return; } setView('enemy'); };
$('tabMine').onclick = function () { setView('mine'); };

function shipHTML(s, extra) {
  var f = B.spec(s.id), size = cs(), len = f.len;
  var x = s.x * size, y = s.y * size;
  var cls = 'ship ' + (s.dir === 'v' ? 'v ' : '') + (extra || '');
  var slabs = '';
  var cols = /enemy/.test(extra || '') ? ['#2a0d0a', '#3a120e', '#4a1712', '#5a1d16', '#6b231b', '#7a2a21', '#8a3027', '#9a382d']
    : ['#141c22', '#1c262e', '#24313b', '#2e3c48', '#384855', '#435463', '#4f6170', '#5c6f7e'];
  for (var k = 0; k < 8; k++) slabs += '<div class="slab" style="transform:translateZ(' + (k + 1) + 'px);background:' + cols[k] + '"></div>';
  var parts = '';
  function tower(l, t, w, h) { parts += '<div class="part tower" style="left:' + l + '%;top:' + t + '%;width:' + w + '%;height:' + h + '%;border-radius:3px"><i></i><i></i><i></i><i></i></div>'; }
  function gun(l) { parts += '<div class="part gun" style="left:' + l + '%;top:30%;width:calc(var(--cs) * .4);height:calc(var(--cs) * .4)"><i></i><i></i><b></b></div>'; }
  if (s.id === 'carrier') { parts += '<div class="runway"></div>'; tower(64, 4, 12, 26); }
  else if (s.id === 'battleship') { gun(8); gun(26); tower(46, 24, 16, 52); gun(66); }
  else if (s.id === 'destroyer') { gun(10); tower(40, 24, 20, 52); gun(66); }
  else if (s.id === 'sub') { tower(38, 32, 18, 36); }
  else { tower(26, 26, 26, 48); gun(60); }
  return '<div class="' + cls + '" style="left:' + x + 'px;top:' + y + 'px;width:' + (s.dir === 'h' ? len * size : size) + 'px;height:' + (s.dir === 'v' ? len * size : size) + 'px">' +
    '<div class="hullbox" style="width:' + len * size + 'px"><div class="wake"></div>' + slabs + '<div class="deck"></div>' + parts + '</div></div>';
}
function shipFromCells(id, cells) {
  var c = cells.slice().sort(function (a, b) { return a - b; });
  return { id: id, x: c[0] % 10, y: Math.floor(c[0] / 10), dir: c.length > 1 && c[1] - c[0] === 1 ? 'h' : 'v' };
}
// The ships and marks shown on the current board
function boardModel() {
  var ships = [], marks = {}, pending = [], scans = [];
  var mine = view === 'mine';
  var shots = mine ? oppShots() : myShots();
  var hitSet = {};
  shots.forEach(function (s) { if (s.res && !held[s.n]) s.res.cells.forEach(function (c) { if (c.hit) hitSet[c.i] = 1; }); });
  if (mine) {
    myLayout.forEach(function (s) {
      var cells = B.cellsOf(s), nHit = cells.filter(function (c) { return hitSet[c]; }).length;
      var st = nHit === cells.length ? 'sunk' : nHit ? 'hit-any' : '';
      ships.push({ key: 'm' + s.id + s.x + s.y + s.dir, s: s, cls: st + (selShip === s.id && placing() ? ' selected' : ''), sunk: st === 'sunk' });
    });
  } else {
    var sunkIds = {};
    shots.forEach(function (s) {
      if (!s.res || held[s.n]) return;
      s.res.cells.forEach(function (c) { if (c.sunk && c.cells && !sunkIds[c.sunk]) { sunkIds[c.sunk] = 1; ships.push({ key: 'e' + c.sunk, s: shipFromCells(c.sunk, c.cells), cls: 'enemy', sunk: true }); } });
    });
    var rv = room.over && opp() && room.reveals[opp()];
    if (rv && B.validLayout(rv.layout)) rv.layout.forEach(function (s) { if (!sunkIds[s.id]) ships.push({ key: 'r' + s.id, s: s, cls: 'reveal', sunk: false }); });
  }
  var sunkCells = {};
  ships.forEach(function (o) { if (o.sunk) B.cellsOf(o.s).forEach(function (c) { sunkCells[c] = 1; }); });
  shots.forEach(function (s) {
    if (!s.res) { pending = B.pattern(s.w, s.idx, s.d); if (s.w === 'torpedo') pending = [s.idx]; return; }
    if (held[s.n]) return;
    if (s.w === 'sonar') { scans.push({ cells: B.pattern('sonar', s.idx), found: s.res.found }); return; }
    s.res.cells.forEach(function (c) {
      var prev = marks[c.i];
      marks[c.i] = { key: (mine ? 'm' : 'e') + c.i, idx: c.i, hit: c.hit || (prev && prev.hit), low: !mine || !!sunkCells[c.i] };
    });
  });
  return { ships: ships, marks: Object.keys(marks).map(function (k) { return marks[k]; }), pending: pending, scans: scans };
}
function renderBoard() {
  var mdl = boardModel();
  // ships (kept between renders so bobbing and sinking animations don't restart)
  var want = {};
  mdl.ships.forEach(function (o) {
    want[o.key] = 1;
    var el = shipEls[o.key];
    if (!el) {
      var tmp = document.createElement('div'); tmp.innerHTML = shipHTML(o.s, o.cls); el = tmp.firstChild;
      if (o.sunk) el.classList.add('instant');
      $('ships').appendChild(el); shipEls[o.key] = el;
    } else {
      var base = 'ship ' + (o.s.dir === 'v' ? 'v ' : '') + o.cls + (el.classList.contains('instant') ? ' instant' : '');
      if (el.className !== base) el.className = base;
    }
  });
  for (var k in shipEls) if (!want[k]) { shipEls[k].remove(); delete shipEls[k]; }
  // marks
  var wantM = {};
  mdl.marks.forEach(function (o) {
    var key = o.key + (o.hit ? 'h' : 'm') + (o.low ? 'l' : '');
    wantM[key] = 1;
    if (markEls[key]) return;
    var el = document.createElement('div');
    el.className = 'mark ' + (o.hit ? 'hit' : 'miss') + (o.low ? ' low' : '');
    el.style.left = (o.idx % 10) * 10 + '%'; el.style.top = Math.floor(o.idx / 10) * 10 + '%';
    el.innerHTML = o.hit ? '<div class="scorch"></div><div class="x"></div><div class="bill flame"><i></i><i></i><i></i></div><div class="bill smoke"><i></i><i></i><i></i></div>'
      : '<div class="rip"></div><div class="rip"></div><div class="peg"></div>';
    $('marks').appendChild(el); markEls[key] = el;
  });
  for (var j in markEls) if (!wantM[j]) { markEls[j].remove(); delete markEls[j]; }
  // cells: aim, pending, labels
  var shots = view === 'mine' ? oppShots() : myShots(), byIdx = {};
  shots.forEach(function (s) {
    if (!s.res) { byIdx[s.idx] = s; return; }
    s.res.cells.forEach(function (c) { var o = byIdx[c.i]; byIdx[c.i] = { res: { hit: c.hit || (o && o.res && o.res.hit), sunk: c.sunk || (o && o.res && o.res.sunk) } }; });
  });
  var occupied = {};
  if (view === 'mine') myLayout.forEach(function (s) { B.cellsOf(s).forEach(function (c) { occupied[c] = B.spec(s.id).name; }); });
  var aimSet = {};
  if (aim !== null && view === 'enemy') B.pattern(weapon, aim, wdir).forEach(function (c) { aimSet[c] = 1; });
  var scanState = {};
  mdl.scans.forEach(function (sc) { sc.cells.forEach(function (c) { if (scanState[c] !== 1) scanState[c] = sc.found ? 1 : 2; }); });
  var cells = $('grid').children;
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i], s = byIdx[i];
    c.classList.toggle('aim', aim === i);
    c.classList.toggle('aimarea', !!aimSet[i] && aim !== i);
    c.classList.toggle('pending', mdl.pending.indexOf(i) !== -1);
    c.classList.toggle('scan-yes', scanState[i] === 1);
    c.classList.toggle('scan-no', scanState[i] === 2);
    var st = !s ? 'לא נורה' : !s.res ? 'ממתין לתשובה' : s.res.sunk ? 'פגיעה, אונייה טבעה' : s.res.hit ? 'פגיעה' : 'החטאה';
    var lbl = B.name(i) + ', ' + st + (occupied[i] ? ', ' + occupied[i] : '');
    if (c.getAttribute('aria-label') !== lbl) c.setAttribute('aria-label', lbl);
  }
  $('board3d').classList.toggle('targeting', view === 'enemy' && isMyTurn());
  $('grid').setAttribute('aria-label', view === 'mine' ? 'הצי שלי' : 'הים של היריב');
}

/* ---------- placement ---------- */
function placing() { return !!room && !!me() && !room.ready[me()]; }
function clampShip(s) {
  var len = B.spec(s.id).len;
  if (s.dir === 'h' && s.x + len > 10) s.x = 10 - len;
  if (s.dir === 'v' && s.y + len > 10) s.y = 10 - len;
  return s;
}
function putShip(s) {
  myLayout = myLayout.filter(function (o) { return o.id !== s.id; }).concat([s]);
  saveLocal();
}
function placementTap(i) {
  var x = i % 10, y = Math.floor(i / 10);
  var hitShip = null;
  myLayout.forEach(function (s) { if (B.cellsOf(s).indexOf(i) !== -1) hitShip = s; });
  if (hitShip && hitShip.id !== selShip) {
    selShip = hitShip.id; selDir = hitShip.dir; sfx('place');
    toast('בחרת ' + B.spec(hitShip.id).name + '. לחץ על משבצת כדי להזיז, או סובב');
    render(); return;
  }
  if (!selShip) { toast('בחר אונייה מהרשימה למטה'); return; }
  var s = clampShip({ id: selShip, x: x, y: y, dir: selDir });
  if (!B.canPlace(myLayout, s)) { sfx('bad'); buzz(40); toast('אין מקום כאן, יש שם אונייה אחרת'); flashCells(B.cellsOf(s), 'ghost-bad'); return; }
  putShip(s); sfx('place'); buzz(15); flashCells(B.cellsOf(s), 'ghost-ok');
  say(B.spec(s.id).name + ' הוצבה ב-' + B.name(B.cellsOf(s)[0]));
  selShip = nextUnplaced(); if (selShip) selDir = 'h';
  render();
}
function flashCells(list, cls) {
  var cells = $('grid').children;
  list.forEach(function (c) { if (c >= 0 && cells[c]) { cells[c].classList.add(cls); } });
  setTimeout(function () { list.forEach(function (c) { if (c >= 0 && cells[c]) cells[c].classList.remove(cls); }); }, 450);
}
$('rotateBtn').onclick = function () {
  var id = selShip || (myLayout.length ? myLayout[myLayout.length - 1].id : null);
  if (!id) return;
  var cur = shipById(id);
  if (!cur) { selDir = selDir === 'h' ? 'v' : 'h'; toast(selDir === 'h' ? 'האונייה הבאה תהיה לרוחב' : 'האונייה הבאה תהיה לאורך'); return; }
  var s = clampShip({ id: id, x: cur.x, y: cur.y, dir: cur.dir === 'h' ? 'v' : 'h' });
  if (!B.canPlace(myLayout, s)) { sfx('bad'); toast('אין מקום לסובב כאן'); return; }
  putShip(s); selShip = id; selDir = s.dir; sfx('place'); render();
};
$('randomBtn').onclick = function () { myLayout = B.randomLayout(); selShip = null; saveLocal(); sfx('place'); clearBoardEls(); render(); };
$('clearBtn').onclick = function () { myLayout = []; selShip = B.FLEET[0].id; selDir = 'h'; saveLocal(); clearBoardEls(); render(); };
$('readyBtn').onclick = function () {
  if (!B.validLayout(myLayout) || !placing()) return;
  var a = new Uint32Array(4); crypto.getRandomValues(a);
  salt = Array.prototype.map.call(a, function (x) { return x.toString(16); }).join('');
  saveLocal(); selShip = null;
  $('readyBtn').disabled = true;
  sha(B.canonical(myLayout) + '|' + salt).then(function (h) {
    publish({ t: 'ready', g: room.g, commit: h }).catch(function () {});
    onMsg({ t: 'ready', g: room.g, commit: h, id: myId }, true);
    sfx('ping');
  });
};
function renderDock() {
  var d = $('dock');
  if (!d.children.length) {
    B.FLEET.forEach(function (f) {
      var b = document.createElement('button'); b.type = 'button'; b.dataset.id = f.id;
      var pips = ''; for (var i = 0; i < f.len; i++) pips += '<span></span>';
      b.innerHTML = '<span>' + esc(f.name) + '</span><span class="pips" aria-hidden="true">' + pips + '</span>';
      b.onclick = function () { selShip = f.id; var cur = shipById(f.id); if (cur) selDir = cur.dir; sfx('place'); render(); toast('לחץ על הלוח כדי להציב את ה' + f.name); };
      d.appendChild(b);
    });
  }
  Array.prototype.forEach.call(d.children, function (b) {
    var placed = !!shipById(b.dataset.id);
    b.classList.toggle('placed', placed);
    b.setAttribute('aria-pressed', String(selShip === b.dataset.id));
    b.setAttribute('aria-label', B.spec(b.dataset.id).name + ', ' + B.spec(b.dataset.id).len + ' משבצות' + (placed ? ', מוצבת' : ''));
  });
  $('readyBtn').disabled = !B.validLayout(myLayout);
}

/* ---------- firing ---------- */
function cellTap(i) {
  if (!room || !room.loaded) return;
  if (placing()) { placementTap(i); return; }
  if (!inBattle()) return;
  if (view === 'mine') {
    if (isMyTurn()) { clearTimeout(autoTimer); setView('enemy'); toast('התור שלך! בחר מטרה בים של היריב'); }
    else toast('זה הצי שלך. מחכים לירייה של היריב');
    return;
  }
  if (!isMyTurn()) { toast(lastResolved() ? 'זה התור של היריב' : 'מחכים לתשובה על הירייה הקודמת'); return; }
  if (weapon === 'shot' && firedCells(myShots()).indexOf(i) !== -1) { sfx('bad'); toast('כבר ירית למשבצת הזאת'); return; }
  if (aim === i) { fire(); return; }
  aim = i; sfx('place'); say('מכוון ' + B.WEAPONS[weapon].name + ' אל ' + B.name(i) + '. לחץ אש.'); render();
}
function fire() {
  if (aim === null || !isMyTurn()) return;
  if (usesLeft(me(), weapon) < 1) { weapon = 'shot'; render(); return; }
  var msg = { t: 'shot', g: room.g, n: room.shots.length, i: aim, w: weapon, d: wdir };
  aim = null; weapon = 'shot';
  onMsg({ t: 'shot', g: msg.g, n: msg.n, i: msg.i, w: msg.w, d: msg.d, id: myId }, true);
  publish(msg).catch(function () { toast('הירייה לא נשלחה. בודק חיבור…'); });
}
$('fireBtn').onclick = fire;
$('dirBtn').onclick = function () { wdir = wdir === 'h' ? 'v' : 'h'; sfx('place'); render(); };
function renderWeapons() {
  var box = $('weapons'), m = me();
  if (!box.children.length) {
    B.WEAPON_ORDER.forEach(function (w) {
      var W = B.WEAPONS[w], b = document.createElement('button');
      b.type = 'button'; b.dataset.w = w; b.setAttribute('role', 'radio');
      b.innerHTML = '<span class="ic" aria-hidden="true">' + W.icon + '</span><span class="wn">' + esc(W.name) + '</span><span class="uses"></span>';
      b.onclick = function () {
        if (usesLeft(me(), w) < 1) { toast(B.WEAPONS[w].ship && sunkShipsOf(me())[B.WEAPONS[w].ship] ? 'ה' + B.spec(B.WEAPONS[w].ship).name + ' טבעה, הנשק אבד' : 'נגמרה התחמושת'); return; }
        weapon = w; sfx('place'); toast(W.icon + ' ' + W.name + ': ' + W.desc); render();
      };
      box.appendChild(b);
    });
  }
  Array.prototype.forEach.call(box.children, function (b) {
    var w = b.dataset.w, W = B.WEAPONS[w], left = m ? usesLeft(m, w) : 0;
    var lost = W.ship && m && sunkShipsOf(m)[W.ship];
    b.querySelector('.uses').textContent = lost ? 'טבעה' : left === Infinity ? '∞' : '×' + left;
    b.disabled = !left;
    b.setAttribute('aria-checked', String(weapon === w));
    b.setAttribute('aria-label', W.name + ', ' + W.desc + ', ' + (lost ? 'הספינה טבעה' : left === Infinity ? 'ללא הגבלה' : 'נשארו ' + left));
  });
  var dirOn = !!B.WEAPONS[weapon].dir;
  $('dirBtn').hidden = !dirOn;
  $('dirBtn').textContent = wdir === 'h' ? '↔ לרוחב' : '↕ לאורך';
}

/* ---------- effects ---------- */
function shellFx(s) {
  var board = s.by === me() ? 'enemy' : 'mine';
  clearTimeout(autoTimer);
  if (view !== board) setView(board);
  if (s.w === 'sonar') { sfx('ping'); return; }
  if (s.w === 'torpedo') { sfx('whistle'); return; }
  sfx('whistle');
  if (reduced) return;
  B.pattern(s.w, s.idx, s.d).forEach(function (c, k) {
    var el = document.createElement('div'); el.className = 'shell';
    el.style.left = (c % 10) * 10 + '%'; el.style.top = Math.floor(c / 10) * 10 + '%';
    el.innerHTML = '<div class="bill"><div class="bomb"></div></div>';
    el.firstChild.style.animationDelay = (k * 45) + 'ms';
    $('shells').appendChild(el); setTimeout(function () { el.remove(); }, 760 + k * 45);
  });
}
function torpedoRun(s, done) {
  var cells = s.res.cells, last = cells.length ? cells[cells.length - 1].i : s.idx;
  if (reduced || !cells.length) { done(); return; }
  var first = cells[0].i, dur = 90 * cells.length;
  var el = document.createElement('div'); el.className = 'torp' + (s.d === 'v' ? ' v' : '');
  el.style.left = (first % 10) * 10 + '%'; el.style.top = Math.floor(first / 10) * 10 + '%';
  el.style.setProperty('--tx', ((last % 10) - (first % 10)) * 100 + '%');
  el.style.setProperty('--ty', (Math.floor(last / 10) - Math.floor(first / 10)) * 100 + '%');
  el.style.animationDuration = dur + 'ms';
  el.innerHTML = '<i></i>';
  $('shells').appendChild(el);
  noiseRun(dur);
  setTimeout(function () { el.remove(); done(); }, dur);
}
function noiseRun(ms) { if (!soundOn) return; try { noise(ms / 1000, 'bandpass', 500, .25, 1400); } catch (e) {} }
function resultFx(s) {
  held[s.n] = 1;
  var delay = s.w === 'torpedo' || s.w === 'sonar' ? 0 : Math.max(0, (shotTime[s.n] || 0) + (reduced ? 0 : 640) - Date.now());
  setTimeout(function () {
    var board = s.by === me() ? 'enemy' : 'mine';
    if (view !== board) setView(board, true);
    if (s.w === 'torpedo') torpedoRun(s, land); else land();
  }, delay);
  function land() {
    delete held[s.n];
    render();
    var mineShot = s.by === me();
    if (s.w === 'sonar') {
      sonarPing(s.idx, s.res.found); sfx('ping');
      bigText(s.res.found ? (mineShot ? 'הסונאר זיהה אונייה!' : 'הסונאר שלו מצא אותך!') : (mineShot ? 'הסונאר: האזור ריק' : 'הסונאר שלו לא מצא כלום'), !s.res.found);
      say('סונאר ב-' + B.name(s.idx) + ': ' + (s.res.found ? 'יש אונייה באזור' : 'האזור ריק'));
    } else {
      var hits = s.res.cells.filter(function (c) { return c.hit; }), sunk = s.res.cells.filter(function (c) { return c.sunk; });
      s.res.cells.forEach(function (c, k) {
        setTimeout(function () { if (c.hit) explode(c.i, !!c.sunk); else splash(c.i); }, k * (s.w === 'torpedo' ? 0 : 110));
      });
      if (hits.length) { sfx(sunk.length || hits.length > 2 ? 'bigboom' : 'boom'); buzz(sunk.length ? [60, 40, 120] : 50); shake(sunk.length > 0 || hits.length > 2); }
      else sfx('splash');
      var t;
      if (sunk.length) t = mineShot ? 'הטבעת ' + B.spec(sunk[0].sunk).name + '!' : B.spec(sunk[0].sunk).name + ' שלך טבעה!';
      else if (hits.length > 1) t = (mineShot ? 'פגיעה ×' : 'נפגעת ×') + hits.length + '!';
      else if (hits.length) t = mineShot ? 'פגיעה!' : 'נפגעת!';
      else t = mineShot ? 'החטאה' : 'פספס!';
      bigText(t, !hits.length);
      if (B.extraTurn(s) && !room.over) setTimeout(function () { bigText(mineShot ? 'עוד ירייה! 🎯' : 'היריב יורה שוב'); }, 1100);
      say((mineShot ? 'התקיפה שלך: ' : 'היריב תקף: ') + B.WEAPONS[s.w].name + ', ' + (hits.length ? hits.length + ' פגיעות' : 'החטאה') + (sunk.length ? ', ' + B.spec(sunk[0].sunk).name + ' טבעה' : '') + (B.extraTurn(s) ? '. עוד ירייה' : ''));
    }
    if (!room.over) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { if (room && inBattle()) setView(isMyTurn() ? 'enemy' : 'mine'); }, 1700);
    } else setTimeout(render, 1400);
  }
}
function sonarPing(i, found) {
  if (reduced) return;
  var c = cellPt(i), sq = c.h / c.w, col = found ? '#5cf2c3' : '#9fb7c4';
  for (var k = 0; k < 3; k++) add({ k: 'ring', x: c.x, y: c.y, r: c.w * .2, vr: c.w * .09, sq: sq, life: 1, c: col, w: 3, delay: k * 12 });
}
function bigText(t, miss) {
  if (reduced) return;
  var el = document.createElement('div'); el.className = 'banner-big' + (miss ? ' miss' : ''); el.textContent = t;
  $('stage').appendChild(el); setTimeout(function () { el.remove(); }, 1550);
}
function shake(big) { if (reduced) return; var s = $('stage'); s.classList.remove('shake', 'shake-big'); void s.offsetWidth; s.classList.add(big ? 'shake-big' : 'shake'); setTimeout(function () { s.classList.remove('shake', 'shake-big'); }, 820); }
function floatEmo(e, theirs) {
  var el = document.createElement('div'); el.className = 'float-emo'; el.textContent = e;
  var r = $(theirs ? 'plOpp' : 'plMe').getBoundingClientRect();
  el.style.left = (r.left + r.width / 2 - 32) + 'px'; el.style.top = (r.top + 30) + 'px';
  document.body.appendChild(el); setTimeout(function () { el.remove(); }, 1900);
  if (theirs) { sfx('ping'); buzz(20); }
}

/* particles */
var fx = $('fx'), fctx = fx.getContext('2d'), parts = [], fxRun = false;
function sizeFx() { var r = fx.getBoundingClientRect(); var d = Math.min(window.devicePixelRatio || 1, 2); fx.width = r.width * d; fx.height = r.height * d; fctx.setTransform(d, 0, 0, d, 0, 0); }
function cellPt(i) {
  var c = $('grid').children[i], r = c.getBoundingClientRect(), f = fx.getBoundingClientRect();
  return { x: r.left + r.width / 2 - f.left, y: r.top + r.height / 2 - f.top, w: r.width, h: r.height };
}
function add(p) { parts.push(p); if (!fxRun) { fxRun = true; requestAnimationFrame(tick); } }
function explode(i, big) {
  if (reduced) return;
  var c = cellPt(i), n = big ? 2 : 1, sq = c.h / c.w;
  add({ k: 'flash', x: c.x, y: c.y, r: c.w * 1.6 * n, life: 1 });
  add({ k: 'ring', x: c.x, y: c.y, r: c.w * .3, vr: c.w * .14 * n, sq: sq, life: 1, c: '#ffd08a', w: 5 });
  for (var k = 0; k < 26 * n; k++) { var a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 4 * n; add({ k: 'fire', x: c.x, y: c.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * sq - 2.5, r: c.w * (.12 + Math.random() * .2), life: 1, g: -.04 }); }
  for (var m = 0; m < 18 * n; m++) { var b = Math.random() * Math.PI * 2, t = 3 + Math.random() * 7 * n; add({ k: 'spark', x: c.x, y: c.y, vx: Math.cos(b) * t, vy: Math.sin(b) * t * sq - 3, life: 1, g: .18 }); }
  for (var d = 0; d < 10 * n; d++) { var e = Math.random() * Math.PI * 2, u = 2 + Math.random() * 5; add({ k: 'debris', x: c.x, y: c.y, vx: Math.cos(e) * u, vy: -3 - Math.random() * 6, rot: Math.random() * 6, vr: (Math.random() - .5) * .6, s: c.w * (.06 + Math.random() * .1), life: 1.4, g: .3 }); }
  for (var q = 0; q < 12 * n; q++) add({ k: 'smoke', x: c.x + (Math.random() - .5) * c.w, y: c.y, vx: (Math.random() - .5) * .8, vy: -.6 - Math.random() * 1.2, r: c.w * .25, life: 1.8, delay: 8 + q * 2 });
}
function splash(i) {
  if (reduced) return;
  var c = cellPt(i), sq = c.h / c.w;
  add({ k: 'ring', x: c.x, y: c.y, r: c.w * .2, vr: c.w * .08, sq: sq, life: 1, c: '#d6f1ff', w: 3 });
  add({ k: 'ring', x: c.x, y: c.y, r: c.w * .1, vr: c.w * .05, sq: sq, life: 1.3, c: '#9fd8f5', w: 2 });
  for (var k = 0; k < 40; k++) { var a = (Math.random() - .5) * 1.2, s = 3 + Math.random() * 7; add({ k: 'drop', x: c.x + (Math.random() - .5) * c.w * .4, y: c.y, vx: Math.sin(a) * s * .6, vy: -Math.cos(a) * s, r: 1.5 + Math.random() * 2.5, life: 1.2, g: .32, c: k % 3 ? '#cfefff' : '#ffffff' }); }
}
function tick() {
  var r = fx.getBoundingClientRect();
  fctx.clearRect(0, 0, r.width, r.height);
  parts = parts.filter(function (p) { return p.life > 0; });
  parts.forEach(function (p) {
    if (p.delay) { p.delay--; return; }
    fctx.save(); fctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    switch (p.k) {
      case 'flash': p.life -= .12; fctx.globalCompositeOperation = 'lighter';
        var g = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r); g.addColorStop(0, 'rgba(255,240,200,.95)'); g.addColorStop(.4, 'rgba(255,150,40,.6)'); g.addColorStop(1, 'rgba(255,80,0,0)');
        fctx.fillStyle = g; fctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); break;
      case 'ring': p.r += p.vr; p.vr *= .9; p.life -= .035; fctx.strokeStyle = p.c; fctx.lineWidth = p.w * p.life;
        fctx.beginPath(); fctx.ellipse(p.x, p.y, p.r, p.r * (p.sq || 1), 0, 0, 7); fctx.stroke(); break;
      case 'fire': p.x += p.vx; p.y += p.vy; p.vx *= .92; p.vy = p.vy * .92 + p.g; p.life -= .03; p.r *= 1.015;
        fctx.globalCompositeOperation = 'lighter';
        var fg = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        fg.addColorStop(0, p.life > .6 ? 'rgba(255,240,180,.9)' : 'rgba(255,140,40,.8)'); fg.addColorStop(1, 'rgba(255,60,0,0)');
        fctx.fillStyle = fg; fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, 7); fctx.fill(); break;
      case 'spark': p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= .96; p.life -= .03;
        fctx.globalCompositeOperation = 'lighter'; fctx.strokeStyle = '#ffd27a'; fctx.lineWidth = 2; fctx.lineCap = 'round';
        fctx.beginPath(); fctx.moveTo(p.x, p.y); fctx.lineTo(p.x - p.vx * 2, p.y - p.vy * 2); fctx.stroke(); break;
      case 'debris': p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.vr; p.life -= .025;
        fctx.translate(p.x, p.y); fctx.rotate(p.rot); fctx.fillStyle = '#3a3a3e'; fctx.fillRect(-p.s, -p.s * .6, p.s * 2, p.s * 1.2); break;
      case 'smoke': p.x += p.vx; p.y += p.vy; p.r *= 1.02; p.life -= .012;
        fctx.globalAlpha = Math.max(0, p.life * .35);
        var sg = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r); sg.addColorStop(0, 'rgba(70,70,76,.9)'); sg.addColorStop(1, 'rgba(70,70,76,0)');
        fctx.fillStyle = sg; fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, 7); fctx.fill(); break;
      case 'drop': p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life -= .022;
        fctx.fillStyle = p.c; fctx.beginPath(); fctx.ellipse(p.x, p.y, p.r * .8, p.r * 1.3, Math.atan2(p.vy, p.vx) + Math.PI / 2, 0, 7); fctx.fill(); break;
      default: p.x += p.vx; p.y += p.vy; p.vy += (p.g || .1); p.life -= (p.decay || .02);
        fctx.translate(p.x, p.y); fctx.rotate(p.rot = (p.rot || 0) + (p.vr || 0)); fctx.fillStyle = p.c; fctx.fillRect(-p.r, -p.r * .5, p.r * 2, p.r);
    }
    fctx.restore();
  });
  if (parts.length) requestAnimationFrame(tick); else { fxRun = false; fctx.clearRect(0, 0, r.width, r.height); }
}
function confetti() {
  if (reduced) return;
  var r = fx.getBoundingClientRect(), cols = ['#ff8a2a', '#5cf2c3', '#e8f1f5', '#ffd27a', '#7cc8ff'];
  for (var k = 0; k < 160; k++) add({ x: Math.random() * r.width, y: -10 - Math.random() * 140, vx: (Math.random() - .5) * 2.5, vy: 1 + Math.random() * 3, life: 2, decay: .01, g: .05, c: cols[k % 5], r: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - .5) * .3 });
}

/* ---------- other actions ---------- */
var flat = lsGet('bs_flat') === '1';
function syncFlat() { document.documentElement.classList.toggle('flat', flat); $('flatBtn').setAttribute('aria-pressed', String(flat)); $('flatBtn').textContent = flat ? 'תצוגת תלת-ממד' : 'תצוגה שטוחה'; }
syncFlat();
$('flatBtn').onclick = function () { flat = !flat; lsSet('bs_flat', flat ? '1' : '0'); syncFlat(); setTimeout(function () { syncCs(); clearBoardEls(); render(); }, 650); };
$('resignBtn').onclick = function () {
  if (!room || room.over || !me()) return;
  confirmAsk('להיכנע ולסיים את המשחק?', function () { publish({ t: 'resign', g: room.g }).catch(function () {}); onMsg({ t: 'resign', g: room.g, id: myId }, true); });
};
$('rematchBtn').onclick = function () { closeDlg($('endDlg')); publish({ t: 'new', g: room.g + 1 }).catch(function () {}); };
$('react').onclick = function (e) { var b = e.target.closest('button'); if (!b || !room) return; floatEmo(b.dataset.e, false); publish({ t: 'emo', e: b.dataset.e }, true).catch(function () {}); };
function shareUrl() { return location.origin + location.pathname + '?r=' + room.code; }
$('shareBtn').onclick = function () {
  var data = { title: 'באטלשיפ', text: 'בוא לקרב ימי! קוד החדר: ' + room.code, url: shareUrl() };
  if (navigator.share) navigator.share(data).catch(function () {}); else $('copyBtn').click();
};
$('copyBtn').onclick = function () { var u = shareUrl(); (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { toast('הקישור הועתק'); }, function () { toast(u); }); };

/* ---------- render ---------- */
function setStatus(t, pill) { var s = $('status'); s.textContent = ''; s.appendChild(document.createTextNode(t)); if (pill) { var p = document.createElement('span'); p.className = 'pill'; p.textContent = pill; s.appendChild(p); } }
function nameFor(id, fb) { return (id && room.names[id]) || fb; }
function fillPl(el, seat, isMe) {
  var id = seat ? room.seats[seat] : null;
  el.querySelector('.nm').textContent = id ? nameFor(id, 'קפטן') + (isMe ? ' (אתה)' : '') : 'מחכה ליריב…';
  var on = id && (id === myId || Date.now() - (room.lastSeen[id] || 0) < 50000);
  el.querySelector('.online').className = 'online' + (on ? ' on' : '');
  var st = !id ? '' : room.ready[seat] ? 'הצי מוכן' : 'מסדר צי';
  if (!isMe && id) st += on ? ' · מחובר' : ' · לא מחובר';
  el.querySelector('.st').textContent = st;
  el.classList.toggle('turn', inBattle() && lastResolved() && seat === shooterSeat(room.shots.length));
}
function render() {
  if (!room || $('game').hidden) return;
  var m = me(), o = opp() || (m ? other(m) : 'b');
  fillPl($('plMe'), m || 'a', !!m); fillPl($('plOpp'), m ? o : 'b', false);
  var waiting = room.loaded && (!room.seats.a || !room.seats.b);
  $('waitBanner').hidden = !(waiting && m);
  $('bigCode').textContent = room.code;
  $('roomHint').textContent = 'קוד החדר: ' + room.code + (!m && room.loaded ? ' · אתה צופה' : '');

  var pl = placing();
  if (pl && view !== 'mine') { view = 'mine'; clearBoardEls(); }
  $('placePanel').hidden = !pl;
  $('fireBar').hidden = !inBattle() || !m;
  $('fleets').hidden = pl || !m || !room.ready[m];
  $('stats').hidden = !bothReady() || !m;
  $('tabEnemy').setAttribute('aria-selected', String(view === 'enemy'));
  $('tabMine').setAttribute('aria-selected', String(view === 'mine'));
  $('resignBtn').disabled = !m || !!room.over || !room.seats.a || !room.seats.b;
  if (pl) renderDock();

  // status
  var myTurn = isMyTurn();
  if (!room.loaded) setStatus('מתחבר לחדר…');
  else if (!m) setStatus(room.over ? 'המשחק נגמר' : 'אתה צופה במשחק');
  else if (room.over) setStatus(room.over.winner === m ? 'ניצחת! 🏆' : 'הפסדת');
  else if (pl) setStatus(B.validLayout(myLayout) ? 'הצי מסודר. לחץ "הצי מוכן"' : 'סדר את הצי שלך', room.ready[o] ? 'היריב מוכן' : null);
  else if (!bothReady()) setStatus('מחכים שהיריב יסדר את הצי…');
  else if (!room.ready[m] || !B.validLayout(myLayout)) setStatus('הסידור שלך שמור במכשיר אחר. פתח את המשחק מאותו טלפון.');
  else if (myTurn) setStatus('התור שלך!', B.WEAPONS[weapon].icon + ' ' + (aim === null ? 'בחר מטרה' : 'לחץ אש'));
  else if (!lastResolved()) setStatus(room.shots[room.shots.length - 1].by === m ? 'הפגז בדרך… מחכים לתשובה' : 'היריב ירה!');
  else setStatus('היריב מכוון…');
  if (myTurn && !wasMyTurn) { var st = $('status'); st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash'); }
  wasMyTurn = myTurn;

  // fire bar
  if (m && inBattle() && usesLeft(m, weapon) < 1) weapon = 'shot';
  if (m && inBattle()) renderWeapons();
  $('fireBtn').disabled = !(myTurn && aim !== null && view === 'enemy');
  $('targetLbl').innerHTML = myTurn ? (aim !== null ? B.WEAPONS[weapon].icon + ' מטרה: <b>' + B.name(aim) + '</b>' : (view === 'enemy' ? 'בחר משבצת בים של היריב' : 'עבור ל"הים של היריב" כדי לירות')) : 'חכה לתור שלך';

  renderBoard();
  renderFleets();

  // end of game
  if (room.over && m && endShownFor !== room.g && !Object.keys(held).length) {
    endShownFor = room.g;
    var win = room.over.winner === m;
    setTimeout(function () {
      if (!room) return;
      $('endBig').textContent = win ? 'ניצחת!' : 'הפסדת';
      $('endText').textContent = room.over.reason === 'resign' ? (win ? 'היריב נכנע.' : 'נכנעת.') : (win ? 'הטבעת את כל הצי של היריב.' : 'כל הצי שלך טבע.');
      $('verifyTxt').textContent = 'בודק שהיריב ענה ביושר…'; $('verifyTxt').className = 'verify';
      openDlg($('endDlg'));
      if (win) { confetti(); sfx('win'); buzz([60, 40, 120]); } else sfx('lose');
      say($('endBig').textContent + '. ' + $('endText').textContent);
      updateVerify();
    }, room.over.reason === 'resign' ? 200 : 1300);
  }
  if (room.over) updateVerify();
}
function updateVerify() {
  verifyOpp().then(function (ok) {
    var v = $('verifyTxt');
    if (ok === null) { v.textContent = 'מחכים שהסידור של היריב ייחשף כדי לבדוק הוגנות…'; v.className = 'verify'; }
    else if (ok) { v.textContent = '✔ נבדק: היריב ענה ביושר על כל ירייה'; v.className = 'verify ok'; }
    else { v.textContent = '⚠ הסידור של היריב לא מתאים לתשובות שלו'; v.className = 'verify bad'; }
  });
}
function renderFleets() {
  if ($('fleets').hidden) return;
  var hitSet = {};
  oppShots().forEach(function (s) { if (s.res && !held[s.n]) s.res.cells.forEach(function (c) { if (c.hit) hitSet[c.i] = 1; }); });
  var sunkOpp = {};
  myShots().forEach(function (s) { if (s.res && !held[s.n]) s.res.cells.forEach(function (c) { if (c.sunk) sunkOpp[c.sunk] = 1; }); });
  var h1 = '<h4>הצי שלי</h4>', h2 = '<h4>הצי של היריב</h4>';
  B.FLEET.forEach(function (f) {
    var s = shipById(f.id), cells = s ? B.cellsOf(s) : [], n = cells.filter(function (c) { return hitSet[c]; }).length;
    var pips = ''; for (var i = 0; i < f.len; i++) pips += '<span class="' + (i < n ? 'x' : '') + '"></span>';
    h1 += '<div class="s' + (n === f.len ? ' dead' : '') + '"><span>' + esc(f.name) + '</span><span class="hp" aria-label="' + (f.len - n) + ' מתוך ' + f.len + ' שלמות">' + pips + '</span></div>';
    var dead = sunkOpp[f.id], p2 = ''; for (var j = 0; j < f.len; j++) p2 += '<span class="' + (dead ? 'x' : 'u') + '"></span>';
    h2 += '<div class="s' + (dead ? ' dead' : '') + '"><span>' + esc(f.name) + '</span><span class="hp" aria-label="' + (dead ? 'טבעה' : 'עדיין צפה') + '">' + p2 + '</span></div>';
  });
  if ($('fleetMine').innerHTML !== h1) $('fleetMine').innerHTML = h1;
  if ($('fleetOpp').innerHTML !== h2) $('fleetOpp').innerHTML = h2;
  var mine = myShots().filter(function (s) { return s.res && !held[s.n] && s.w !== 'sonar'; }), fired = 0, hits = 0;
  mine.forEach(function (s) { s.res.cells.forEach(function (c) { fired++; if (c.hit) hits++; }); });
  $('stShots').textContent = mine.length; $('stHits').textContent = hits;
  $('stAcc').textContent = fired ? Math.round(hits * 100 / fired) + '%' : '0%';
}

/* ---------- boot ---------- */
var params = new URLSearchParams(location.search);
var r0 = (params.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (r0.length === 5) {
  if (!myName) { $('codeIn').value = r0; $('nameIn').focus(); toast('כתוב את השם שלך ולחץ "הצטרפות למשחק"'); }
  else startRoom(r0, false);
}
})();
