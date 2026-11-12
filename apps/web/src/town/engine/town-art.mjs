/* AGENT OFFICE TOWN M1 — art lane — window.TownArt
 *
 * ORIGINAL pixel art, generated from code at load time. Nothing here is extracted, traced or
 * derived from ROM data or any game asset. Colour ramps are reused from the accepted V2.2 look-dev
 * (input/v22-app/art.js) so the characters sit in the same warm palette as the accepted screenshot.
 *
 * Pure sprite generation: no DOM, canvas, network, timers, listeners, wall clock or randomness.
 * The same request always returns byte-identical pixels.
 *
 * ---- Frame geometry and world scale -------------------------------------------------------------
 *   Every character frame is 24 x 40 RGBA. Pixels are drawn 1:1 into the logical scene buffer (the
 *   native 480x270 scene) — never scaled by the renderer; the integer upscale is presentation only.
 *   pivotX = 12, pivotY = 40 are EDGE coordinates: (12,40) is the bottom edge of the shoe soles,
 *   centred between the feet. The lowest opaque row of every frame is row 39.
 *       ctx.drawImage(img, Math.round(groundX) - pivotX, Math.round(groundY) - pivotY)
 *   The figure is ~38 px tall (outlined hair/hat top at row 2; Haiku's top-knot reaches row 0).
 *   Recommended world scale: 16 logical px per world unit at the focus plane (the V2.2 value), so
 *   a figure is ~2.4 units tall and its feet
 *   occupy ~0.6 x 0.4 units. At 480x270 a figure is ~14% of the view height: readable, not a
 *   miniature, not a sticker. (V2.2 used 20x32 frames on a ~422x190 buffer.)
 *
 * ---- Animation clock ----------------------------------------------------------------------------
 *   `frame` is an integer display-frame counter at FRAME_HZ = 60 (frame = floor(elapsedMs*60/1000)).
 *   Each action has a frame-timed loop (see getAnimation(action)). Any frame value is accepted:
 *   negative, fractional, NaN or missing values are normalised, never thrown on. Passing a constant
 *   frame (e.g. 0) gives a static representative pose — suitable for reduced motion.
 *   'unknown' (aliases offline/stale) is ONE static frame; idle/wait only blink/shift weight.
 *
 * ---- Required API (contract) --------------------------------------------------------------------
 *   TownArt.version                   'm1'
 *   TownArt.getSprite({id, modelFamily, facing, action, frame, costume})
 *        -> {width, height, rgba: Uint8ClampedArray, pivotX, pivotY}   (exactly these five keys,
 *           fresh rgba copy per call, alpha only 0 or 255, rgba.length === width*height*4)
 *   TownArt.listStyles()              -> >= 6 style descriptors
 * ---- Additive helpers (integration may ignore) --------------------------------------------------
 *   metrics, getAnimation(action), resolve(request), spriteKey(request), listProps(), getProp({kind}),
 *   diagnostics (array; empty unless a template problem was detected — fails soft, never throws)
 */
const __root = {};   // agent-city: module wrap (PROVENANCE.md)
(function (root) {
  'use strict';

  var W = 24, H = 40, PIVOT_X = 12, PIVOT_Y = 40, FRAME_HZ = 60;

  // ---- colour helpers ---------------------------------------------------------------------------
  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function pack(c) { return ((255 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0; }
  function unpack(p) { return [(p >>> 16) & 255, (p >>> 8) & 255, p & 255]; }
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  // V2.2 ramps (dark -> light) — the shared palette of the accepted screenshot.
  var RAMP = {
    wood: ['#4a2f22', '#6b4430', '#8a5a3a', '#a8744a', '#be8a58', '#d4a26a', '#e6bd86'],
    plaster: ['#6a5848', '#8e7a64', '#b39c80', '#cdb898', '#dfcdac', '#ece0c4'],
    sage: ['#26332c', '#34463b', '#46604f', '#5b7a63', '#76957a'],
    stone: ['#2f3338', '#41464d', '#565c63', '#6e747a', '#878c8f', '#a3a6a3', '#bdbeb8'],
    slate: ['#232a38', '#2e384a', '#3c4860', '#4c5a74', '#5e6e88', '#7486a0'],
    olive: ['#2f3820', '#3f4a2a', '#525f35', '#677543', '#7e8a55', '#98a26c'],
    terra: ['#4a2218', '#6a3222', '#8a4630', '#a85e3e', '#c47a50', '#d89a6a'],
    ochre: ['#4e3816', '#6e5020', '#94702c', '#b8903c', '#d6b058', '#ead07e'],
    char: ['#16171b', '#22242a', '#30333b', '#42464f', '#585d67', '#737985'],
    birch: ['#6e604c', '#8e7e64', '#ad9b7c', '#c8b694', '#ddcdab', '#ece0c2'],
    leaf: ['#16261a', '#203a24', '#2e5230', '#3f6c3a', '#58884a', '#78a45e', '#9cc070'],
    red: ['#3e1414', '#62201c', '#8c3226', '#b44a34', '#d06a48'],
    paper: ['#9a948a', '#bab4a6', '#d6d0c0', '#ebe6d8', '#f8f4ea'],
    sky: ['#e8b98a', '#f2d0a4', '#f6e2c0', '#cfe0dc', '#a9cad4', '#86b2c4'],
    green: ['#1e3326', '#2a4634', '#385c44', '#4a7456', '#628e6a'],
    cut: ['#120e0c', '#1c1714', '#282019', '#352a21', '#45372b'],
    glow: ['#f0d898', '#f6e6b0', '#fff4d0']
  };

  // ---- template helpers -------------------------------------------------------------------------
  // G(y0, rows): full-width (24 col) layer starting at row y0. D(x0, y0, rows): partial layer.
  // '.' = leave pixel unchanged, '_' = erase, any other char = palette symbol.
  function G(y0, rows) { return { x0: 0, y0: y0, rows: rows, full: true }; }
  function D(x0, y0, rows) { return { x0: x0, y0: y0, rows: rows, full: false }; }

  /* Palette symbols
   *  o outline        s/S skin/shade  b blush  m mouth/closed-lid  e eye
   *  h/H/d hair       t/T/l top main/shade/light   c/C inner layer (shirt, scarf)
   *  a/A accent       r/R sleeve      p/P pants    u/U knee/shin    q/Q lower leg   f/F shoe
   *  k/K/j hat-hood main/shade/light  g metal/button   i/I accessory dark/light
   *  n/N paper        v/V book cover  x ink/pen    y/Y leather/board   z/Z costume badge */

  // ---- shared body templates (base side views are authored facing WEST; EAST mirrors the
  //      symmetric base only — asymmetric details are authored per final facing in DETAILS) ------
  var FACE = {
    S: G(7, [
      '.......ssssssssss.......',
      '......ssssssssssss......',
      '.....ssssssssssssss.....',
      '.....ssssssssssssss.....',
      '.....ssssessssessss.....',
      '.....ssssessssessss.....',
      '.....sssbssssssbsss.....',
      '......sssssmmsssss......',
      '.......SssssssssS.......'
    ]),
    W: G(7, [
      '......ssssssss..........',
      '.....ssssssssss.........',
      '.....ssssssssss.........',
      '.....ssssssssss.........',
      '.....ssesssssss.........',
      '....sssesssssss.........',
      '.....ssbsssssss.........',
      '.....smssssssss.........',
      '......Ssssssss..........'
    ])
  };

  var LEGS = {
    front: {
      stand: G(29, [
        '........pppppppP........',
        '........ppP..ppP........',
        '........ppP..ppP........',
        '........uuU..uuU........',
        '........uuU..uuU........',
        '........qqQ..qqQ........',
        '........qqQ..qqQ........',
        '.......ffff..ffff.......',
        '.......fffF..fffF.......',
        '.......FFFF..FFFF.......'
      ]),
      stepA: G(29, [
        '........pppppppP........',
        '........ppP..ppP........',
        '........uuU..ppP........',
        '........qqQ..uuU........',
        '........qqQ..uuU........',
        '.......ffff..qqQ........',
        '.......fffF..qqQ........',
        '.......FFFF..ffff.......',
        '.............fffF.......',
        '.............FFFF.......'
      ]),
      stepB: G(29, [
        '........pppppppP........',
        '........ppP..ppP........',
        '........ppP..uuU........',
        '........uuU..qqQ........',
        '........uuU..qqQ........',
        '........qqQ..ffff.......',
        '........qqQ..fffF.......',
        '.......ffff..FFFF.......',
        '.......fffF.............',
        '.......FFFF.............'
      ]),
      tap: G(29, [
        '........pppppppP........',
        '........ppP..ppP........',
        '........ppP..ppP........',
        '........uuU..uuU........',
        '........uuU..uuU........',
        '........qqQ..qqQ........',
        '........qqQ..ffff.......',
        '.......ffff..fffF.......',
        '.......fffF..FFFF.......',
        '.......FFFF.............'
      ])
    },
    side: {
      stand: G(29, [
        '.........ppppPP.........',
        '..........pppP..........',
        '..........pppP..........',
        '..........uuuU..........',
        '..........uuuU..........',
        '..........qqqQ..........',
        '..........qqqQ..........',
        '........ffffff..........',
        '........fffffF..........',
        '........FFFFFF..........'
      ]),
      stepA: G(29, [
        '.........ppppPP.........',
        '........pppp.PPP........',
        '........ppp...PPP.......',
        '.......uuu....UUU.......',
        '.......uuu.....UUU......',
        '......qqq......QQQ......',
        '......qqq.......QQQ.....',
        '....ffffff......FFF.....',
        '....fffffF.....FFFF.....',
        '....FFFFFF.....FF.......'
      ]),
      stepB: G(29, [
        '.........ppppPP.........',
        '........PPPP.ppp........',
        '........PPP...ppp.......',
        '.......UUU....uuu.......',
        '.......UUU.....uuu......',
        '......QQQ......qqq......',
        '......QQQ.......qqq.....',
        '....FFFFFF......fff.....',
        '....FFFFFF.....ffff.....',
        '....FFFFFF.....FF.......'
      ]),
      tap: G(29, [
        '.........ppppPP.........',
        '..........pppP..........',
        '..........pppP..........',
        '..........uuuU..........',
        '..........uuuU..........',
        '..........qqqQ..........',
        '........ffqqqQ..........',
        '........ffffff..........',
        '..........fffF..........',
        '..........FFFF..........'
      ])
    }
  };

  // Arms + hand-held props. Each entry is a list of layers. 'front' = facing south,
  // 'back' = facing north, 'side' = facing west (mirrored for east), 'sideFar' = far arm,
  // painted behind the trunk.
  var ARM_DOWN_FRONT = G(18, [
    '....rR............rR....',
    '....rR............rR....',
    '....rR............rR....',
    '....rR............rR....',
    '....rR............rR....',
    '....rR............rR....',
    '....rR............rR....',
    '....rR............rR....',
    '....ss............ss....',
    '....sS............sS....'
  ]);
  var BOOK_FRONT = G(18, [
    '....rR............rR....',
    '....rR............rR....',
    '....rRnnnnnnnnnnnnrR....',
    '....rsvvvvvVVvvvvvsR....',
    '....rsvvvvvVVvvvvvsR....',
    '....RsvvvvvVVvvvvvsR....',
    '......VVVVVVVVVVVV......'
  ]);
  var CLIP_FRONT = G(18, [
    '....rR............rR....',
    '....rR............rR....',
    '....rR......gg....rR....',
    '....rRrrsyyyyyyyy.rR....',
    '....RR...yyyyyyyysrR....',
    '.........yyyyyyyysR.....',
    '.........yyyyyyyy.......',
    '.........YYYYYYYY.......'
  ]);
  var ELBOWS_BACK = G(18, [
    '....rR............rR....',
    '....rR............rR....',
    '...rrR............rRr...',
    '...RRR............RRR...'
  ]);
  var CLIP_BACK = G(18, [
    '....rR............rR....',
    '...rrR............rR....',
    '...RRR............rR....',
    '..................rR....',
    '..................RR....'
  ]);
  var BOOK_SIDE = G(18, [
    '..........rrR...........',
    '..nnnn....rrRo..........',
    '..nnnnN...rrRo..........',
    '..vvvvvsrrrrRo..........',
    '...VVVVSRRRR............'
  ]);
  var CLIP_SIDE = G(18, [
    '..........rrR...........',
    '.....yn...rrRo..........',
    '.....yn...rrRo..........',
    '.....yn...rrRo..........',
    '.....yns.rrRo...........',
    '.....ynsrrrR............',
    '.....YY.RRR.............'
  ]);

  var ARMS = {
    front: {
      down: [ARM_DOWN_FRONT],
      // front walk: the hand OPPOSITE the lifted leg comes forward (raised 1px)
      swingB: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....ss............rR....',
        '....sS............ss....',
        '..................sS....'
      ])],
      swingA: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............ss....',
        '....ss............sS....',
        '....sS..................'
      ])],
      typeA: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rRrrss........rR....',
        '....RRRRSS....ssrrrR....',
        '..............SSRRRR....'
      ])],
      typeN: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rRrrss....ssrrrR....',
        '....RRRRSS....SSRRRR....'
      ])],
      typeB: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR........ssrrrR....',
        '....rRrrss....SSRRRR....',
        '....RRRRSS..............'
      ])],
      book0: [BOOK_FRONT],
      book1: [BOOK_FRONT, D(11, 19, ['nN'])],
      book2: [BOOK_FRONT, D(13, 18, ['.n', 'nN'])],
      clip0: [CLIP_FRONT, D(10, 19, ['x', 'x'])],
      clip1: [CLIP_FRONT, D(11, 20, ['x'])],
      clip2: [CLIP_FRONT, D(14, 19, ['x', 'x'])],
      cross: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rRrrrrrrrrrrrrrR....',
        '....rRssRRRRRRRRssrR....',
        '.....RRRRRRRRRRRRRR.....'
      ])]
    },
    back: {
      typeA: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '...rrR............rR....',
        '...RRR............rR....',
        '..................RR....'
      ])],
      typeN: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....RR............RR....'
      ])],
      typeB: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rRr...',
        '....rR............RRR...',
        '....RR..................'
      ])],
      book0: [ELBOWS_BACK],
      book1: [ELBOWS_BACK],
      book2: [ELBOWS_BACK],
      clip0: [CLIP_BACK],
      clip1: [CLIP_BACK, D(19, 20, ['r', 'R'])],
      clip2: [CLIP_BACK],
      cross: [G(18, [
        '....rR............rR....',
        '....rR............rR....',
        '....rR............rR....',
        '....rRr..........rrR....',
        '....RRR..........RRR....'
      ])]
    },
    side: {
      down: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........sS............',
        '..........SS............'
      ])],
      swingA: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '...........rrRo.........',
        '...........rrRo.........',
        '............rrRo........',
        '............rrR.........',
        '.............sS.........',
        '.............SS.........'
      ])],
      swingB: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '.........rrRo...........',
        '.........rrRo...........',
        '........rrRo............',
        '........rrR.............',
        '.......sS...............',
        '.......SS...............'
      ])],
      typeA: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '..........rrRo..........',
        '......ss..rrRo..........',
        '......SSrrrrRo..........',
        '........RRRR............'
      ])],
      typeN: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........rrRo..........',
        '.....ssrrrrrRo..........',
        '.....SSRRRRRR...........'
      ])],
      typeB: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '..........rrRo..........',
        '..........rrRo..........',
        '........rrrrRo..........',
        '......ssRRRR............',
        '......SS................'
      ])],
      book0: [BOOK_SIDE],
      book1: [BOOK_SIDE, D(3, 18, ['nn'])],
      book2: [BOOK_SIDE, D(5, 16, ['n', 'n'])],
      clip0: [CLIP_SIDE, D(7, 17, ['x', 'x'])],
      clip1: [CLIP_SIDE, D(7, 19, ['x', 'x'])],
      clip2: [CLIP_SIDE, D(7, 21, ['x'])],
      cross: [G(18, [
        '..........rrR...........',
        '..........rrRo..........',
        '..........rrRo..........',
        '.......rrrrrRo..........',
        '.......sRRRRR...........'
      ])]
    },
    sideFar: {
      swingA: [D(6, 21, ['RR', 'RR', 'SS'])],
      swingB: [D(16, 21, ['RR', 'RR', 'SS'])]
    }
  };
  ARMS.back.down = ARMS.front.down;
  ARMS.back.swingA = ARMS.front.swingA;
  ARMS.back.swingB = ARMS.front.swingB;

  // ---- garments (trunk), per style: S, N, W -----------------------------------------------------
  var GARMENT = {
    coat: {
      S: G(16, [
        '..........cccc..........',
        '.......tccccccccT.......',
        '......ttcCccccCctT......',
        '......tttcCCCCctTT......',
        '.......ttttTgtttT.......',
        '.......ttttTttttT.......',
        '.......ttttTgtttT.......',
        '.......ttttTttttT.......',
        '.......AAAAAgAAAA.......',
        '.......ttttTttttT.......',
        '......tttttTttttTT......',
        '......tttttTttttTT......',
        '......tttttTttttTT......',
        '......tttttTTtttTT......',
        '......ttttt..tttTT......',
        '......TTTTT..TTTTT......'
      ]),
      N: G(16, [
        '..........cccc..........',
        '.......cccccccccc.......',
        '......ttttttttttTT......',
        '......ttttttttttTT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......AAAAAAAAAA.......',
        '.......tttttttttT.......',
        '......ttttttttttTT......',
        '......tttttTtttttT......',
        '......tttttTtttttT......',
        '......tttttTtttttT......',
        '......ttttt..ttttT......',
        '......TTTTT..TTTTT......'
      ]),
      W: G(16, [
        '..........ccc...........',
        '........cccccc..........',
        '........ttcccttT........',
        '........tttccttT........',
        '........gttttttT........',
        '........tttttttT........',
        '........gttttttT........',
        '........tttttttT........',
        '........AAAAAAAA........',
        '........tttttttT........',
        '.......ttttttttTT.......',
        '.......ttttttttTT.......',
        '.......ttttttttTT.......',
        '.......tttttttttTT......',
        '.......ttttttttttTT.....',
        '.......TTTTTTTTTTTT.....'
      ])
    },
    cardigan: {
      S: G(16, [
        '..........SSSS..........',
        '.......tttccccttT.......',
        '......ttttcCCcttTT......',
        '......tttttcctttTT......',
        '.......ttttcctttT.......',
        '.......tttTcctttT.......',
        '.......tttTgctttT.......',
        '.......tttTcctttT.......',
        '.......tttTgctttT.......',
        '.......tttTcctttT.......',
        '.......tttTgctttT.......',
        '.......llllllllll.......',
        '.......TTTTTTTTTT.......'
      ]),
      N: G(16, [
        '..........SSSS..........',
        '.......tttttttttT.......',
        '......tttttttttttT......',
        '......tttttttttttT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......llllllllll.......',
        '.......TTTTTTTTTT.......'
      ]),
      W: G(16, [
        '..........SSS...........',
        '........ccttttt.........',
        '........cttttttT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........llllllll........',
        '........TTTTTTTT........'
      ])
    },
    jacket: {
      S: G(16, [
        '..........SSSS..........',
        '.......ttttcctttT.......',
        '......tttttcctttTT......',
        '......ttttttAtttTT......',
        '.......tttttAttTT.......',
        '.......tttttAttTT.......',
        '.......tttttAttTT.......',
        '.......tttttAttTT.......',
        '.......lllllAllll.......',
        '.......cccccccccC.......',
        '.......cccccccccC.......',
        '.......cccccccccC.......',
        '.......CCCCCCCCCC.......'
      ]),
      N: G(16, [
        '..........SSSS..........',
        '.......tttttttttT.......',
        '......tttttttttttT......',
        '......tttttttttttT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......llllllllll.......',
        '.......cccccccccC.......',
        '.......cccccccccC.......',
        '.......cccccccccC.......',
        '.......CCCCCCCCCC.......'
      ]),
      W: G(16, [
        '..........SSS...........',
        '........cctttt..........',
        '........AttttttT........',
        '........AttttttT........',
        '........AttttttT........',
        '........AttttttT........',
        '........AttttttT........',
        '........AttttttT........',
        '........llllllll........',
        '........cccccccC........',
        '........cccccccC........',
        '........cccccccC........',
        '........CCCCCCCC........'
      ])
    },
    hoodie: {
      S: G(16, [
        '..........SSSS..........',
        '.......tttttttttT.......',
        '......ttttattattTT......',
        '......ttttattattTT......',
        '.......tttattattT.......',
        '.......tttAttAttT.......',
        '.......ttttttttTT.......',
        '.......tTTTTTTTtT.......',
        '.......tTttttttTT.......',
        '.......tTttttttTT.......',
        '.......tttttttttT.......',
        '.......aaaaaaaaaa.......',
        '.......TTTTTTTTTT.......'
      ]),
      N: G(16, [
        '..........SSSS..........',
        '.......tttttttttT.......',
        '......tttttttttttT......',
        '......tttttttttttT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......aaaaaaaaaa.......',
        '.......TTTTTTTTTT.......'
      ]),
      W: G(16, [
        '..........SSS...........',
        '........tttttt..........',
        '........tatttTTT........',
        '........tatttTTT........',
        '........tAtttTTT........',
        '........tttttTTT........',
        '........tttttTTT........',
        '........TTTTtTTT........',
        '........tTttttTT........',
        '........tTttttTT........',
        '........tttttttT........',
        '........aaaaaaaa........',
        '........TTTTTTTT........'
      ])
    },
    smock: {
      S: G(16, [
        '..........SSSS..........',
        '.......tttTccTttT.......',
        '......ttttTccTtttT......',
        '......tttttttttttT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......TTTTTTTTTT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......TTTTTTTTTT.......'
      ]),
      N: G(16, [
        '..........SSSS..........',
        '.......tttttttttT.......',
        '......tttttttttttT......',
        '......tttttttttttT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......TTTTTTTTTT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......TTTTTTTTTT.......'
      ]),
      W: G(16, [
        '..........SSS...........',
        '........cctttt..........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........TTTTTTTT........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........ttttttTT........',
        '........TTTTTTTT........'
      ])
    },
    vest: {
      S: G(16, [
        '..........aaaa..........',
        '.......tccaAAaccT.......',
        '......ttccaAAacctT......',
        '......tttcaAAactTT......',
        '.......tttcAActtT.......',
        '.......ttttcctttT.......',
        '.......tTTtcctTTT.......',
        '.......ttttcctttT.......',
        '.......ttttcctttT.......',
        '.......ttttcctttT.......',
        '.......ttttcctttT.......',
        '.......FFFFFgFFFF.......',
        '.......ppppppppPP.......'
      ]),
      N: G(16, [
        '..........AAAA..........',
        '.......tttttttttT.......',
        '......tttttttttttT......',
        '......tttttttttttT......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......tttttttttT.......',
        '.......FFFFFFFFFF.......',
        '.......ppppppppPP.......'
      ]),
      W: G(16, [
        '..........aaa...........',
        '........caaattt.........',
        '........cAtttttT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........cTTttttT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........ctttttTT........',
        '........FFFFFFFF........',
        '........ppppppPP........'
      ])
    }
  };

  // ---- hair / headwear, per style: S, N, W ------------------------------------------------------
  var HAIR = {
    opus: {
      S: G(3, [
        '........hHHhhhhh........',
        '......hHHhhddhhhhh......',
        '.....hHHhhhddhhhhhh.....',
        '....hHhhhhhddhhhhhhd....',
        '....hhhhhd....dhhhhd....',
        '....hhhhd......dhhhd....',
        '....hhd..........dhd....',
        '....hh............hd....',
        '....hh............hd....',
        '...hhh............hhd...',
        '...hhd............hhd...',
        '...hhh............dhd...',
        '...hhd............hhd...',
        '...dhh............hhd...',
        '...hhh............hdd...',
        '...hhd............hhd...',
        '....hh............hd....',
        '...hhd............dhh...',
        '....d..............d....'
      ]),
      N: G(3, [
        '........hhhHhhhh........',
        '......hhhHHhhhhhhh......',
        '.....hhhHHhhhhhhhhh.....',
        '....hhhHhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhdhhhhhhhd....',
        '....hhhhhhhdhhhhhhhd....',
        '....hhhhhhdhhdhhhhhd....',
        '...hhhhhhhdhhdhhhhhhd...',
        '...hhhhhhdhhhhdhhhhhd...',
        '...hhhhhhhhhhhhhhhhhd...',
        '...hhhhhdhhhhhhdhhhhd...',
        '...hhhhhhhhhhhhhhhhhd...',
        '......hhhhhhhhhhhd......',
        '......hhhhdhhhhhhd......',
        '......hhhhhhhhhhhd......',
        '.......hhhhhhhhhd.......',
        '.......hdhhhhhhdh.......',
        '........dhhhhhhd........'
      ]),
      W: G(3, [
        '.........hhhhhhh........',
        '.......hHHhhhhhhhh......',
        '......hHHhhhhhhhhhh.....',
        '.....hHhhhhhhhhhhhhd....',
        '.....hhhhhhhhhhhhhhd....',
        '.....hhh...hhhhhhhhd....',
        '.....hd.....hhhhhhhd....',
        '............hhhhhhhd....',
        '............dhhhhhhd....',
        '............hhhhhhhhd...',
        '............hhhhhhhhd...',
        '...........hhhhhhhhhd...',
        '............hhhhhhhhd...',
        '............hhhhhhhhd...',
        '............hdhhhhhhd...',
        '.............hhhhhhd....',
        '.............hhhhhhd....',
        '..............hhhhd.....',
        '..............hdhhd.....'
      ])
    },
    sonnet: {
      S: G(3, [
        '........hhhhhhhh........',
        '......hhHHhhhhhhhh......',
        '.....hhHHhhhhhhdhhh.....',
        '....hhhhhhhhhhhdhhhh....',
        '....hhhhhhhhhhh.dhhh....',
        '....hhhhhhhhh....hhh....',
        '....hhhhhh.......dhh....',
        '....hhhd..........hh....',
        '....hh............hh....',
        '....hhh..........hhh....',
        '....hhh..........hhh....',
        '....dhh..........hhd....',
        '.....dd..........dd.....'
      ]),
      N: G(3, [
        '........hhhhhhhh........',
        '......hhhHHhhhhhhh......',
        '.....hhhHHhhhhhhhhh.....',
        '....hhhHhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....dhhhhhhhhhhhhhhd....',
        '.....dddhhhhhhhhddd.....'
      ]),
      W: G(3, [
        '.........hhhhhhh........',
        '.......hHHhhhhhhhh......',
        '......hHHhhhhhhhhhh.....',
        '.....hHhhhhhhhhhhhhd....',
        '.....hhhhhhhhhhhhhhd....',
        '.....hhhhh..hhhhhhhd....',
        '.....hhd....hhhhhhhd....',
        '............hhhhhhhd....',
        '...........hhhhhhhhd....',
        '...........hhhhhhhhd....',
        '...........hhhhhhhhd....',
        '...........dhhhhhhhd....',
        '............dddddddd....'
      ])
    },
    haiku: {
      S: G(1, [
        '..........hHHh..........',
        '...........aa...........',
        '......h.hhhhhhhh.h......',
        '.....hhhhHHhhhhhhhh.....',
        '....hhhHHhhhhhhhhhhh....',
        '....hhHhhhhhhhhhhhhd....',
        '...hhhhhhhhhhhhhhhhhd...',
        '....hhhhhhhhhhhhhhhd....',
        '....hhd.hhd..dhh.dhd....',
        '....hd............dh....',
        '....s..............s....',
        '....S..............S....'
      ]),
      N: G(1, [
        '..........hHHh..........',
        '...........aa...........',
        '......h.hhhhhhhh.h......',
        '.....hhhhHHhhhhhhhh.....',
        '....hhhHHhhhhhhhhhhh....',
        '....hhHhhhhhhhhhhhhd....',
        '...hhhhhhhhhhhhhhhhhd...',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....hhhhhhhhhhhhhhhd....',
        '....shhhhhhhhhhhhhhs....',
        '.....hdhhhdhhdhhhdh.....',
        '........ssssssss........',
        '.........SSSSSS.........'
      ]),
      W: G(1, [
        '...........hHHh.........',
        '............aa..........',
        '.......h.hhhhhhh.h......',
        '......hhhHHhhhhhhhh.....',
        '.....hhHHhhhhhhhhhhh....',
        '....hhHhhhhhhhhhhhhhd...',
        '.....hhhhhhhhhhhhhhhhd..',
        '.....hhd.hhhhhhhhhhhd...',
        '.....hd....hhhhhhhhd....',
        '...........hhhhhhhd.....',
        '............sShhhhd.....',
        '............SShhhd......',
        '.............hhhd.......'
      ])
    },
    codex: {
      S: G(3, [
        '.........kkkkkk.........',
        '.......kkkkkkkkkk.......',
        '......kkjkkkkkkkkK......',
        '.....kkjkkkkkkkkkkK.....',
        '....kkjkkkkkkkkkkkkK....',
        '....kkkKKKKKKKKKKkkK....',
        '....kkKhhhhhdhhhhKkK....',
        '....kkK..........KkK....',
        '....kkK..........KkK....',
        '....kkK..........KkK....',
        '....kkK..........KkK....',
        '....kkkK........KkkK....',
        '.....kkkK......KkkK.....',
        '......kkkkkkkkkkkK......'
      ]),
      N: G(3, [
        '.........kkkkkk.........',
        '.......kkkkkkkkkk.......',
        '......kkjkkkkkkkkK......',
        '.....kkjkkkkkkkkkkK.....',
        '....kkjkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '....kkkkkkkkkkkkkkkK....',
        '.....kkkkkkkkkkkkkK.....',
        '......KkkkkkkkkkkK......',
        '.......KKkkkkkkKK.......',
        '........KKkkkkKK........',
        '..........KKKK..........'
      ]),
      W: G(3, [
        '..........kkkkkk........',
        '........kkkkkkkkkk......',
        '.......kjkkkkkkkkkK.....',
        '......kjkkkkkkkkkkkK....',
        '.....kkkkkkkkkkkkkkK....',
        '.....KKKKkkkkkkkkkkK....',
        '.....hhhKkkkkkkkkkkK....',
        '.........KkkkkkkkkkK....',
        '.........KkkkkkkkkkK....',
        '.........KkkkkkkkkkK....',
        '.........KkkkkkkkkkK....',
        '.........KkkkkkkkkK.....',
        '..........KkkkkkkkK.....',
        '...........KkkkkkkK.....',
        '...............KKK......'
      ])
    },
    unknown: {
      S: G(3, [
        '........kkkkkkkk........',
        '......kkkkkkkkkkkk......',
        '.....kjkkkkkkkkkkkK.....',
        '....kjkkkkkkkkkkkkkK....',
        '....jjjjjjjjjjjjjjjj....',
        '....KKKKKKKKKKKKKKKK....',
        '....hh............hh....',
        '....h..............h....'
      ]),
      N: G(3, [
        '........kkkkkkkk........',
        '......kkkkkkkkkkkk......',
        '.....kjkkkkkkkkkkkK.....',
        '....kjkkkkkkkkkkkkkK....',
        '....jjjjjjjjjjjjjjjj....',
        '....KKKKKKKKKKKKKKKK....',
        '....hhhhhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhh....',
        '.....hhhhhhhhhhhhhh.....',
        '........ssssssss........',
        '.........SSSSSS.........'
      ]),
      W: G(3, [
        '.........kkkkkkk........',
        '.......kkkkkkkkkkk......',
        '......kjkkkkkkkkkkK.....',
        '.....kjkkkkkkkkkkkkK....',
        '.....jjjjjjjjjjjjjjj....',
        '.....KKKKKKKKKKKKKKK....',
        '...........hhhhhhhh.....',
        '............SShhhhh.....',
        '............SShhhh......',
        '.............hhhh.......'
      ])
    },
    guide: {
      S: G(3, [
        '.........kkkkkk.........',
        '........kjkkkkkK........',
        '........kjkkkkkK........',
        '........aaaaaaaa........',
        '..kkkkkkkkkkkkkkkkkkkK..',
        '...KKKKKKKKKKKKKKKKKK...',
        '....hhhhdhhhhhhdhhhh....',
        '....hhd..........dhh....',
        '....hh............hh....',
        '....h..............h....'
      ]),
      N: G(3, [
        '.........kkkkkk.........',
        '........kjkkkkkK........',
        '........kjkkkkkK........',
        '........aaaaaaaa........',
        '..kkkkkkkkkkkkkkkkkkkK..',
        '...KKKKKKKKKKKKKKKKKK...',
        '....hhhhhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhh....',
        '....hhhhhhhhhhhhhhhh....',
        '.....hhhhhhhhhhhhhh.....',
        '........ssssssss........',
        '.........SSSSSS.........'
      ]),
      W: G(3, [
        '..........kkkkkk........',
        '.........kjkkkkkK.......',
        '.........kjkkkkkK.......',
        '.........aaaaaaaa.......',
        '...kkkkkkkkkkkkkkkkkK...',
        '....KKKKKKKKKKKKKKKK....',
        '.....hhh...hhhhhhhh.....',
        '............hhhhhhh.....',
        '............SShhhh......',
        '.............hhhh.......'
      ])
    }
  };

  // ---- asymmetric details, authored per FINAL facing (never mirrored) ---------------------------
  // Layers: back (before legs), mid (after trunk, before arms), head (after hair, follows the head),
  // top (after head, follows the body). 'side' entries are symmetric: authored for W, mirrored for E.
  var HEADSET_S = D(4, 2, [
    '.....iiiiii.....',
    '...ii......ii...',
    '..i..........i..',
    '.i............i.',
    'i..............i',
    'i..............i',
    'i..............i',
    'i..............i'
  ]);
  var DETAILS = {
    opus: {
      S: { mid: [D(14, 18, ['cc', 'cC', 'cC', 'cC', 'cC', 'CC'])] },
      W: { mid: [D(8, 18, ['cc', 'cC', 'cC', 'cC', 'CC'])] }
    },
    sonnet: {
      S: { mid: [D(14, 20, ['.x', '.x', 'TT'])], head: [D(17, 8, ['aA']),
        D(8, 10, ['.i....i.', 'i.iiii.i', 'i.i..i.i', '.i....i.'])] },
      N: { head: [D(5, 8, ['Aa'])] },
      W: { head: [D(12, 9, ['aA'])] },
      side: { head: [D(6, 10, ['.i....', 'i.iiii', 'i.i...', '.i....'])] }
    },
    haiku: {
      S: { head: [D(5, 8, ['aa'])] },
      N: { head: [D(17, 8, ['aa'])] },
      E: { head: [D(10, 9, ['aa'])] }
    },
    codex: {
      S: { head: [HEADSET_S, D(3, 10, ['ii', 'Ii', 'ii']), D(19, 10, ['ii', 'iI', 'ii']),
        D(14, 13, ['....i', 'Iiii.'])] },
      N: { head: [HEADSET_S, D(3, 10, ['ii', 'ii', 'ii']), D(19, 10, ['ii', 'ii', 'ii']), D(3, 13, ['i'])] },
      W: { head: [D(7, 13, ['....i', 'Iiii.'])] },
      side: { head: [D(13, 2, ['i', 'i', 'i', 'i', 'i', 'i', 'i', 'i']), D(12, 10, ['iii', 'iIi', 'iii'])] }
    },
    unknown: {
      S: { mid: [D(13, 20, ['xxn', 'nnx', 'nxn', 'nnn', 'nxn'])] },
      W: { mid: [D(8, 20, ['nn', 'nx'])] }
    },
    guide: {
      S: { mid: [D(6, 17, [
        '.y........',
        '.Yy.......',
        '..Yy......',
        '...Yy.....',
        '....Yy....',
        '.....Yy...',
        '......Yy..',
        '.......Yy.',
        '........Yy'
      ]), D(16, 25, ['yyyyy', 'yyyyy', 'YYgYY', 'YYYYY'])] },
      N: { mid: [D(7, 17, [
        '.........y',
        '........yY',
        '.......yY.',
        '......yY..',
        '.....yY...',
        '....yY....',
        '...yY.....',
        '..yY......',
        '.yY.......'
      ]), D(3, 25, ['yyyyy', 'yyyyy', 'YYgYY', 'YYYYY'])] },
      W: { mid: [D(9, 18, ['y...', 'Yy..', '.Yy.', '..Yy', '...Y']), D(12, 25, ['yyyyy', 'yyyyy', 'YgYYY', 'YYYYY'])] },
      E: { mid: [D(11, 17, ['yy...', '.Yy..', '..Yy.', '...Yy', '....Y'])] }
    }
  };

  // Department badge (costume) on the character's RIGHT chest: visible from S and E only.
  var BADGE = { S: D(8, 20, ['zz', 'ZZ']), E: D(14, 20, ['zz', 'ZZ']) };
  // Static '?' mark for unknown / offline (top-right headroom, clear of every hairstyle).
  var MARK_UNKNOWN = D(19, 1, ['nnn', '..n', '.nn', '...', '.n.']);

  // ---- styles -----------------------------------------------------------------------------------
  var SKINS = [
    { s: '#f2c49e', S: '#d49a76', b: '#eaa08a', m: '#b8786a' },
    { s: '#e0a87c', S: '#c08060', b: '#d88a70', m: '#9a5e48' },
    { s: '#b27a50', S: '#8a5a38', b: '#b46a4c', m: '#6a4028' },
    { s: '#8a5a3c', S: '#6a4028', b: '#8e4a36', m: '#4a2a1c' }
  ];

  var SHARED = {
    o: '#2a1c22', e: '#2a1c22',
    n: RAMP.paper[4], N: RAMP.paper[1], v: RAMP.red[2], V: RAMP.red[1], x: RAMP.char[1],
    y: RAMP.wood[2], Y: RAMP.wood[1], g: RAMP.ochre[4], i: RAMP.char[1], I: RAMP.stone[5],
    k: RAMP.stone[4], K: RAMP.stone[3], j: RAMP.stone[5]
  };

  var STYLES = {
    opus: {
      label: 'Opus', modelFamily: 'Opus', garment: 'coat', nameplate: '#c47a50',
      silhouette: 'long wavy platinum hair with a centre part, falling past the shoulders',
      outfit: 'belted long terracotta coat with gold buttons and an ochre scarf',
      asymmetry: 'scarf tail hangs over the LEFT shoulder (seen from south and west only)',
      colors: {
        h: RAMP.birch[4], H: '#f4ecd8', d: RAMP.birch[2],
        t: RAMP.terra[4], T: RAMP.terra[3], l: RAMP.terra[5],
        c: RAMP.ochre[4], C: RAMP.ochre[3], a: RAMP.ochre[4], A: RAMP.wood[1],
        r: RAMP.terra[4], R: RAMP.terra[3],
        p: RAMP.slate[2], P: RAMP.slate[1], u: RAMP.slate[2], U: RAMP.slate[1], q: RAMP.slate[2], Q: RAMP.slate[1],
        f: RAMP.wood[1], F: RAMP.wood[0], g: RAMP.ochre[5]
      }
    },
    sonnet: {
      label: 'Sonnet', modelFamily: 'Sonnet', garment: 'cardigan', nameplate: '#5b7a63',
      silhouette: 'rounded navy-black bob with a side-swept fringe and round glasses',
      outfit: 'sage cardigan over a cream shirt, warm grey trousers',
      asymmetry: 'coral hair clip on the LEFT side; pen in the LEFT breast pocket',
      colors: {
        h: RAMP.slate[1], H: RAMP.slate[3], d: RAMP.slate[0],
        t: RAMP.sage[3], T: RAMP.sage[2], l: RAMP.sage[4],
        c: RAMP.plaster[5], C: RAMP.plaster[3], a: RAMP.red[4], A: RAMP.red[3],
        r: RAMP.sage[3], R: RAMP.sage[2],
        p: RAMP.plaster[0], P: '#4e3e32', u: RAMP.plaster[0], U: '#4e3e32', q: RAMP.plaster[0], Q: '#4e3e32',
        f: RAMP.stone[1], F: RAMP.stone[0], g: RAMP.plaster[5], i: RAMP.char[2]
      }
    },
    haiku: {
      label: 'Haiku', modelFamily: 'Haiku', garment: 'jacket', nameplate: '#86b2c4',
      silhouette: 'short spiky orange-red hair with a tall top-knot',
      outfit: 'cropped sky-blue zip jacket, cream tee, khaki shorts, cream socks, red sneakers',
      asymmetry: 'green leaf pin on the RIGHT side of the hair',
      shorts: true,
      colors: {
        h: RAMP.red[4], H: '#e88a5e', d: RAMP.red[3],
        t: RAMP.sky[5], T: '#6a96a8', l: RAMP.sky[4],
        c: RAMP.paper[4], C: RAMP.paper[2], a: RAMP.leaf[5], A: '#4f7486',
        r: RAMP.sky[5], R: '#6a96a8',
        p: RAMP.birch[2], P: RAMP.birch[1], q: RAMP.paper[4], Q: RAMP.paper[2],
        f: RAMP.red[3], F: RAMP.red[2]
      }
    },
    codex: {
      label: 'Codex', modelFamily: 'Codex', garment: 'hoodie', nameplate: '#78a45e',
      silhouette: 'hood up over a dark fringe, wrap-around headset with ear cups',
      outfit: 'slate hoodie with green drawstrings and hem stripe, charcoal joggers, white sneakers',
      asymmetry: 'headset microphone boom on the LEFT side',
      colors: {
        h: RAMP.char[1], H: RAMP.char[3], d: RAMP.char[0],
        k: RAMP.slate[3], K: RAMP.slate[2], j: RAMP.slate[4],
        t: RAMP.slate[3], T: RAMP.slate[2], l: RAMP.slate[4],
        c: RAMP.slate[4], C: RAMP.slate[3], a: RAMP.leaf[6], A: RAMP.leaf[5],
        r: RAMP.slate[3], R: RAMP.slate[2],
        p: RAMP.char[2], P: RAMP.char[1], u: RAMP.char[2], U: RAMP.char[1], q: RAMP.char[2], Q: RAMP.char[1],
        f: RAMP.paper[3], F: RAMP.paper[1], i: RAMP.char[4], I: RAMP.leaf[6]
      }
    },
    unknown: {
      label: 'Unknown', modelFamily: 'Unknown', garment: 'smock', nameplate: '#878c8f',
      silhouette: 'plain grey knit beanie with a folded cuff, cropped hair',
      outfit: 'plain grey smock with a "?" badge, grey trousers',
      asymmetry: '"?" badge on the LEFT chest',
      colors: {
        h: RAMP.stone[2], H: RAMP.stone[3], d: RAMP.stone[1],
        k: RAMP.stone[4], K: RAMP.stone[3], j: RAMP.stone[5],
        t: RAMP.stone[5], T: RAMP.stone[4], l: RAMP.stone[6],
        c: RAMP.stone[3], C: RAMP.stone[2], a: RAMP.stone[4], A: RAMP.stone[3],
        r: RAMP.stone[5], R: RAMP.stone[4],
        p: RAMP.stone[2], P: RAMP.stone[1], u: RAMP.stone[2], U: RAMP.stone[1], q: RAMP.stone[2], Q: RAMP.stone[1],
        f: RAMP.char[2], F: RAMP.char[1]
      }
    },
    guide: {
      label: 'Guide (player)', modelFamily: 'guide', garment: 'vest', nameplate: '#b8903c',
      silhouette: 'wide-brim ochre explorer hat with a red band',
      outfit: 'olive field vest over a cream shirt, red neckerchief, khaki trousers, brown boots',
      asymmetry: 'satchel strap over the RIGHT shoulder, satchel on the LEFT hip',
      colors: {
        h: RAMP.wood[0], H: RAMP.wood[1], d: '#2f1e16',
        k: RAMP.ochre[3], K: RAMP.ochre[2], j: RAMP.ochre[4],
        t: RAMP.olive[3], T: RAMP.olive[2], l: RAMP.olive[4],
        c: RAMP.plaster[5], C: RAMP.plaster[3], a: RAMP.red[3], A: RAMP.red[2],
        r: RAMP.plaster[5], R: RAMP.plaster[3],
        p: RAMP.birch[1], P: RAMP.birch[0], u: RAMP.birch[1], U: RAMP.birch[0], q: RAMP.birch[1], Q: RAMP.birch[0],
        f: RAMP.wood[1], F: RAMP.wood[0]
      }
    }
  };
  var STYLE_ORDER = ['opus', 'sonnet', 'haiku', 'codex', 'unknown', 'guide'];

  var COSTUMES = {
    planning: [RAMP.ochre[4], RAMP.ochre[2]],
    engineering: [RAMP.slate[5], RAMP.slate[3]],
    research: [RAMP.green[4], RAMP.green[2]],
    design: [RAMP.terra[5], RAMP.terra[3]],
    qa: [RAMP.red[4], RAMP.red[2]],
    operations: [RAMP.olive[5], RAMP.olive[3]]
  };

  // ---- animation timelines (frames at FRAME_HZ) -------------------------------------------------
  // Pose fields: legs, arms, eyes ('open'|'closed'|'down'), dy (body bob), hdy (extra head drop),
  // mark (static '?'), desat (desaturate). Working poses exist ONLY in type/read/review.
  function P(legs, arms, eyes, dy, extra) {
    var p = { legs: legs, arms: arms, eyes: eyes, dy: dy || 0, hdy: 0, mark: false, desat: false };
    if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
    return p;
  }
  var ANIMS = {
    idle: {
      phases: [P('stand', 'down', 'open'), P('stand', 'down', 'closed')],
      timeline: [[0, 168], [1, 6], [0, 6]]
    },
    walk: {
      phases: [P('stepA', 'swingA', 'open', 1), P('stand', 'down', 'open'), P('stepB', 'swingB', 'open', 1), P('stand', 'down', 'open')],
      timeline: [[0, 8], [1, 8], [2, 8], [3, 8]]
    },
    type: {
      phases: [P('stand', 'typeA', 'open'), P('stand', 'typeN', 'open'), P('stand', 'typeB', 'open')],
      timeline: [[0, 5], [1, 5], [2, 5], [1, 5]]
    },
    read: {
      phases: [P('stand', 'book0', 'down', 0, { hdy: 1 }), P('stand', 'book1', 'down', 0, { hdy: 1 }), P('stand', 'book2', 'down', 0, { hdy: 1 })],
      timeline: [[0, 150], [1, 6], [2, 6], [0, 18]]
    },
    review: {
      phases: [P('stand', 'clip0', 'down', 0, { hdy: 1 }), P('stand', 'clip1', 'down', 0, { hdy: 1 }), P('stand', 'clip2', 'down', 0, { hdy: 1 })],
      timeline: [[0, 36], [1, 8], [2, 8], [0, 20]]
    },
    wait: {
      phases: [P('stand', 'cross', 'open'), P('tap', 'cross', 'open'), P('stand', 'cross', 'closed')],
      timeline: [[0, 90], [1, 8], [0, 8], [1, 8], [0, 44], [2, 6], [0, 16]]
    },
    unknown: {
      phases: [P('stand', 'down', 'closed', 1, { mark: true, desat: true })],
      timeline: [[0, 1]]
    }
  };
  Object.keys(ANIMS).forEach(function (k) {
    var a = ANIMS[k];
    a.loop = a.timeline.reduce(function (s, seg) { return s + seg[1]; }, 0);
  });

  var ACTION_ALIASES = {
    idle: 'idle', standing: 'idle', completed: 'idle', done: 'idle',
    walk: 'walk', walking: 'walk', move: 'walk', moving: 'walk',
    type: 'type', typing: 'type', coding: 'type', code: 'type', working: 'type', work: 'type',
    read: 'read', reading: 'read',
    review: 'review', reviewing: 'review',
    wait: 'wait', waiting: 'wait', blocked: 'wait',
    unknown: 'unknown', offline: 'unknown', stale: 'unknown'
  };
  var FACING_ALIASES = {
    north: 'N', n: 'N', up: 'N', back: 'N',
    south: 'S', s: 'S', down: 'S', front: 'S',
    east: 'E', e: 'E', right: 'E',
    west: 'W', w: 'W', left: 'W'
  };
  var FACING_NAMES = { N: 'north', E: 'east', S: 'south', W: 'west' };

  // ---- validation (runs once at load). Fails SOFT: problems are listed in TownArt.diagnostics
  //      (tests assert it is empty) instead of throwing, so one bad template row can never take the
  //      whole integrated page down; painting already clips to the frame.
  var SYMBOLS = 'osSbmehHdtTlcCaArRpPuUqQfFkKjgiInNvVxyYzZ';
  var diagnostics = [];
  function problem(msg) { if (diagnostics.length < 50) diagnostics.push(msg); }
  function checkLayer(name, L) {
    L.rows.forEach(function (row, i) {
      if (L.full && row.length !== W) problem('template ' + name + ' row ' + i + ' has width ' + row.length + ' (expected ' + W + ')');
      if (L.x0 + row.length > W || L.y0 + i >= H) problem('template ' + name + ' row ' + i + ' falls outside the frame');
      for (var x = 0; x < row.length; x++) {
        var ch = row[x];
        if (ch !== '.' && ch !== '_' && SYMBOLS.indexOf(ch) < 0) problem('template ' + name + ' row ' + i + ' uses unknown symbol "' + ch + '"');
      }
    });
  }
  function walk(name, v) {
    if (!v) return;
    if (v.rows) { checkLayer(name, v); return; }
    if (Array.isArray(v)) { v.forEach(function (x, i) { walk(name + '[' + i + ']', x); }); return; }
    if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(name + '.' + k, v[k]); });
  }
  walk('FACE', FACE); walk('LEGS', LEGS); walk('ARMS', ARMS); walk('GARMENT', GARMENT);
  walk('HAIR', HAIR); walk('DETAILS', DETAILS); walk('BADGE', BADGE); walk('MARK', MARK_UNKNOWN);
  STYLE_ORDER.forEach(function (k) {
    var st = STYLES[k];
    ['S', 'N', 'W'].forEach(function (d) {
      if (!GARMENT[st.garment] || !GARMENT[st.garment][d] || !HAIR[k] || !HAIR[k][d]) problem('style ' + k + ' lacks facing ' + d);
    });
  });
  ['front', 'back', 'side'].forEach(function (v) {
    Object.keys(ANIMS).forEach(function (a) {
      ANIMS[a].phases.forEach(function (p) {
        if (!ARMS[v][p.arms]) problem('arms "' + p.arms + '" missing for view ' + v);
        if (!LEGS[v === 'side' ? 'side' : 'front'][p.legs]) problem('legs "' + p.legs + '" missing for view ' + v);
      });
    });
  });

  // ---- palettes ---------------------------------------------------------------------------------
  var paletteCache = {};
  function palette(style, skin, costume) {
    var key = style + '|' + skin + '|' + costume;
    if (paletteCache[key]) return paletteCache[key];
    var st = STYLES[style], src = {}, k;
    for (k in SHARED) src[k] = SHARED[k];
    var sk = SKINS[skin];
    for (k in sk) src[k] = sk[k];
    for (k in st.colors) src[k] = st.colors[k];
    if (st.shorts) { src.u = sk.s; src.U = sk.S; }
    if (costume && COSTUMES[costume]) { src.z = COSTUMES[costume][0]; src.Z = COSTUMES[costume][1]; }
    var pal = {};
    for (k in src) pal[k] = pack(rgb(src[k]));
    paletteCache[key] = pal;
    return pal;
  }

  // ---- compositor -------------------------------------------------------------------------------
  function paint(buf, L, pal, mirror, dy, eyes) {
    var rows = L.rows;
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j], y = L.y0 + j + dy;
      if (y < 0 || y >= H) continue;
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (ch === '.') continue;
        var x = L.x0 + i;
        if (mirror) x = W - 1 - x;
        if (x < 0 || x >= W) continue;
        var idx = y * W + x;
        if (ch === '_') { buf[idx] = 0; continue; }
        if (ch === 'e' && eyes && eyes !== 'open') {
          var top = j + 1 < rows.length && rows[j + 1][i] === 'e';
          ch = top ? 's' : (eyes === 'closed' ? 'm' : 'e');
        }
        var c = pal[ch];
        if (c === undefined) { problem('no colour for symbol "' + ch + '"'); c = pal.o; }
        buf[idx] = c;
      }
    }
  }
  function paintAll(buf, list, pal, mirror, dy, eyes) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) paint(buf, list[i], pal, mirror, dy, eyes);
  }

  // 1px 4-neighbour outline grown into transparent pixels (also fills 1-2px gaps such as the
  // space between the legs or between arm and trunk, which gives the dark separating line).
  function outline(buf, w, h, color) {
    var out = buf.slice();
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = y * w + x;
      if (buf[i] !== 0) continue;
      if ((x > 0 && buf[i - 1]) || (x < w - 1 && buf[i + 1]) || (y > 0 && buf[i - w]) || (y < h - 1 && buf[i + w])) out[i] = color;
    }
    return out;
  }

  var DESAT_TINT = rgb('#8a8580');
  function desaturate(buf) {
    for (var i = 0; i < buf.length; i++) {
      if (!buf[i]) continue;
      var c = unpack(buf[i]);
      var lum = Math.round(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);
      var grey = mix([lum, lum, lum], DESAT_TINT, 0.25);
      buf[i] = pack(mix(mix(c, grey, 0.8), [40, 34, 36], 0.12));
    }
  }

  function composeCharacter(style, skin, costume, dir, pose) {
    var st = STYLES[style];
    var pal = palette(style, skin, costume);
    var buf = new Uint32Array(W * H);
    var view = dir === 'S' ? 'front' : dir === 'N' ? 'back' : 'side';
    var mirror = dir === 'E';
    var base = dir === 'E' ? 'W' : dir;
    var dy = pose.dy, hdy = pose.dy + pose.hdy;
    var det = DETAILS[style] || {};
    var mine = det[dir] || {};
    var sym = view === 'side' ? (det.side || {}) : {};
    var legs = LEGS[view === 'side' ? 'side' : 'front'][pose.legs];

    paintAll(buf, mine.back, pal, false, dy);
    if (view === 'side') paintAll(buf, ARMS.sideFar[pose.arms], pal, mirror, dy);
    paint(buf, legs, pal, mirror, 0);
    paint(buf, GARMENT[st.garment][base], pal, mirror, dy);
    paintAll(buf, sym.mid, pal, mirror, dy);
    paintAll(buf, mine.mid, pal, false, dy);
    paintAll(buf, ARMS[view][pose.arms], pal, mirror, dy);
    if (FACE[base]) paint(buf, FACE[base], pal, mirror, hdy, pose.eyes);
    paint(buf, HAIR[style][base], pal, mirror, hdy);
    paintAll(buf, sym.head, pal, mirror, hdy);
    paintAll(buf, mine.head, pal, false, hdy);
    paintAll(buf, sym.top, pal, mirror, dy);
    paintAll(buf, mine.top, pal, false, dy);
    if (costume && BADGE[dir]) paint(buf, BADGE[dir], pal, false, dy);
    if (pose.mark) paint(buf, MARK_UNKNOWN, pal, false, 0);
    var out = outline(buf, W, H, pal.o);
    if (pose.desat) desaturate(out);
    return out;
  }

  function toRGBA(buf) {
    var rgba = new Uint8ClampedArray(buf.length * 4);
    for (var i = 0; i < buf.length; i++) {
      var p = buf[i];
      if (!p) continue;
      rgba[i * 4] = (p >>> 16) & 255;
      rgba[i * 4 + 1] = (p >>> 8) & 255;
      rgba[i * 4 + 2] = p & 255;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  // ---- request resolution -----------------------------------------------------------------------
  function hashString(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function own(table, key) { return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined; }

  function resolveStyle(modelFamily, id) {
    var fam = str(modelFamily).toLowerCase();
    if (str(id) === 'guide' || fam === 'guide' || fam === 'player' || fam === 'avatar') return 'guide';
    if (fam.indexOf('opus') >= 0) return 'opus';
    if (fam.indexOf('sonnet') >= 0) return 'sonnet';
    if (fam.indexOf('haiku') >= 0) return 'haiku';
    if (fam.indexOf('codex') >= 0) return 'codex';
    return 'unknown';
  }
  function resolveFacing(f) { return own(FACING_ALIASES, str(f).toLowerCase()) || 'S'; }
  // Unrecognised actions fall back to 'idle' — never to a working pose.
  function resolveAction(a) { return own(ACTION_ALIASES, str(a).toLowerCase()) || 'idle'; }
  function resolveCostume(c) { var k = str(c).toLowerCase(); return own(COSTUMES, k) ? k : ''; }
  function resolveFrame(frame, loop) {
    var f = Number(frame);
    if (!isFinite(f)) f = 0;
    f = Math.floor(f) % loop;
    return f < 0 ? f + loop : f;
  }
  function phaseAt(anim, frame) {
    var f = resolveFrame(frame, anim.loop);
    for (var i = 0; i < anim.timeline.length; i++) {
      if (f < anim.timeline[i][1]) return anim.timeline[i][0];
      f -= anim.timeline[i][1];
    }
    return anim.timeline[0][0];
  }

  function resolve(req) {
    req = req || {};
    var style = resolveStyle(req.modelFamily, req.id);
    var action = resolveAction(req.action);
    var id = str(req.id);
    return {
      style: style,
      facing: FACING_NAMES[resolveFacing(req.facing)],
      action: action,
      phase: phaseAt(ANIMS[action], req.frame),
      skin: id ? hashString(id) % SKINS.length : 0,
      costume: resolveCostume(req.costume)
    };
  }
  function keyOf(r) { return [r.style, r.skin, r.costume || '-', r.facing, r.action, r.phase].join('|'); }

  var cache = new Map(), CACHE_MAX = 4096;
  function sprite(rgba) {
    var out = { width: W, height: H, rgba: rgba, pivotX: PIVOT_X, pivotY: PIVOT_Y };
    if (out.rgba.length !== out.width * out.height * 4) throw new Error('TownArt: sprite buffer size mismatch');
    return out;
  }

  function getSprite(req) {
    var r = resolve(req);
    var key = keyOf(r);
    var master = cache.get(key);
    if (!master) {
      try {
        master = toRGBA(composeCharacter(r.style, r.skin, r.costume, resolveFacing(r.facing), ANIMS[r.action].phases[r.phase]));
      } catch (err) {
        // Never take the caller's render loop down: record it and fall back to a transparent frame.
        problem('compose failed for ' + key + ': ' + (err && err.message));
        master = new Uint8ClampedArray(W * H * 4);
      }
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(key, master);
    }
    return sprite(master.slice());
  }

  function getAnimation(action) {
    var name = resolveAction(action), a = ANIMS[name];
    return {
      action: name,
      frameHz: FRAME_HZ,
      loopFrames: a.loop,
      phaseCount: a.phases.length,
      isStatic: a.phases.length === 1,
      depictsWork: name === 'type' || name === 'read' || name === 'review',
      timeline: a.timeline.map(function (s) { return { phase: s[0], frames: s[1] }; })
    };
  }

  function listStyles() {
    return STYLE_ORDER.map(function (k) {
      var s = STYLES[k];
      return {
        id: k, modelFamily: s.modelFamily, label: s.label, nameplate: s.nameplate,
        silhouette: s.silhouette, outfit: s.outfit, asymmetry: s.asymmetry,
        request: k === 'guide' ? { id: 'guide', modelFamily: 'guide' } : { modelFamily: s.modelFamily }
      };
    });
  }

  // ---- town props (additive; original shapes in the V2.2 palette) ------------------------------
  // Same sprite shape and pivot convention as characters: (pivotX, pivotY) = bottom-centre ground
  // contact in edge coordinates; the lowest opaque row is pivotY - 1. Static (frame is ignored).
  function hash2(x, y, s) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((s | 0) + 1, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function C(ramp, i) { return pack(rgb(RAMP[ramp][i])); }
  function prect(c, x0, y0, w, h, col) {
    for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) {
      if (x >= 0 && y >= 0 && x < c.w && y < c.h) c.buf[y * c.w + x] = col;
    }
  }
  function pdisc(c, cx, cy, rx, ry, fn) {
    for (var y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (x < 1 || y < 1 || x >= c.w - 1 || y >= c.h - 1) continue;
      var dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) c.buf[y * c.w + x] = fn(dx, dy, x, y);
    }
  }
  function leaves(seed) {
    return function (dx, dy, x, y) {
      var lit = -dx * 0.55 - dy * 0.85 + (hash2(x, y, seed) - 0.5) * 0.45;
      return C('leaf', lit > 0.6 ? 6 : lit > 0.15 ? 5 : lit > -0.35 ? 4 : 3);
    };
  }
  var PROPS = {
    bench: {
      label: 'wooden slatted bench', w: 28, h: 18, footprintUnits: { w: 1.6, d: 0.5 },
      draw: function (c) {
        prect(c, 4, 2, 1, 9, C('char', 2)); prect(c, 23, 2, 1, 9, C('char', 2));
        prect(c, 2, 2, 24, 2, C('wood', 4)); prect(c, 2, 2, 24, 1, C('wood', 5));
        prect(c, 2, 5, 24, 2, C('wood', 3)); prect(c, 2, 5, 24, 1, C('wood', 4));
        prect(c, 1, 9, 26, 1, C('wood', 5)); prect(c, 1, 10, 26, 1, C('wood', 4)); prect(c, 1, 11, 26, 1, C('wood', 2));
        prect(c, 6, 12, 1, 3, C('char', 1)); prect(c, 21, 12, 1, 3, C('char', 1));
        prect(c, 3, 12, 2, 5, C('char', 3)); prect(c, 4, 12, 1, 5, C('char', 2));
        prect(c, 23, 12, 2, 5, C('char', 3)); prect(c, 24, 12, 1, 5, C('char', 2));
      }
    },
    streetlamp: {
      label: 'iron street lamp', w: 12, h: 52, footprintUnits: { w: 0.4, d: 0.4 },
      draw: function (c) {
        prect(c, 5, 1, 2, 2, C('char', 3)); prect(c, 3, 3, 6, 1, C('char', 3)); prect(c, 2, 4, 8, 2, C('char', 2));
        prect(c, 2, 6, 1, 5, C('char', 2)); prect(c, 9, 6, 1, 5, C('char', 2));
        prect(c, 3, 6, 6, 5, C('glow', 1)); prect(c, 3, 6, 1, 5, C('glow', 2)); prect(c, 8, 6, 1, 5, C('glow', 0));
        prect(c, 3, 11, 6, 1, C('char', 2)); prect(c, 4, 12, 4, 1, C('char', 3));
        prect(c, 5, 13, 2, 34, C('char', 3)); prect(c, 5, 13, 1, 34, C('char', 4)); prect(c, 4, 40, 4, 1, C('char', 4));
        prect(c, 3, 47, 6, 4, C('char', 3)); prect(c, 3, 47, 6, 1, C('char', 4)); prect(c, 8, 47, 1, 4, C('char', 2));
      }
    },
    planter: {
      label: 'terracotta planter with shrub', w: 24, h: 26, footprintUnits: { w: 1.3, d: 0.8 },
      draw: function (c) {
        pdisc(c, 12, 10, 10, 6.5, leaves(3)); pdisc(c, 7, 12, 5, 4, leaves(5)); pdisc(c, 17, 12, 5, 4, leaves(7));
        pdisc(c, 12, 6, 6, 4.5, leaves(9));
        [[8, 7], [15, 6], [12, 11], [5, 11], [18, 10]].forEach(function (p, i) {
          prect(c, p[0], p[1], 1, 1, i % 2 ? C('ochre', 5) : C('red', 4));
        });
        prect(c, 2, 15, 20, 1, C('wood', 0));
        prect(c, 1, 16, 22, 1, C('terra', 5)); prect(c, 1, 17, 22, 1, C('terra', 4));
        prect(c, 2, 18, 20, 7, C('terra', 3)); prect(c, 19, 18, 3, 7, C('terra', 2));
        [6, 11, 16].forEach(function (x) { prect(c, x, 19, 1, 5, C('terra', 2)); });
        prect(c, 2, 24, 20, 1, C('terra', 2));
      }
    },
    tree: {
      label: 'round street tree', w: 34, h: 50, footprintUnits: { w: 0.6, d: 0.6 },
      draw: function (c) {
        prect(c, 15, 28, 4, 19, C('wood', 2)); prect(c, 15, 28, 1, 19, C('wood', 3)); prect(c, 18, 28, 1, 19, C('wood', 1));
        prect(c, 14, 46, 6, 1, C('wood', 2)); prect(c, 13, 47, 8, 2, C('wood', 1));
        [[17, 16, 13, 11, 11], [9, 20, 7, 6.5, 12], [25, 20, 7, 6.5, 13], [17, 8, 8, 6.5, 14],
          [11, 11, 6, 5.5, 15], [23, 11, 6, 5.5, 16], [17, 25, 9, 5, 17]].forEach(function (d) {
          pdisc(c, d[0], d[1], d[2], d[3], leaves(d[4]));
        });
      }
    },
    bollard: {
      label: 'stone bollard', w: 8, h: 14, footprintUnits: { w: 0.3, d: 0.3 },
      draw: function (c) {
        prect(c, 2, 3, 4, 10, C('stone', 4)); prect(c, 2, 3, 1, 10, C('stone', 5)); prect(c, 5, 3, 1, 10, C('stone', 3));
        prect(c, 1, 1, 6, 2, C('stone', 5)); prect(c, 1, 2, 6, 1, C('stone', 4)); prect(c, 2, 6, 4, 1, C('ochre', 4));
      }
    }
  };
  var PROP_ORDER = ['bench', 'streetlamp', 'planter', 'tree', 'bollard'];
  var propCache = {};
  function getProp(req) {
    var kind = typeof req === 'string' ? req : str(req && (req.kind || req.id)).toLowerCase();
    var def = own(PROPS, kind);
    if (!def) return null;
    if (!propCache[kind]) {
      var c = { w: def.w, h: def.h, buf: new Uint32Array(def.w * def.h) };
      def.draw(c);
      propCache[kind] = toRGBA(outline(c.buf, def.w, def.h, pack(rgb(SHARED.o))));
    }
    var out = { width: def.w, height: def.h, rgba: propCache[kind].slice(), pivotX: def.w >> 1, pivotY: def.h };
    if (out.rgba.length !== out.width * out.height * 4) throw new Error('TownArt: prop buffer size mismatch');
    return out;
  }
  function listProps() {
    return PROP_ORDER.map(function (k) {
      var d = PROPS[k];
      return { kind: k, label: d.label, width: d.w, height: d.h, pivotX: d.w >> 1, pivotY: d.h,
        footprintUnits: { w: d.footprintUnits.w, d: d.footprintUnits.d } };
    });
  }

  var TownArt = {
    version: 'm1',
    getSprite: getSprite,
    listStyles: listStyles,
    // additive helpers
    metrics: {
      frameWidth: W, frameHeight: H, pivotX: PIVOT_X, pivotY: PIVOT_Y, pivot: 'edge: bottom of soles, centred between feet',
      lowestOpaqueRow: H - 1, figureHeightPx: 38, recommendedPxPerUnit: 16, figureHeightUnits: 38 / 16,
      footprintUnits: { w: 0.6, d: 0.4 }, nativeScene: { width: 480, height: 270 }, frameHz: FRAME_HZ,
      facings: ['north', 'east', 'south', 'west'], actions: Object.keys(ANIMS)
    },
    getAnimation: getAnimation,
    resolve: resolve,
    spriteKey: function (req) { return keyOf(resolve(req)); },
    listProps: listProps,
    getProp: getProp,
    diagnostics: diagnostics
  };

  root.TownArt = TownArt;
})(__root);   // agent-city: was (typeof window !== 'undefined' ? window : globalThis)
export const TownArt = __root.TownArt;   // agent-city: module export (PROVENANCE.md)

