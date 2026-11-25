/* Battleship rules. Pure functions, no DOM.
   Board 10x10, index = y*10 + x. A ship is { id, x, y, dir: 'h'|'v' }. */
(function (root) {
  'use strict';
  var SIZE = 10;
  var FLEET = [
    { id: 'carrier', name: 'נושאת מטוסים', len: 5 },
    { id: 'battleship', name: 'ספינת קרב', len: 4 },
    { id: 'destroyer', name: 'משחתת', len: 3 },
    { id: 'sub', name: 'צוללת', len: 3 },
    { id: 'patrol', name: 'סיירת', len: 2 }
  ];
  var LETTERS = 'ABCDEFGHIJ';
  var TOTAL = FLEET.reduce(function (s, f) { return s + f.len; }, 0);

  function spec(id) { for (var i = 0; i < FLEET.length; i++) if (FLEET[i].id === id) return FLEET[i]; return null; }
  function name(i) { return LETTERS[i % SIZE] + (Math.floor(i / SIZE) + 1); }
  function cellsOf(s) {
    var f = spec(s.id); if (!f) return [];
    var out = [];
    for (var k = 0; k < f.len; k++) {
      var x = s.x + (s.dir === 'h' ? k : 0), y = s.y + (s.dir === 'v' ? k : 0);
      out.push(x < 0 || y < 0 || x >= SIZE || y >= SIZE ? -1 : y * SIZE + x);
    }
    return out;
  }
  function inBounds(s) { return cellsOf(s).every(function (c) { return c >= 0; }); }
  // Can `ship` go here, ignoring the ship with the same id already in `layout`?
  function canPlace(layout, ship) {
    if (!inBounds(ship)) return false;
    var taken = {};
    layout.forEach(function (o) { if (o.id !== ship.id) cellsOf(o).forEach(function (c) { taken[c] = 1; }); });
    return cellsOf(ship).every(function (c) { return !taken[c]; });
  }
  function validLayout(layout) {
    if (!Array.isArray(layout) || layout.length !== FLEET.length) return false;
    var seen = {}, taken = {};
    for (var i = 0; i < layout.length; i++) {
      var s = layout[i];
      if (!s || !spec(s.id) || seen[s.id] || (s.dir !== 'h' && s.dir !== 'v') || !inBounds(s)) return false;
      seen[s.id] = 1;
      var cs = cellsOf(s);
      for (var k = 0; k < cs.length; k++) { if (taken[cs[k]]) return false; taken[cs[k]] = 1; }
    }
    return true;
  }
  function randomLayout(rand) {
    rand = rand || Math.random;
    for (var tries = 0; tries < 200; tries++) {
      var layout = [], ok = true;
      for (var i = 0; i < FLEET.length && ok; i++) {
        var placed = false;
        for (var t = 0; t < 300 && !placed; t++) {
          var s = { id: FLEET[i].id, dir: rand() < .5 ? 'h' : 'v', x: Math.floor(rand() * SIZE), y: Math.floor(rand() * SIZE) };
          if (canPlace(layout, s)) { layout.push(s); placed = true; }
        }
        ok = placed;
      }
      if (ok) return layout;
    }
    return null;
  }
  // Answer a shot at `idx`, given the cells the attacker has already fired at (before this shot).
  function resolve(layout, priorShots, idx) {
    var fired = {}; priorShots.forEach(function (c) { fired[c] = 1; }); fired[idx] = 1;
    var res = { hit: false, sunk: null, cells: null, over: false };
    for (var i = 0; i < layout.length; i++) {
      var cs = cellsOf(layout[i]);
      if (cs.indexOf(idx) === -1) continue;
      res.hit = true;
      if (cs.every(function (c) { return fired[c]; })) { res.sunk = layout[i].id; res.cells = cs; }
    }
    if (res.hit) {
      var all = true;
      layout.forEach(function (s) { cellsOf(s).forEach(function (c) { if (!fired[c]) all = false; }); });
      res.over = all;
    }
    return res;
  }
  function canonical(layout) {
    return JSON.stringify(layout.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; })
      .map(function (s) { return [s.id, s.x, s.y, s.dir]; }));
  }
  // Check every answer an opponent gave against the layout they revealed afterwards.
  function audit(layout, shots) {
    if (!validLayout(layout)) return false;
    var prior = [];
    for (var i = 0; i < shots.length; i++) {
      var s = shots[i], r = resolve(layout, prior, s.idx);
      if (!!r.hit !== !!s.res.hit || (r.sunk || null) !== (s.res.sunk || null) || !!r.over !== !!s.res.over) return false;
      prior.push(s.idx);
    }
    return true;
  }

  /* ---------- special weapons (Hasbro "Advanced Mission" style) ----------
     Each weapon belongs to a ship: when that ship sinks, the weapon is gone. */
  var WEAPONS = {
    shot: { name: 'ירייה רגילה', icon: '🎯', ship: null, uses: Infinity, desc: 'משבצת אחת. פגיעה = עוד ירייה' },
    air: { name: 'מתקפה אווירית', icon: '✈️', ship: 'carrier', uses: 2, desc: '5 משבצות בצורת +' },
    tomahawk: { name: 'טיל טומהוק', icon: '🚀', ship: 'battleship', uses: 1, desc: 'ריבוע 3×3' },
    apache: { name: "טילי אפאצ'י", icon: '💥', ship: 'destroyer', uses: 2, desc: '3 משבצות בקו', dir: true },
    torpedo: { name: 'טורפדו', icon: '🌊', ship: 'sub', uses: 2, desc: 'שוחה לאורך שורה או טור עד הפגיעה הראשונה', dir: true },
    sonar: { name: 'סונאר', icon: '📡', ship: 'patrol', uses: 2, desc: 'בודק אם יש אונייה בריבוע 3×3, בלי לירות' }
  };
  var WEAPON_ORDER = ['shot', 'air', 'tomahawk', 'apache', 'torpedo', 'sonar'];
  function at(x, y) { return x < 0 || y < 0 || x >= SIZE || y >= SIZE ? -1 : y * SIZE + x; }
  // The squares a weapon covers, in the order they are resolved.
  function pattern(w, i, d) {
    var x = i % SIZE, y = Math.floor(i / SIZE), out = [], k;
    if (w === 'shot') out = [i];
    else if (w === 'air') out = [i, at(x, y - 1), at(x - 1, y), at(x + 1, y), at(x, y + 1)];
    else if (w === 'tomahawk' || w === 'sonar') { for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) out.push(at(x + dx, y + dy)); }
    else if (w === 'apache') out = d === 'v' ? [at(x, y - 1), i, at(x, y + 1)] : [at(x - 1, y), i, at(x + 1, y)];
    else if (w === 'torpedo') { for (k = 0; k < SIZE; k++) out.push(d === 'v' ? at(x, k) : at(k, y)); }
    return out.filter(function (c) { return c >= 0; });
  }
  // Resolve a whole attack. `prior` = squares the attacker already fired at.
  function volley(layout, prior, w, i, d) {
    var fired = {}; prior.forEach(function (c) { fired[c] = 1; });
    var cells = pattern(w, i, d), res = { cells: [], over: false, found: null };
    var shipAt = {}; layout.forEach(function (s) { cellsOf(s).forEach(function (c) { shipAt[c] = s; }); });
    function sunkNow(s) { return cellsOf(s).every(function (c) { return fired[c]; }); }
    if (w === 'sonar') {
      res.found = cells.some(function (c) { var s = shipAt[c]; return s && !sunkNow(s); });
      return res;
    }
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k], s = shipAt[c], before = s ? sunkNow(s) : false;
      fired[c] = 1;
      var r = { i: c, hit: !!s, sunk: null, cells: null };
      if (s && !before && sunkNow(s)) { r.sunk = s.id; r.cells = cellsOf(s); }
      res.cells.push(r);
      if (w === 'torpedo' && s) break; // a torpedo stops at the first ship
    }
    res.over = layout.every(function (s) { return sunkNow(s); });
    return res;
  }
  function anyHit(res) { return !!res && (res.cells || []).some(function (c) { return c.hit; }); }
  // A regular shot that hits gives the same player another turn.
  function extraTurn(shot) { return shot.w === 'shot' && anyHit(shot.res); }
  function auditVolleys(layout, shots) {
    if (!validLayout(layout)) return false;
    var prior = [];
    for (var n = 0; n < shots.length; n++) {
      var s = shots[n], r = volley(layout, prior, s.w, s.i, s.d), g = s.res || {};
      if ((r.found === null ? null : !!r.found) !== (g.found === undefined || g.found === null ? null : !!g.found)) return false;
      if (!!r.over !== !!g.over) return false;
      var gc = g.cells || [];
      if (gc.length !== r.cells.length) return false;
      for (var k = 0; k < r.cells.length; k++) {
        if (gc[k].i !== r.cells[k].i || !!gc[k].hit !== r.cells[k].hit || (gc[k].sunk || null) !== r.cells[k].sunk) return false;
      }
      r.cells.forEach(function (c) { prior.push(c.i); });
    }
    return true;
  }

  var api = { SIZE: SIZE, FLEET: FLEET, TOTAL: TOTAL, spec: spec, name: name, cellsOf: cellsOf, canPlace: canPlace,
    validLayout: validLayout, randomLayout: randomLayout, resolve: resolve, canonical: canonical, audit: audit,
    WEAPONS: WEAPONS, WEAPON_ORDER: WEAPON_ORDER, pattern: pattern, volley: volley, anyHit: anyHit, extraTurn: extraTurn, auditVolleys: auditVolleys };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BS = api;
})(this);
