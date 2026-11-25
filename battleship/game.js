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

  var api = { SIZE: SIZE, FLEET: FLEET, TOTAL: TOTAL, spec: spec, name: name, cellsOf: cellsOf, canPlace: canPlace,
    validLayout: validLayout, randomLayout: randomLayout, resolve: resolve, canonical: canonical, audit: audit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BS = api;
})(this);
