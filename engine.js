/* Draughts rules engine: Russian draughts (shashki) with two house rules:
   men capture forward only, and a king that captures lands right behind the captured piece.
   Pure functions, no DOM.
   Board: array of 64. Index = r*8 + c, r=0 is the top row (black's back row).
   Values: 0 empty, 1 white man, 2 white king, -1 black man, -2 black king.
   White sits at the bottom (rows 5-7) and moves first. */
(function (root) {
  'use strict';
  var DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var FILES = 'abcdefgh';

  function rc(i) { return [Math.floor(i / 8), i % 8]; }
  function idx(r, c) { return r * 8 + c; }
  function onBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function isDark(i) { var p = rc(i); return (p[0] + p[1]) % 2 === 1; }
  function name(i) { var p = rc(i); return FILES[p[1]] + (8 - p[0]); }
  function sideOf(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function promoRow(side) { return side === 1 ? 0 : 7; }

  function initialBoard() {
    var b = new Array(64).fill(0);
    for (var i = 0; i < 64; i++) {
      if (!isDark(i)) continue;
      var r = rc(i)[0];
      if (r <= 2) b[i] = -1;
      else if (r >= 5) b[i] = 1;
    }
    return b;
  }

  // All capture sequences for the piece on `from`. Captured pieces stay on the
  // board (and block) until the sequence ends; none can be jumped twice.
  function capturesFrom(board, from) {
    var v = board[from], side = sideOf(v);
    var b = board.slice(); b[from] = 0; // the moving piece has left its square
    var out = [];

    function jumps(pos, king, caps) {
      var res = [];
      var p = rc(pos);
      for (var d = 0; d < 4; d++) {
        var dr = DIRS[d][0], dc = DIRS[d][1];
        if (!king && dr !== -side) continue; // house rule: men capture forward only
        var r = p[0] + dr, c = p[1] + dc;
        if (king) {
          while (onBoard(r, c) && b[idx(r, c)] === 0) { r += dr; c += dc; }
        }
        if (!onBoard(r, c)) continue;
        var t = idx(r, c);
        if (sideOf(b[t]) !== -side || caps.indexOf(t) !== -1) continue;
        var lands = [];
        var lr = r + dr, lc = c + dc;
        // house rule: every capture (king too) lands on the square right after the captured piece
        if (onBoard(lr, lc) && b[idx(lr, lc)] === 0) lands.push(idx(lr, lc));
        if (lands.length) res.push({ cap: t, lands: lands });
      }
      return res;
    }

    function dfs(pos, king, caps, path, promoted) {
      var js = jumps(pos, king, caps);
      if (!js.length) {
        if (caps.length) out.push({ path: path.slice(), caps: caps.slice(), promote: promoted && Math.abs(v) === 1 });
        return;
      }
      js.forEach(function (j) {
        var caps2 = caps.concat([j.cap]);
        var opts = j.lands.map(function (L) {
          var k = king || rc(L)[0] === promoRow(side);
          return { L: L, k: k, cont: jumps(L, k, caps2).length > 0 };
        });
        // A king must land where it can keep capturing, if any such square exists.
        var anyCont = opts.some(function (o) { return o.cont; });
        opts.forEach(function (o) {
          if (anyCont && !o.cont) return;
          dfs(o.L, o.k, caps2, path.concat([o.L]), promoted || (o.k && !king));
        });
      });
    }

    dfs(from, Math.abs(v) === 2, [], [from], false);
    return out;
  }

  function quietFrom(board, from) {
    var v = board[from], side = sideOf(v), king = Math.abs(v) === 2;
    var p = rc(from), out = [];
    DIRS.forEach(function (d) {
      if (!king && d[0] !== -side) return; // men only step forward
      var r = p[0] + d[0], c = p[1] + d[1];
      while (onBoard(r, c) && board[idx(r, c)] === 0) {
        var to = idx(r, c);
        out.push({ path: [from, to], caps: [], promote: !king && r === promoRow(side) });
        if (!king) break;
        r += d[0]; c += d[1];
      }
    });
    return out;
  }

  function legalMoves(board, side) {
    var caps = [], quiet = [];
    for (var i = 0; i < 64; i++) {
      if (sideOf(board[i]) !== side) continue;
      caps = caps.concat(capturesFrom(board, i));
    }
    if (caps.length) return caps; // capturing is compulsory
    for (var j = 0; j < 64; j++) {
      if (sideOf(board[j]) !== side) continue;
      quiet = quiet.concat(quietFrom(board, j));
    }
    return quiet;
  }

  function applyMove(board, m) {
    var b = board.slice();
    var from = m.path[0], to = m.path[m.path.length - 1];
    var v = b[from];
    b[from] = 0;
    m.caps.forEach(function (c) { b[c] = 0; });
    if (m.promote || (Math.abs(v) === 1 && rc(to)[0] === promoRow(sideOf(v)))) v = sideOf(v) * 2;
    b[to] = v;
    return b;
  }

  function samePath(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function notation(m) {
    return m.path.map(name).join(m.caps.length ? ':' : '-');
  }

  function count(board) {
    var s = { w: 0, b: 0, wk: 0, bk: 0 };
    board.forEach(function (v) {
      if (v === 1) s.w++; else if (v === 2) { s.w++; s.wk++; }
      else if (v === -1) s.b++; else if (v === -2) { s.b++; s.bk++; }
    });
    return s;
  }

  // Replays a move list. Returns the full game state, or the state up to the
  // first illegal move (reported in `bad`).
  function replay(paths) {
    var g = newGame();
    for (var i = 0; i < paths.length; i++) {
      if (!play(g, paths[i])) { g.bad = i; break; }
    }
    return g;
  }

  function newGame() {
    var b = initialBoard();
    var g = { board: b, side: 1, history: [], positions: {}, quietKingPlies: 0, result: null };
    g.positions[key(b, 1)] = 1;
    g.legal = legalMoves(b, 1);
    return g;
  }

  function key(b, side) { return b.join(',') + '|' + side; }

  // Plays a path on game `g` in place. Returns the move, or null if illegal.
  function play(g, path) {
    if (g.result) return null;
    var m = null;
    for (var i = 0; i < g.legal.length; i++) if (samePath(g.legal[i].path, path)) { m = g.legal[i]; break; }
    if (!m) return null;
    var moverWasKing = Math.abs(g.board[m.path[0]]) === 2;
    g.board = applyMove(g.board, m);
    g.history.push({ path: m.path.slice(), caps: m.caps.slice(), promote: m.promote, side: g.side, n: notation(m) });
    g.quietKingPlies = (moverWasKing && !m.caps.length) ? g.quietKingPlies + 1 : 0;
    g.side = -g.side;
    var k = key(g.board, g.side);
    g.positions[k] = (g.positions[k] || 0) + 1;
    g.legal = legalMoves(g.board, g.side);
    if (!g.legal.length) g.result = { winner: -g.side, reason: count(g.board)[g.side === 1 ? 'w' : 'b'] ? 'blocked' : 'captured' };
    else if (g.positions[k] >= 3) g.result = { winner: 0, reason: 'repetition' };
    else if (g.quietKingPlies >= 30) g.result = { winner: 0, reason: 'kings15' };
    return m;
  }

  var api = {
    initialBoard: initialBoard, legalMoves: legalMoves, applyMove: applyMove,
    capturesFrom: capturesFrom, notation: notation, name: name, rc: rc, idx: idx,
    isDark: isDark, sideOf: sideOf, count: count, newGame: newGame, play: play,
    replay: replay, samePath: samePath
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Damka = api;
})(this);
