/*
 * town-roo-art-m2.js — original procedural kangaroo player sprite (M2 art lane T2).
 *
 * Classic script. Exposes window.TownRooArtM2 (deep-frozen):
 *   version                          'm2'
 *   getFrame({direction, action, frame}) -> frozen {w, h, rgba, anchorX, anchorY}
 *   getFrameCount({direction, action})   -> integer
 *   palette                          { name: '#rrggbb' } for every opaque colour used
 *   metrics                          canvas size, anchor, frame counts/timings, shadow geometry
 *
 * Every frame is drawn at load time from simple shapes (ellipses and tapered strokes) on a
 * 32x40 palette-index grid, outlined, then expanded to RGBA. No external images, no tracing.
 * Alpha is strictly 0 or 255: there is no antialiasing anywhere, including the baked shadow.
 *
 * Self-test: `node town-roo-art-m2.js [--ascii]`, or in a page that sets
 * window.__TOWN_ROO_DEV__ = true before loading this file (see roo-preview.html).
 */
const __root = {};   // agent-city: module wrap (PROVENANCE.md)
(function (root) {
  'use strict';

  var W = 32, H = 40;
  // Anchor = ground contact point in pixel-edge coordinates: the bottom edge of row 37,
  // horizontally between columns 15 and 16. Identical for every frame.
  var ANCHOR_X = 16, ANCHOR_Y = 38;

  var DIRECTIONS = ['north', 'east', 'south', 'west'];
  var ACTIONS = ['idle', 'walk', 'sprint', 'hop', 'interact'];
  var FRAME_MS = { idle: 520, walk: 150, sprint: 95, hop: 125, interact: 200 };

  // Palette indices (0 = transparent).
  var OUT = 1, DEEP = 2, SHADE = 3, FUR = 4, LIGHT = 5, BELLY = 6, BELLY_SH = 7, EAR = 8, EYE = 9, SHADOW = 10;
  var PALETTE_NAMES = [null, 'outline', 'furDeep', 'furShade', 'fur', 'furLight',
    'belly', 'bellyShade', 'earInner', 'eye', 'shadow'];
  var PALETTE_HEX = [null, '#3a2216', '#7a3f22', '#a65d32', '#c97a43', '#e3a56c',
    '#f3d8ae', '#d6aa7a', '#e9a294', '#1c120c', '#3d3529'];
  var PALETTE_RGB = PALETTE_HEX.map(function (hex) {
    return hex && [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  });

  var SHADOW_CY = 37.5, SHADOW_RX_SIDE = 8.5, SHADOW_RX_FRONT = 8.0;

  // ---------------------------------------------------------------------------------------
  // Raster primitives. A shape is {mask: Uint8Array(W*H), out: pixels that fell off-canvas}.
  // Pixels are sampled at their centres, so (x, y) covers [x, x+1) x [y, y+1).

  function rasterize(test, x0, y0, x1, y1) {
    var mask = new Uint8Array(W * H), out = 0;
    for (var y = Math.floor(y0) - 1; y <= Math.ceil(y1); y++) {
      for (var x = Math.floor(x0) - 1; x <= Math.ceil(x1); x++) {
        if (!test(x + 0.5, y + 0.5)) continue;
        if (x < 0 || y < 0 || x >= W || y >= H) out++;
        else mask[y * W + x] = 1;
      }
    }
    return { mask: mask, out: out };
  }

  function ellipse(cx, cy, rx, ry, angDeg) {
    var a = (angDeg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), R = Math.max(rx, ry);
    return rasterize(function (px, py) {
      var dx = px - cx, dy = py - cy, u = dx * c + dy * s, v = -dx * s + dy * c;
      return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1;
    }, cx - R, cy - R, cx + R, cy + R);
  }

  // Tapered stroke through [[x, y, r], ...].
  function stroke(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) {
      x0 = Math.min(x0, p[0] - p[2]); y0 = Math.min(y0, p[1] - p[2]);
      x1 = Math.max(x1, p[0] + p[2]); y1 = Math.max(y1, p[1] + p[2]);
    });
    return rasterize(function (px, py) {
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1], vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
        var t = L2 ? ((px - a[0]) * vx + (py - a[1]) * vy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var r = a[2] + (b[2] - a[2]) * t, dx = px - a[0] - vx * t, dy = py - a[1] - vy * t;
        if (dx * dx + dy * dy <= r * r) return true;
      }
      return false;
    }, x0, y0, x1, y1);
  }

  // Quadratic curve p0 -> p2 bent towards p1, each point [x, y, r].
  function curve(p0, p1, p2) {
    var pts = [];
    for (var i = 0; i <= 12; i++) {
      var t = i / 12, u = 1 - t, k0 = u * u, k1 = 2 * u * t, k2 = t * t;
      pts.push([k0 * p0[0] + k1 * p1[0] + k2 * p2[0], k0 * p0[1] + k1 * p1[1] + k2 * p2[1],
        k0 * p0[2] + k1 * p1[2] + k2 * p2[2]]);
    }
    return stroke(pts);
  }

  // Rotate by deg; with y pointing down, positive is clockwise on screen.
  function rot(v, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  }

  // ---------------------------------------------------------------------------------------
  // Sprite: palette-index grid + owner grid (which named part painted each pixel).

  function Sprite() {
    this.idx = new Uint8Array(W * H);
    this.own = new Uint8Array(W * H);
    this.names = [null];
    this.clip = {};
  }

  Sprite.prototype.id = function (name) {
    var i = this.names.indexOf(name);
    if (i < 0) { this.names.push(name); i = this.names.length - 1; }
    return i;
  };

  // o.color base; o.rim colours pixels on the part's edge that touch already-painted body
  // (o.rimOn limits which parts count); o.shade / o.light colour the edge facing away from /
  // towards the light (shadeOff / lightOff offsets); o.on restricts painting to listed parts.
  Sprite.prototype.part = function (name, shape, o) {
    var self = this, m = shape.mask, idx = this.idx, own = this.own, id = this.id(name);
    if (shape.out) this.clip[name] = (this.clip[name] || 0) + shape.out;
    var on = o.on && o.on.map(function (n) { return self.id(n); });
    var rimOn = o.rimOn && o.rimOn.map(function (n) { return self.id(n); });
    var so = o.shadeOff || [1, 1], lo = o.lightOff || [-1, -1];
    function inM(x, y) { return x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1; }
    function bodyAt(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H || m[y * W + x]) return false;
      var w = own[y * W + x];
      return w !== 0 && (!rimOn || rimOn.indexOf(w) >= 0);
    }
    var paint = [];
    for (var i = 0; i < W * H; i++) {
      if (!m[i] || (on && on.indexOf(own[i]) < 0)) continue;
      var x = i % W, y = (i / W) | 0, c = o.color;
      if (o.rim && (bodyAt(x - 1, y) || bodyAt(x + 1, y) || bodyAt(x, y - 1) || bodyAt(x, y + 1))) c = o.rim;
      else if (o.shade && !inM(x + so[0], y + so[1])) c = o.shade;
      else if (o.light && !inM(x + lo[0], y + lo[1])) c = o.light;
      paint.push(i, c);
    }
    for (var k = 0; k < paint.length; k += 2) { idx[paint[k]] = paint[k + 1]; own[paint[k]] = id; }
  };

  // Single detail pixel, only drawn on top of existing body.
  Sprite.prototype.dot = function (x, y, c) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (this.idx[y * W + x]) this.idx[y * W + x] = c;
  };

  // 1px outer outline (4-connected, so corners stay round), then the ground shadow underneath.
  // The shadow shrinks as the body lifts; it only fills pixels the body left empty.
  Sprite.prototype.finish = function (lift, shadowRx) {
    var idx = this.idx, edge = [];
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (idx[y * W + x]) continue;
        if ((x > 0 && idx[y * W + x - 1]) || (x < W - 1 && idx[y * W + x + 1]) ||
            (y > 0 && idx[(y - 1) * W + x]) || (y < H - 1 && idx[(y + 1) * W + x])) edge.push(y * W + x);
      }
    }
    edge.forEach(function (i) { idx[i] = OUT; });
    var rx = Math.max(4.5, shadowRx - lift * 0.55), ry = lift > 3 ? 1.1 : 1.6;
    var sh = ellipse(ANCHOR_X, SHADOW_CY, rx, ry);
    for (var i = 0; i < W * H; i++) if (sh.mask[i] && !idx[i]) idx[i] = SHADOW;
  };

  // ---------------------------------------------------------------------------------------
  // Side view (drawn facing east; west is the exact mirror). Upper-body points are relative to
  // the hip and rotate with `lean` (+ = tipped forward). Head features are relative to the head
  // centre. Legs and tail are relative to the hip and do not rotate. Units are pixels.
  // earBack / armAng: + swings ears back; - swings arms forward and up.

  var SIDE = {
    hip: [14.6, 27.4], lift: 0, lean: 0, headFollow: 1, headTilt: 0,
    hipR: 5.6, chest: [3.4, -7.4], chestR: 3.5,
    head: [5.6, -11.6], headR: [3.6, 3.1],
    muzzle: [[1.0, 0.7, 2.2], [4.9, 1.6, 1.3]],
    eye: [1.5, -0.6],
    earNear: [[-0.9, -2.2, 1.45], [-2.0, -6.7, 0.8]], earBack: 0,
    earFar: [[-2.4, -2.0, 1.3], [-4.1, -6.2, 0.75]], earFarBack: 0,
    shoulder: [4.4, -6.4], paw: [2.4, 3.5], arm: 0,
    shoulderFar: [3.6, -6.0], pawFar: [2.4, 3.7], armFar: 0,
    thigh: [-0.8, 2.6, 4.9, 5.5, -25],
    knee: [1.6, 3.6], heel: [-3.0, 7.9], toe: [6.8, 8.3],
    tail: [[-4.4, 3.2, 2.8], [-8.6, 6.8, 1.8], [-11.6, 8.2, 0.9]]
  };

  function buildSide(p) {
    var S = new Sprite();
    var hx = p.hip[0], hy = p.hip[1] - p.lift;
    function fromHip(v) { return [hx + v[0], hy + v[1]]; }
    function upper(v) { var r = rot(v, p.lean); return [hx + r[0], hy + r[1]]; }
    var hc = upper(p.head), hAng = p.lean * p.headFollow + p.headTilt;
    function face(v) { var r = rot(v, hAng); return [hc[0] + r[0], hc[1] + r[1]]; }
    function earDelta(def, back) { return rot([def[1][0] - def[0][0], def[1][1] - def[0][1]], hAng - back); }
    function ear(def, back) {
      var b = face(def[0]), d = earDelta(def, back);
      return stroke([[b[0], b[1], def[0][2]], [b[0] + d[0], b[1] + d[1], def[1][2]]]);
    }
    function arm(sh, paw, ang) {
      var s = upper(sh), d = rot(paw, p.lean + ang);
      return stroke([[s[0], s[1], 1.15], [s[0] + d[0], s[1] + d[1], 1.0]]);
    }
    function pt3(v) { var q = fromHip(v); return [q[0], q[1], v[2]]; }

    S.part('tail', curve(pt3(p.tail[0]), pt3(p.tail[1]), pt3(p.tail[2])), { color: FUR, shade: SHADE, shadeOff: [0, 1] });
    S.part('earFar', ear(p.earFar, p.earFarBack), { color: SHADE });
    S.part('armFar', arm(p.shoulderFar, p.pawFar, p.armFar), { color: SHADE });
    var fh = fromHip(p.heel), ft = fromHip(p.toe);
    S.part('footFar', stroke([[fh[0] - 0.4, fh[1] - 0.9, 1.2], [ft[0] - 0.4, ft[1] - 0.9, 0.85]]), { color: SHADE });
    var ch = upper(p.chest);
    S.part('torso', stroke([[hx, hy, p.hipR], [ch[0], ch[1], p.chestR]]),
      { color: FUR, shade: SHADE, light: LIGHT, shadeOff: [0, 1], lightOff: [-1, 0] });
    var bc = upper([3.9, -3.4]);
    S.part('belly', ellipse(bc[0], bc[1], 2.6, 5.0, p.lean + 18), { color: BELLY, on: ['torso'] });
    var pa = upper([2.4, -0.6]), pb = upper([4.4, -1.2]), pc = upper([5.6, -2.4]);
    S.part('pouch', curve([pa[0], pa[1], 0.5], [pb[0], pb[1], 0.5], [pc[0], pc[1], 0.5]), { color: BELLY_SH, on: ['belly'] });
    var th = fromHip(p.thigh);
    S.part('thigh', ellipse(th[0], th[1], p.thigh[2], p.thigh[3], p.thigh[4]),
      { color: FUR, rim: SHADE, rimOn: ['torso', 'belly', 'pouch'], shade: SHADE, shadeOff: [0, 1] });
    var kn = fromHip(p.knee);
    S.part('shin', stroke([[kn[0], kn[1], 1.6], [fh[0] + 0.4, fh[1] - 0.6, 1.25]]), { color: FUR, shade: SHADE, shadeOff: [0, 1] });
    S.part('foot', stroke([[fh[0], fh[1], 1.3], [ft[0], ft[1], 0.9]]), { color: FUR, shade: SHADE, shadeOff: [0, 1] });
    S.part('arm', arm(p.shoulder, p.paw, p.arm), { color: FUR, rim: DEEP, rimOn: ['torso', 'belly', 'pouch', 'thigh'] });
    S.part('head', ellipse(hc[0], hc[1], p.headR[0], p.headR[1], hAng),
      { color: FUR, rim: DEEP, rimOn: ['earFar', 'arm', 'armFar'], light: LIGHT, lightOff: [-1, -1] });
    var m0 = face(p.muzzle[0]), m1 = face(p.muzzle[1]);
    S.part('muzzle', stroke([[m0[0], m0[1], p.muzzle[0][2]], [m1[0], m1[1], p.muzzle[1][2]]]),
      { color: FUR, shade: BELLY_SH, shadeOff: [0, 1] });
    S.part('earNear', ear(p.earNear, p.earBack), { color: FUR, rim: DEEP, rimOn: ['earFar'] });
    // inner ear: a pink strip down the middle of the near ear
    var eb = face([p.earNear[0][0] + 0.2, p.earNear[0][1] - 0.6]), ed = earDelta(p.earNear, p.earBack);
    S.part('earInner', stroke([[eb[0], eb[1], 0.55], [eb[0] + ed[0] * 0.7, eb[1] + ed[1] * 0.7, 0.4]]), { color: EAR, on: ['earNear'] });
    var e = face(p.eye), n = face([p.muzzle[1][0] + 0.6, p.muzzle[1][1] - 0.5]);
    S.dot(e[0], e[1], EYE);
    S.dot(n[0], n[1], EYE);
    S.finish(p.lift, SHADOW_RX_SIDE);
    return S;
  }

  // ---------------------------------------------------------------------------------------
  // Front (south) and back (north) views share one rig. x is relative to the centre line
  // (ANCHOR_X); y is absolute and moved up by `lift`. `drop` lowers the upper body (crouch).
  // The tail lies to the kangaroo's right in both views, so it is on the viewer's left in
  // south and on the viewer's right in north.

  var FRONT = {
    lift: 0, drop: 0, stretch: 0, headDx: 0,
    headY: 16.2, headR: [4.3, 3.6],
    earL: 14, earR: 14, earLen: 5.0,
    torsoY: 27.2, torsoR: [5.9, 6.2], chestY: 21.8, chestR: [4.4, 3.6],
    shoulderDx: 3.3, shoulderY: 21.8,
    pawL: [1.0, 3.2], pawR: [-1.0, 3.2],
    thighDx: 4.6, thighY: 30.4, thighR: [3.7, 4.6],
    footDx: 3.9, footY: 35.3, footR: [2.3, 1.8],
    tail: [[-1.5, 32.6, 2.4], [-7.0, 35.2, 1.8], [-11.6, 35.4, 1.0]],
    tailBack: [[0, 29.8, 2.7], [0.6, 34.6, 2.1], [6.6, 35.8, 1.1]]
  };

  function buildFrontBack(p, back) {
    var S = new Sprite(), cx = ANCHOR_X, L = p.lift, d = p.drop;
    function X(dx) { return cx + dx; }
    function tailShape(t) {
      return curve([X(t[0][0]), t[0][1] - L, t[0][2]], [X(t[1][0]), t[1][1] - L, t[1][2]], [X(t[2][0]), t[2][1] - L, t[2][2]]);
    }
    var hy = p.headY + d - L, hx = X(p.headDx);
    var earSides = [[-1, p.earL, 'earL'], [1, p.earR, 'earR']];
    function earShape(side, spread, scale) {
      var bx = hx + side * 2.3, by = hy - 2.5, a = spread * Math.PI / 180, len = p.earLen * scale;
      return { base: [bx, by], tip: [bx + side * Math.sin(a) * len, by - Math.cos(a) * len] };
    }
    function armShape(side, paw) {
      var sx = X(side * p.shoulderDx), sy = p.shoulderY + d - L;
      return stroke([[sx, sy, 1.15], [sx + paw[0], sy + paw[1], 1.0]]);
    }

    if (!back) S.part('tail', tailShape(p.tail), { color: FUR, shade: SHADE, shadeOff: [0, 1] });
    if (back) {
      S.part('armL', armShape(-1, p.pawL), { color: SHADE });
      S.part('armR', armShape(1, p.pawR), { color: SHADE });
    }
    S.part('torso', ellipse(cx, p.torsoY + d * 0.6 - L - p.stretch * 0.5, p.torsoR[0], p.torsoR[1] + p.stretch),
      { color: FUR, shade: SHADE, light: back ? LIGHT : undefined, shadeOff: [1, 1] });
    S.part('chest', ellipse(cx, p.chestY + d - L - p.stretch, p.chestR[0], p.chestR[1]),
      { color: FUR, shade: SHADE, shadeOff: [1, 1], light: LIGHT, lightOff: [-1, -1] });
    if (!back) {
      S.part('belly', ellipse(cx, p.torsoY - 0.6 + d * 0.6 - L - p.stretch * 0.5, 3.5, 5.3 + p.stretch), { color: BELLY, on: ['torso', 'chest'] });
      var py = p.torsoY + 1.0 + d * 0.6 - L;
      S.part('pouch', curve([cx - 2.8, py - 1.2, 0.5], [cx, py + 1.6, 0.5], [cx + 2.8, py - 1.2, 0.5]), { color: BELLY_SH, on: ['belly'] });
    } else {
      S.part('spine', stroke([[cx, p.chestY + d - L - 1.5, 0.5], [cx, p.torsoY + d * 0.6 - L + 3, 0.5]]), { color: SHADE, on: ['torso', 'chest'] });
    }
    [-1, 1].forEach(function (side) {
      S.part(side < 0 ? 'thighL' : 'thighR', ellipse(X(side * p.thighDx), p.thighY + d * 0.5 - L, p.thighR[0], p.thighR[1], side * -12),
        { color: FUR, rim: SHADE, rimOn: ['torso', 'chest', 'belly', 'pouch', 'spine', 'thighL'], shade: SHADE, shadeOff: [side, 1] });
    });
    [-1, 1].forEach(function (side) {
      S.part(side < 0 ? 'footL' : 'footR', ellipse(X(side * p.footDx), p.footY - L, p.footR[0], p.footR[1]),
        { color: back ? SHADE : FUR, rim: DEEP, rimOn: ['thighL', 'thighR', 'tail'], shade: back ? undefined : SHADE, shadeOff: [0, 1] });
    });
    if (back) S.part('tail', tailShape(p.tailBack), { color: FUR, rim: DEEP, shade: SHADE, shadeOff: [1, 1], light: LIGHT, lightOff: [-1, 0] });
    if (!back) {
      var armRim = ['torso', 'chest', 'belly', 'pouch', 'thighL', 'thighR'];
      S.part('armL', armShape(-1, p.pawL), { color: FUR, rim: DEEP, rimOn: armRim });
      S.part('armR', armShape(1, p.pawR), { color: FUR, rim: DEEP, rimOn: armRim });
    }
    earSides.forEach(function (es) {
      var e = earShape(es[0], es[1], 1);
      S.part(es[2], stroke([[e.base[0], e.base[1], 1.55], [e.tip[0], e.tip[1], 0.85]]), { color: back ? SHADE : FUR });
    });
    S.part('head', ellipse(hx, hy, p.headR[0], p.headR[1]),
      { color: FUR, rim: DEEP, rimOn: ['earL', 'earR', 'armL', 'armR'], shade: back ? SHADE : undefined, shadeOff: [1, 1], light: LIGHT, lightOff: [-1, -1] });
    if (!back) {
      earSides.forEach(function (es) {
        var e = earShape(es[0], es[1], 0.72);
        S.part(es[2] + 'In', stroke([[e.base[0], e.base[1] - 0.6, 0.6], [e.tip[0], e.tip[1], 0.45]]), { color: EAR, on: [es[2]] });
      });
      S.part('muzzle', ellipse(hx, hy + 1.6, 2.4, 1.8), { color: BELLY, on: ['head'] });
      // eyes 1x2 at columns 13 and 18, nose 2x1 at columns 15-16 (mirror-symmetric about x=16)
      var ey = hy - 0.9;
      S.dot(hx - 2.5, ey, EYE); S.dot(hx - 2.5, ey + 1, EYE);
      S.dot(hx + 2.5, ey, EYE); S.dot(hx + 2.5, ey + 1, EYE);
      S.dot(hx - 0.5, hy + 0.7, EYE); S.dot(hx + 0.5, hy + 0.7, EYE);
      S.dot(hx - 0.5, hy + 2.2, BELLY_SH); S.dot(hx + 0.5, hy + 2.2, BELLY_SH);
      [-1, 1].forEach(function (side) { S.dot(X(side * p.footDx), p.footY - L + 1.4, DEEP); });
    }
    S.finish(L, SHADOW_RX_FRONT);
    return S;
  }

  // ---------------------------------------------------------------------------------------
  // Pose tables. Each entry overrides the base rig for one frame.
  // walk = low shuffle-hop (lift 0-1, both feet together, as real kangaroos move);
  // sprint = long bounds (lean 28-38 degrees, tail straight back, lift 1-4);
  // hop = tall standing jump (crouch, launch, apex at lift 6, descent).

  var SIDE_FRAMES = {
    idle: [
      {},
      { lean: 2, chest: [3.4, -7.0], head: [5.7, -11.2], earBack: 10, tail: [[-4.4, 3.2, 2.8], [-8.6, 6.8, 1.8], [-11.4, 7.6, 0.9]] }
    ],
    walk: [
      { hip: [14.6, 28.2], lean: 12, heel: [-3.0, 7.1], toe: [6.8, 7.5], earBack: 6, arm: 10 },
      { lift: 1, lean: 18, heel: [-4.2, 6.8], toe: [4.8, 9.3], knee: [1.0, 3.8], earBack: 10, arm: 20,
        tail: [[-4.4, 3.0, 2.8], [-8.8, 5.6, 1.8], [-11.8, 6.4, 0.9]] },
      { lift: 1, lean: 14, heel: [-2.0, 6.6], toe: [7.0, 6.4], knee: [1.8, 3.2], earBack: 14, arm: 0,
        tail: [[-4.4, 3.0, 2.8], [-8.8, 4.8, 1.8], [-11.8, 4.6, 0.9]] },
      { lean: 8, heel: [-1.6, 7.9], toe: [8.0, 8.3], knee: [2.2, 3.4], earBack: 8, arm: -10,
        tail: [[-4.4, 3.2, 2.8], [-8.6, 6.2, 1.8], [-11.6, 7.6, 0.9]] }
    ],
    sprint: [
      { hip: [12.8, 27.6], lift: 1, lean: 28, headFollow: 0.4, earBack: 30, earFarBack: 30, arm: -40, armFar: -40,
        thigh: [0.2, 2.2, 4.8, 5.4, -40], knee: [2.4, 3.0], heel: [0.6, 7.6], toe: [9.4, 7.8],
        tail: [[-4.2, 2.0, 2.8], [-7.6, 1.6, 1.8], [-10.2, -0.6, 0.9]] },
      { hip: [12.8, 27.4], lift: 2, lean: 34, headFollow: 0.4, earBack: 38, earFarBack: 38, arm: -50, armFar: -50,
        thigh: [-1.4, 2.6, 4.6, 5.6, -55], knee: [-1.6, 4.0], heel: [-5.0, 6.6], toe: [-1.0, 10.6],
        tail: [[-4.2, 1.8, 2.8], [-7.6, 0.6, 1.8], [-10.2, -2.0, 0.9]] },
      { hip: [12.8, 27.2], lift: 4, lean: 38, headFollow: 0.4, earBack: 45, earFarBack: 45, arm: -60, armFar: -60,
        thigh: [-1.8, 2.0, 4.6, 5.4, -70], knee: [-1.0, 4.0], heel: [-4.0, 6.4], toe: [-9.0, 9.6],
        tail: [[-4.2, 1.4, 2.8], [-7.6, -0.2, 1.8], [-10.2, -2.4, 0.9]] },
      { hip: [12.8, 27.4], lift: 3, lean: 32, headFollow: 0.4, earBack: 36, earFarBack: 36, arm: -45, armFar: -45,
        thigh: [0.0, 2.4, 4.8, 5.4, -30], knee: [2.6, 3.4], heel: [1.4, 6.8], toe: [10.0, 6.0],
        tail: [[-4.2, 1.8, 2.8], [-7.6, 1.8, 1.8], [-10.2, 0.4, 0.9]] }
    ],
    hop: [
      { hip: [14.6, 29.4], lean: 22, earBack: 18, earFarBack: 18, arm: 30, thigh: [-0.6, 2.2, 5.4, 5.0, -15],
        knee: [2.4, 2.4], heel: [-3.0, 5.9], toe: [6.8, 6.3], tail: [[-4.4, 2.6, 2.8], [-8.8, 5.0, 1.8], [-11.8, 6.2, 0.9]] },
      { lift: 3, lean: -6, earBack: -4, earFarBack: -4, arm: -30, armFar: -30, chest: [3.4, -8.0], head: [5.4, -12.4],
        thigh: [-0.6, 3.0, 4.6, 6.0, -10], knee: [-0.4, 5.0], heel: [-2.4, 8.4], toe: [1.6, 11.6],
        tail: [[-4.4, 3.6, 2.8], [-8.0, 7.6, 1.8], [-10.4, 10.4, 0.9]] },
      { lift: 6, lean: 6, earBack: 20, earFarBack: 20, arm: 20, armFar: 20,
        thigh: [-0.4, 2.0, 5.2, 5.0, -35], knee: [2.4, 2.6], heel: [-1.2, 5.2], toe: [7.4, 4.4],
        tail: [[-4.4, 2.8, 2.8], [-8.8, 5.0, 1.8], [-11.4, 4.2, 0.9]] },
      { lift: 3, lean: 12, earBack: 26, earFarBack: 26, arm: -20, armFar: -20,
        thigh: [-0.4, 2.6, 4.9, 5.5, -30], knee: [2.0, 3.8], heel: [-1.6, 7.6], toe: [8.0, 9.0],
        tail: [[-4.4, 3.0, 2.8], [-8.8, 6.0, 1.8], [-11.8, 7.0, 0.9]] }
    ],
    interact: [ // reach forward with the near paw, ears perked
      { lean: 6, arm: -55, armFar: -10, earBack: -6 },
      { lean: 12, arm: -78, paw: [3.4, 4.2], armFar: -20, headTilt: 8, earBack: -10, earFarBack: -6 },
      { lean: 6, arm: -35, armFar: 0, headTilt: 2, earBack: 4 }
    ]
  };

  var FRONT_FRAMES = {
    idle: [
      {},
      { drop: 1, earR: 24 }
    ],
    walk: [
      { drop: 1, thighR: [4.0, 4.4], pawL: [1.4, 2.8], pawR: [-1.4, 2.8] },
      { lift: 1, stretch: 0.6, footR: [2.1, 1.6], earL: 18, earR: 18 },
      { lift: 1, footDx: 3.4, footY: 34.8, footR: [2.0, 1.7], earL: 22, earR: 22, pawL: [1.6, 2.4], pawR: [-1.6, 2.4],
        tail: [[-1.5, 32.6, 2.4], [-7.0, 34.0, 1.8], [-11.4, 32.8, 1.0]], tailBack: [[0, 29.8, 2.7], [1.0, 33.4, 2.1], [6.4, 33.2, 1.1]] },
      { footDx: 4.3, earL: 16, earR: 16, pawL: [0.4, 3.4], pawR: [-0.4, 3.4],
        tail: [[-1.5, 32.6, 2.4], [-7.0, 34.8, 1.8], [-11.4, 34.6, 1.0]], tailBack: [[0, 29.8, 2.7], [0.8, 34.0, 2.1], [6.6, 35.0, 1.1]] }
    ],
    sprint: [ // leaning in: head dropped onto the chest, ears swept out and back, tail raised
      { lift: 1, drop: 2, earL: 42, earR: 42, earLen: 4.4, thighDx: 4.2, footY: 35.6, footR: [2.4, 2.0],
        pawL: [2.0, 1.6], pawR: [-2.0, 1.6], tail: [[-1.5, 31.6, 2.4], [-7.4, 31.0, 1.8], [-11.6, 28.0, 1.0]],
        tailBack: [[0, 29.6, 2.7], [0.4, 32.6, 2.1], [0.8, 34.8, 1.4]] },
      { lift: 2, drop: 2.5, earL: 50, earR: 50, earLen: 4.2, thighDx: 4.0, footY: 34.2, footR: [2.0, 1.5], footDx: 3.4,
        pawL: [2.2, 1.2], pawR: [-2.2, 1.2], tail: [[-1.5, 31.2, 2.4], [-7.4, 30.2, 1.8], [-11.6, 26.8, 1.0]],
        tailBack: [[0, 29.4, 2.7], [0.2, 32.0, 2.1], [0.4, 34.4, 1.4]] },
      { lift: 4, drop: 3, earL: 56, earR: 56, earLen: 4.0, thighDx: 3.8, footY: 33.6, footR: [1.9, 1.4], footDx: 3.2,
        pawL: [2.4, 1.0], pawR: [-2.4, 1.0], tail: [[-1.5, 31.0, 2.4], [-7.4, 29.6, 1.8], [-11.6, 26.0, 1.0]],
        tailBack: [[0, 29.4, 2.7], [0.2, 31.8, 2.1], [0.2, 34.0, 1.4]] },
      { lift: 3, drop: 2.5, earL: 48, earR: 48, earLen: 4.2, thighDx: 4.2, footY: 35.6, footR: [2.4, 2.0],
        pawL: [2.0, 1.4], pawR: [-2.0, 1.4], tail: [[-1.5, 31.4, 2.4], [-7.4, 30.6, 1.8], [-11.6, 27.4, 1.0]],
        tailBack: [[0, 29.6, 2.7], [0.4, 32.4, 2.1], [0.6, 34.8, 1.4]] }
    ],
    hop: [
      { drop: 2.5, thighDx: 5.0, thighR: [4.2, 4.2], earL: 26, earR: 26, pawL: [1.6, 2.4], pawR: [-1.6, 2.4], footR: [2.5, 1.7] },
      { lift: 3, stretch: 1.2, footDx: 3.4, footY: 36.0, footR: [1.9, 2.2], earL: 8, earR: 8, earLen: 5.4,
        pawL: [-1.6, -2.6], pawR: [1.6, -2.6], tail: [[-1.5, 33.0, 2.4], [-6.0, 36.0, 1.8], [-10.0, 36.6, 1.0]],
        tailBack: [[0, 30.0, 2.7], [0.4, 34.8, 2.1], [2.6, 37.4, 1.1]] },
      { lift: 6, footY: 33.8, footDx: 4.4, footR: [2.2, 1.6], thighR: [3.9, 4.3], earL: 18, earR: 18,
        pawL: [-2.0, 1.4], pawR: [2.0, 1.4], tail: [[-1.5, 32.0, 2.4], [-7.0, 33.4, 1.8], [-11.2, 32.6, 1.0]],
        tailBack: [[0, 29.6, 2.7], [1.2, 33.4, 2.1], [6.0, 33.8, 1.1]] },
      { lift: 3, footDx: 4.6, footR: [2.3, 1.9], earL: 28, earR: 28, pawL: [-2.4, 2.0], pawR: [2.4, 2.0],
        tail: [[-1.5, 32.6, 2.4], [-7.0, 34.4, 1.8], [-11.2, 34.0, 1.0]], tailBack: [[0, 29.8, 2.7], [0.8, 34.0, 2.1], [6.4, 34.8, 1.1]] }
    ],
    interact: [ // one paw raised: lift, high reach, out to the side
      { earL: 10, earR: 10, pawR: [0.8, -1.8] },
      { earL: 8, earR: 8, earLen: 5.3, headDx: 0.5, pawR: [2.6, -5.0] },
      { earL: 14, earR: 14, pawR: [3.0, -0.6] }
    ]
  };

  // ---------------------------------------------------------------------------------------
  // Build every frame once at load.

  function merge(base, over) {
    var o = {}, k;
    for (k in base) o[k] = base[k];
    for (k in over) o[k] = over[k];
    return o;
  }

  function mirror(src) {
    var out = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) out[y * W + (W - 1 - x)] = src[y * W + x];
    return out;
  }

  function toRGBA(idx) {
    var rgba = new Uint8ClampedArray(W * H * 4);
    for (var i = 0; i < W * H; i++) {
      var c = PALETTE_RGB[idx[i]];
      if (!c) continue;
      rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  var FRAMES = {};     // FRAMES[direction][action] = [Sprite with .rgba]
  DIRECTIONS.forEach(function (d) { FRAMES[d] = {}; });
  ACTIONS.forEach(function (a) {
    FRAMES.east[a] = SIDE_FRAMES[a].map(function (f) { return buildSide(merge(SIDE, f)); });
    FRAMES.west[a] = FRAMES.east[a].map(function (s) {
      var m = new Sprite();
      m.idx = mirror(s.idx); m.own = mirror(s.own); m.names = s.names; m.clip = s.clip;
      return m;
    });
    FRAMES.south[a] = FRONT_FRAMES[a].map(function (f) { return buildFrontBack(merge(FRONT, f), false); });
    FRAMES.north[a] = FRONT_FRAMES[a].map(function (f) { return buildFrontBack(merge(FRONT, f), true); });
  });
  DIRECTIONS.forEach(function (d) {
    ACTIONS.forEach(function (a) { FRAMES[d][a].forEach(function (s) { s.rgba = toRGBA(s.idx); }); });
  });

  // ---------------------------------------------------------------------------------------
  // Public API

  function checkArgs(args, needFrame) {
    if (!args || typeof args !== 'object') throw new TypeError('TownRooArtM2: expected an options object');
    if (DIRECTIONS.indexOf(args.direction) < 0) {
      throw new RangeError('TownRooArtM2: direction must be one of ' + DIRECTIONS.join('/') + ', got ' + String(args.direction));
    }
    if (ACTIONS.indexOf(args.action) < 0) {
      throw new RangeError('TownRooArtM2: action must be one of ' + ACTIONS.join('/') + ', got ' + String(args.action));
    }
    var f = args.frame;
    if (needFrame && f !== undefined && !(typeof f === 'number' && isFinite(f) && Math.floor(f) === f)) {
      throw new TypeError('TownRooArtM2: frame must be a finite integer, got ' + String(f));
    }
  }

  function getFrameCount(args) {
    checkArgs(args, false);
    return FRAMES[args.direction][args.action].length;
  }

  // Integer frames wrap modulo the frame count (negative too); omitted frame means 0.
  // rgba is a fresh copy on every call, so callers may mutate it freely.
  function getFrame(args) {
    checkArgs(args, true);
    var list = FRAMES[args.direction][args.action], n = list.length, f = args.frame || 0;
    var s = list[((f % n) + n) % n];
    return Object.freeze({ w: W, h: H, rgba: s.rgba.slice(), anchorX: ANCHOR_X, anchorY: ANCHOR_Y });
  }

  function deepFreeze(o) {
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    });
    return Object.freeze(o);
  }

  var palette = {};
  for (var pi = 1; pi < PALETTE_NAMES.length; pi++) palette[PALETTE_NAMES[pi]] = PALETTE_HEX[pi];

  var frameCounts = {};
  ACTIONS.forEach(function (a) { frameCounts[a] = SIDE_FRAMES[a].length; });

  var metrics = {
    w: W, h: H, anchorX: ANCHOR_X, anchorY: ANCHOR_Y,
    directions: DIRECTIONS.slice(), actions: ACTIONS.slice(),
    frameCounts: frameCounts, frameMs: FRAME_MS,
    previewScale: 4,
    alpha: 'binary',
    shadow: { baked: true, cx: ANCHOR_X, cy: SHADOW_CY, rxSide: SHADOW_RX_SIDE, rxFront: SHADOW_RX_FRONT, colorKey: 'shadow' }
  };

  var API = deepFreeze({
    version: 'm2',
    getFrame: getFrame,
    getFrameCount: getFrameCount,
    palette: palette,
    metrics: metrics
  });

  root.TownRooArtM2 = API;

  // ---------------------------------------------------------------------------------------
  // Self-test. Runs under `node town-roo-art-m2.js [--ascii]`, or in a page that sets
  // window.__TOWN_ROO_DEV__ = true before loading this script (preview only). Production pages
  // set neither, so nothing beyond the frozen API is exposed.

  if (root.__TOWN_ROO_DEV__ === true) {
    root.__TownRooArtM2SelfTest = function (opts) { return selfTest(opts || {}); };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
    if (typeof require !== 'undefined' && require.main === module) {
      var result = selfTest({ ascii: process.argv.indexOf('--ascii') >= 0 });
      result.lines.forEach(function (l) { console.log(l); });
      if (result.fails) process.exitCode = 1;
    }
  }

  function selfTest(opts) {
    var ascii = !!opts.ascii, lines = [];
    var CH = ['.', '#', 'd', 's', 'f', 'l', 'b', 'p', 'e', 'o', '_'];
    var fails = 0, checks = 0;
    function ok(cond, msg) { checks++; if (!cond) { fails++; lines.push('FAIL ' + msg); } }
    function silhouette(rgba, withShadow) {
      var m = new Uint8Array(W * H), sh = PALETTE_RGB[SHADOW];
      for (var i = 0; i < W * H; i++) {
        if (rgba[i * 4 + 3] !== 255) continue;
        var isShadow = rgba[i * 4] === sh[0] && rgba[i * 4 + 1] === sh[1] && rgba[i * 4 + 2] === sh[2];
        m[i] = withShadow || !isShadow ? 1 : 0;
      }
      return m;
    }
    function hamming(a, b) { var n = 0; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
    var hexSet = {};
    Object.keys(API.palette).forEach(function (k) { hexSet[API.palette[k]] = true; });
    function hex(r, g, b) { return '#' + [r, g, b].map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }

    ok(API.version === 'm2', 'version');
    ok(Object.isFrozen(API) && Object.isFrozen(API.palette) && Object.isFrozen(API.metrics) &&
      Object.isFrozen(API.metrics.frameCounts) && Object.isFrozen(API.metrics.shadow), 'deep frozen');
    ok(typeof root.TownRooArtM2 === 'object' && root.TownRooArtM2 === API, 'global attached');

    var total = 0;
    DIRECTIONS.forEach(function (d) {
      ACTIONS.forEach(function (a) {
        var n = API.getFrameCount({ direction: d, action: a });
        ok(n >= 2 && n <= 4, d + '/' + a + ' frame count 2-4 (got ' + n + ')');
        ok(n === API.metrics.frameCounts[a], d + '/' + a + ' frame count matches metrics');
        var masks = [];
        for (var f = 0; f < n; f++) {
          total++;
          var tag = d + '/' + a + '/' + f, fr = API.getFrame({ direction: d, action: a, frame: f });
          ok(Object.isFrozen(fr), tag + ' result frozen');
          ok(fr.w === W && fr.h === H && fr.anchorX === ANCHOR_X && fr.anchorY === ANCHOR_Y, tag + ' dims/anchor');
          ok(fr.rgba instanceof Uint8ClampedArray && fr.rgba.length === W * H * 4, tag + ' rgba length');
          var badAlpha = 0, badColour = 0, edge = 0, opaque = 0, lowest = -1;
          for (var i = 0; i < W * H; i++) {
            var al = fr.rgba[i * 4 + 3], x = i % W, y = (i / W) | 0;
            if (al !== 0 && al !== 255) badAlpha++;
            if (al === 0) { if (fr.rgba[i * 4] || fr.rgba[i * 4 + 1] || fr.rgba[i * 4 + 2]) badAlpha++; continue; }
            opaque++;
            if (!hexSet[hex(fr.rgba[i * 4], fr.rgba[i * 4 + 1], fr.rgba[i * 4 + 2])]) badColour++;
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge++;
            lowest = Math.max(lowest, y);
          }
          ok(badAlpha === 0, tag + ' alpha strictly 0/255 with transparent = 0,0,0,0 (' + badAlpha + ' bad)');
          ok(badColour === 0, tag + ' every opaque pixel is a palette colour (' + badColour + ' off-palette)');
          ok(edge === 0, tag + ' 1px empty margin on every canvas edge (' + edge + ' touching)');
          ok(opaque > 250, tag + ' has a body (' + opaque + ' px)');
          ok(lowest === ANCHOR_Y, tag + ' shadow reaches the row just below the anchor line (lowest row ' + lowest + ')');
          var s = FRAMES[d][a][f];
          ok(Object.keys(s.clip).length === 0, tag + ' no part clipped by the canvas ' + JSON.stringify(s.clip));
          var counts = {};
          for (var j = 0; j < W * H; j++) if (s.own[j]) counts[s.names[s.own[j]]] = (counts[s.names[s.own[j]]] || 0) + 1;
          var ears = ['earNear', 'earInner', 'earL', 'earR', 'earLIn', 'earRIn']
            .reduce(function (t, k) { return t + (counts[k] || 0); }, 0);
          ok(ears >= 8, tag + ' ears visible (' + ears + ' px)');
          ok((counts.tail || 0) >= 8, tag + ' tail visible (' + (counts.tail || 0) + ' px)');
          if (d === 'east' || d === 'west') {
            ok((counts.foot || 0) >= 10, tag + ' big rear foot visible (' + (counts.foot || 0) + ' px)');
            ok((counts.muzzle || 0) >= 8, tag + ' muzzle visible (' + (counts.muzzle || 0) + ' px)');
            ok((counts.belly || 0) >= 6 && (counts.pouch || 0) >= 2, tag + ' belly + pouch visible');
          }
          if (d === 'south') ok((counts.belly || 0) >= 20 && (counts.pouch || 0) >= 4, tag + ' belly + pouch visible');
          masks.push(silhouette(fr.rgba, true));
          if (ascii) {
            lines.push('', tag);
            for (var yy = 0; yy < H; yy++) {
              var row = '';
              for (var xx = 0; xx < W; xx++) row += CH[s.idx[yy * W + xx]];
              lines.push(row);
            }
          }
        }
        for (var p = 0; p < masks.length; p++) {
          for (var q = p + 1; q < masks.length; q++) {
            var hd = hamming(masks[p], masks[q]);
            ok(hd >= 4, d + '/' + a + ' frames ' + p + ' and ' + q + ' have distinct silhouettes (hamming ' + hd + ')');
          }
        }
        var w1 = API.getFrame({ direction: d, action: a, frame: n });
        var w0 = API.getFrame({ direction: d, action: a, frame: 0 });
        ok(hamming(w1.rgba, w0.rgba) === 0, d + '/' + a + ' frame index wraps modulo count');
      });
      // walk / sprint / hop must read as different motions: every frame of one vs every frame
      // of another differs by at least 20 silhouette pixels (shadow excluded).
      var moves = ['walk', 'sprint', 'hop'];
      for (var m1 = 0; m1 < moves.length; m1++) {
        for (var m2 = m1 + 1; m2 < moves.length; m2++) {
          var minHd = Infinity;
          for (var f1 = 0; f1 < API.metrics.frameCounts[moves[m1]]; f1++) {
            for (var f2 = 0; f2 < API.metrics.frameCounts[moves[m2]]; f2++) {
              var sa = silhouette(API.getFrame({ direction: d, action: moves[m1], frame: f1 }).rgba, false);
              var sb = silhouette(API.getFrame({ direction: d, action: moves[m2], frame: f2 }).rgba, false);
              minHd = Math.min(minHd, hamming(sa, sb));
            }
          }
          ok(minHd >= 20, d + ' ' + moves[m1] + ' vs ' + moves[m2] + ' silhouettes distinct (min hamming ' + minHd + ')');
        }
      }
    });

    // west is the exact mirror of east, so colours and anchor match across directions
    ACTIONS.forEach(function (a) {
      for (var f = 0; f < API.metrics.frameCounts[a]; f++) {
        var e = FRAMES.east[a][f].idx, wv = FRAMES.west[a][f].idx, same = true;
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) if (e[y * W + x] !== wv[y * W + (W - 1 - x)]) same = false;
        ok(same, 'west/' + a + '/' + f + ' mirrors east');
      }
    });

    var threw = 0, bad = [null, {}, { direction: 'up', action: 'idle' }, { direction: 'east', action: 'run' },
      { direction: 'east', action: 'idle', frame: 0.5 }, { direction: 'east', action: 'idle', frame: '1' },
      { direction: 'east', action: 'idle', frame: Infinity }];
    bad.forEach(function (b) { try { API.getFrame(b); } catch (e) { threw++; } });
    ok(threw === bad.length, 'invalid arguments throw (' + threw + '/' + bad.length + ')');
    var a1 = API.getFrame({ direction: 'south', action: 'idle', frame: 0 });
    a1.rgba[0] = 123;
    ok(API.getFrame({ direction: 'south', action: 'idle', frame: 0 }).rgba[0] === 0, 'returned rgba is a copy');

    lines.push((fails ? 'FAILED ' : 'PASS ') + (checks - fails) + '/' + checks + ' checks over ' + total + ' frames');
    return { checks: checks, fails: fails, frames: total, lines: lines };
  }
})(__root);   // agent-city: was (typeof window !== 'undefined' ? window : globalThis)
export const TownRooArtM2 = __root.TownRooArtM2;   // agent-city: module export (PROVENANCE.md)

