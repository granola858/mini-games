// 貓咪跳箱（cat-agility）測試。
//
// 遊戲是單一 IIFE、一載入就碰 canvas 與 localStorage，沒有可以 require 的純邏輯核心。
// 所以這裡用 vm 把真正的 cat-agility.js 跑在一個假 DOM 裡：
//   - requestAnimationFrame 與 performance.now 都由測試掌控，物理以固定 60 步／秒推進，
//     同樣的輸入必然得到同樣的結果
//   - Math.random 固定，柱子空隙的位置可預測
//   - 2D context 是記錄 fillText 的 Proxy，用來驗證畫面文字的位置；主畫布另外記錄
//     drawImage、translate 與 imageSmoothingEnabled／filter 的寫入，用來驗證像素管線；
//     需要時離屏畫布（像素緩衝區、殘影圖層）也能逐筆記錄 fillRect 與 drawImage，驗證實際畫了什麼
//   - BoboAudio 可選擇注入假的版本，只記錄 Sound 呼叫了哪些合成原語
// 狀態只透過 window.CatAgility.snapshot() 與 localStorage 觀察，不碰內部變數。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const gameDir = path.join(projectRoot, 'games', 'cat-agility');
const JS_PATH = path.join(gameDir, 'cat-agility.js');
const HTML_PATH = path.join(gameDir, 'index.html');
const CSS_PATH = path.join(gameDir, 'cat-agility.css');
const source = fs.readFileSync(JS_PATH, 'utf8');

const KEYS = Object.freeze({
  stats: 'cat-agility_stats_v1',
  state: 'cat-agility_state_v1',
  pref: 'cat-agility_pref_v1'
});
const STEP_MS = 1000 / 60;
// 測試時鐘每幀多走一點點：剛好加 STEP_MS 時，浮點誤差會讓偶爾一幀跑 0 步、下一幀補 2 步，
// 逐步驗證（例如無敵剛好 180 步）就對不準；多 1e-6ms 要累積上千萬幀才會多出一步
const TICK_MS = STEP_MS + 1e-6;
// 與 cat-agility.js 的常數對齊：地板 y = 640 - 60，貓半徑 14，天花板 16
const GROUND_REST_Y = 580 - 14;
const CEILING_Y = 16;

// ---------------------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------------------
class FakeElement {
  constructor(id, tag = 'div') {
    this.id = id;
    this.tag = tag;
    this.listeners = {};
    this.attrs = {};
    this.hidden = false;
    this.textContent = '';
    this.title = '';
    this.blurCount = 0;
    this.child = null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener() {}

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  // 按鈕裡的文字 span：同一個元素固定回傳同一個物件，才驗得到 JS 寫進去的文字
  querySelector() {
    if (!this.child) this.child = { textContent: '' };
    return this.child;
  }

  closest(selector) {
    return selector.split(',').map(s => s.trim()).includes(this.tag) ? this : null;
  }

  blur() {
    this.blurCount += 1;
  }
}

function createStorage(initial = {}, { broken = false } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new Error('SecurityError: localStorage 被封鎖');
  };
  return {
    data,
    getItem(key) {
      guard();
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      guard();
      data.set(key, String(value));
    },
    removeItem(key) {
      guard();
      data.delete(key);
    }
  };
}

// 沒記錄的繪圖方法一律回傳同一個空函式：像素主題每幀有上百次 fillRect，不必每次都配置新閉包
const noop = () => {};

// ops（選填）：依序記錄 drawImage、translate 呼叫與 imageSmoothingEnabled／filter 的每一次寫入
// draws（選填，離屏畫布用）：依序記錄 fillRect（連同當下的 fillStyle 與 globalAlpha）與 drawImage，
// 用來驗證像素緩衝區裡實際畫了什麼；只在需要的測試打開，平常不配置
// paths（選填，主畫布用）：依序記錄 rect(...) 與 fill()（連同當下的 fillStyle），驗證經典主題向量圖形的填色
function createContext2d(texts, ops = null, draws = null, paths = null) {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (key === 'fillText') return (text, x, y) => texts.push({ text: String(text), x, y });
      if (paths && key === 'rect') return (...args) => paths.push({ op: 'rect', args });
      if (paths && key === 'fill') return () => paths.push({ op: 'fill', color: target.fillStyle });
      if (ops && key === 'drawImage') return (img, ...args) => ops.push({ op: 'drawImage', img, args });
      if (ops && key === 'translate') return (...args) => ops.push({ op: 'translate', args });
      if (ops && key === 'scale') return (...args) => ops.push({ op: 'scale', args });
      if (ops && key === 'rotate') return (...args) => ops.push({ op: 'rotate', args });
      if (draws && key === 'fillRect') {
        return (x, y, w, h) => draws.push({
          op: 'fillRect', x, y, w, h, color: target.fillStyle, alpha: target.globalAlpha === undefined ? 1 : target.globalAlpha
        });
      }
      if (draws && key === 'drawImage') {
        return (img, ...args) => draws.push({ op: 'drawImage', img, args, alpha: target.globalAlpha === undefined ? 1 : target.globalAlpha });
      }
      return noop;
    },
    // 跟真的瀏覽器一樣回報有 filter 屬性，功能偵測（'filter' in ctx）才看得到它
    has(target, key) {
      return key === 'filter' || key in target;
    },
    set(target, key, value) {
      if (ops && (key === 'imageSmoothingEnabled' || key === 'filter')) {
        ops.push({ op: key === 'filter' ? 'filter' : 'smoothing', value });
      }
      target[key] = value;
      return true;
    }
  });
}

// 假的 BoboAudio：create() 回傳的 kit 只記錄呼叫了哪個合成原語與參數，不真的發聲
function createFakeAudio() {
  const calls = [];
  const record = kind => (...args) => {
    calls.push({ kind, args });
    return 1;
  };
  const kit = {
    enabled: true,
    tone: record('tone'),
    sweep: record('sweep'),
    chord: record('chord'),
    noise: record('noise'),
    context: () => null,
    destination: () => null,
    toggle() {
      kit.enabled = !kit.enabled;
      return kit.enabled;
    }
  };
  return { calls, api: { create: () => kit } };
}

// offscreen: false 模擬沒有 document.createElement 的環境（建不出像素緩衝區）
// draws: true 讓每張離屏畫布記錄自己的 fillRect／drawImage（layer.draws，每幀清空）
// reduceMotion: true 模擬使用者開啟「減少動態」（prefers-reduced-motion: reduce）
// paths: true 讓主畫布記錄 rect／fill（game.paths，每幀清空）
function boot({ storage = createStorage(), random = () => 0.5, audio = false, offscreen = true, draws = false, reduceMotion = false, paths = false } = {}) {
  let clock = 1000;
  let frame = null;
  const texts = [];
  const ops = [];
  const pathOps = paths ? [] : null;
  const timers = [];
  const fakeAudio = audio ? createFakeAudio() : null;

  const canvas = new FakeElement('game-canvas', 'canvas');
  canvas.width = 0;
  canvas.height = 0;
  canvas.getContext = () => createContext2d(texts, ops, null, pathOps);
  canvas.getBoundingClientRect = () => ({ width: 360, height: 640 });
  const soundBtn = new FakeElement('sound-btn', 'button');
  const styleBtn = new FakeElement('style-btn', 'button');
  const status = new FakeElement('game-status', 'p');
  const stage = new FakeElement('stage', 'main');
  const elements = { 'game-canvas': canvas, 'sound-btn': soundBtn, 'style-btn': styleBtn, 'game-status': status, stage };

  // 離屏畫布（像素緩衝區、殘影圖層）：一樣回傳記錄用的 Proxy，文字另外記，不混進主畫布的 fillText
  const layerTexts = [];
  const layers = [];
  const doc = new FakeElement('document');
  doc.visibilityState = 'visible';
  doc.body = new FakeElement('body', 'body');
  doc.documentElement = { dataset: {} };
  doc.getElementById = id => elements[id] || null;
  if (offscreen) {
    doc.createElement = (tag) => {
      const el = new FakeElement('', tag);
      el.width = 0;
      el.height = 0;
      el.draws = draws ? [] : null;
      el.getContext = () => createContext2d(layerTexts, null, el.draws);
      layers.push(el);
      return el;
    };
  }

  const win = new FakeElement('window');
  win.devicePixelRatio = 1;
  win.matchMedia = (query) => ({ matches: reduceMotion && /prefers-reduced-motion:\s*reduce/.test(query), addEventListener() {} });

  const sandbox = {
    window: win,
    document: doc,
    localStorage: storage,
    Element: FakeElement,
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => {
      frame = fn;
      return 1;
    },
    // 計時一律是模擬步數：這兩個只記錄有沒有被呼叫，不會真的排程
    setTimeout: (...args) => timers.push({ kind: 'timeout', args }),
    setInterval: (...args) => timers.push({ kind: 'interval', args }),
    __random: random
  };
  if (fakeAudio) sandbox.BoboAudio = fakeAudio.api;
  vm.createContext(sandbox);
  vm.runInContext('Math.random = () => __random();', sandbox);
  // 遊戲原始碼包一層函式、把 Math 當參數傳進去：vm 裡每次查全域 Math 都要走 contextified global 的攔截器
  // （一次約 0.1～0.3µs），像素主題每幀上千次 Math.round 會讓整個檔案慢 4 倍；參數是同一個 Math 物件，
  // 上面固定的 Math.random 照樣生效。包裝寫在同一行，錯誤堆疊的行號不變
  vm.runInContext('(function (Math) {' + source + '\n})(Math);', sandbox, { filename: 'cat-agility.js' });

  const fire = (target, type, init = {}) => {
    const event = {
      type,
      target: doc.body,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init
    };
    (target.listeners[type] || []).forEach(fn => fn(event));
    return event;
  };

  // 快照是 vm 裡建立的物件，原型屬於另一個 realm；複製成本地物件，deepStrictEqual 才比得了
  const snap = () => structuredClone(win.CatAgility.snapshot());

  // 推進一個畫面（剛好一步物理；開機那一幀只記錄時間基準）；回傳這一幀畫出來的文字，
  // 主畫布的 drawImage／平滑設定留在 game.ops
  const tick = () => {
    clock += TICK_MS;
    const fn = frame;
    frame = null;
    texts.length = 0;
    layerTexts.length = 0;
    ops.length = 0;
    if (pathOps) pathOps.length = 0;
    for (const layer of layers) if (layer.draws) layer.draws.length = 0;
    fn(clock);
    return texts.slice();
  };

  const game = {
    snap,
    // 未複製的原始快照：驗證遊戲每次都回傳新物件
    rawSnap: () => win.CatAgility.snapshot(),
    storage,
    status,
    soundBtn,
    styleBtn,
    stage,
    layers,
    layerTexts,
    ops,
    paths: pathOps,
    timers,
    audio: fakeAudio ? fakeAudio.calls : null,
    tick,
    advance(ms) {
      const end = clock + ms;
      while (clock < end) tick();
    },
    runUntil(predicate, maxMs) {
      const end = clock + maxMs;
      while (clock < end) {
        tick();
        if (predicate(snap())) return true;
      }
      return false;
    },
    // 最陽春的自動駕駛：掉到目標高度以下就蹬一下
    fly(ms, below) {
      const end = clock + ms;
      while (clock < end && snap().state === 'PLAYING') {
        if (snap().catY > below) game.key('Space');
        tick();
      }
    },
    // 推進一步；給了 below 就先照自動駕駛的規則決定要不要蹬（貓低於 below 才蹬）
    step(below) {
      if (below !== undefined && snap().state === 'PLAYING' && snap().catY > below) game.key('Space');
      tick();
      return snap();
    },
    key: (code, extra = {}) => fire(win, 'keydown', { code, ...extra }),
    tap: (extra = {}) => fire(canvas, 'pointerdown', { pointerType: 'touch', button: 0, ...extra }),
    // detail > 0 是滑鼠／觸控點擊，0 是鍵盤（Enter／空白鍵）觸發的 click
    click: (el, detail = 1) => fire(el, 'click', { detail }),
    hide() {
      doc.visibilityState = 'hidden';
      fire(doc, 'visibilitychange');
    },
    show() {
      doc.visibilityState = 'visible';
      fire(doc, 'visibilitychange');
    },
    pagehide: () => fire(win, 'pagehide'),
    readJson: key => JSON.parse(storage.data.get(key) || 'null')
  };
  game.tick(); // 第一幀只記錄時間基準，不推進物理
  return game;
}

const validSave = (overrides = {}) => ({
  v: 1,
  score: 5,
  scroll: 120,
  spawnTimer: 10,
  cat: { y: 280, vy: 0, rot: 0 },
  pipes: [{ x: 220, gapY: 300, passed: false }],
  ...overrides
});

const storageWithSave = save => createStorage({ [KEYS.state]: JSON.stringify(save) });

// ---------------------------------------------------------------------------
// 主題、道具與無敵衝刺用的輔助工具
// ---------------------------------------------------------------------------
// 與 cat-agility.js 的契約常數對齊
const PIPE_HALF_W = 32; // 道具 x = 障礙物 x + PIPE.width / 2
const PIPE_SPEED = 2.2;
const SPAWN_SPACING = 220; // PIPE.speed × PIPE.spawnEvery：任何速度下障礙物間距都要維持這個值
const FRENZY_STEPS = 180; // 3000ms
const FRENZY_SPEED = 1.6;
const TRAIL_LEN = 10;
const ITEM_KINDS = Object.freeze(['can', 'grass']);
const VARIANT_NAMES = Object.freeze(['post', 'drawer', 'plant']);
const BUFFER_SIZE = Object.freeze({ width: 180, height: 320 });

// 可重現的亂數序列（mulberry32）：兩局要逐步比對時，序列必須相同又不能是常數
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 從指定存檔開機（開機即為 PAUSED，續玩時會先蹬一下）；pref 會一併寫進偏好 key
function bootSave(save, { pref, ...opts } = {}) {
  const initial = { [KEYS.state]: JSON.stringify(save) };
  if (pref) initial[KEYS.pref] = JSON.stringify(pref);
  return boot({ ...opts, storage: createStorage(initial) });
}

const bootPref = (pref, opts = {}) => boot({ ...opts, storage: createStorage({ [KEYS.pref]: JSON.stringify(pref) }) });

// 罐頭就在貓的正前方：續玩的第一步就吃到，之後的步數都從這一步算起；
// 貓放在縫隙中心偏下 20px，續玩那一蹬（約升 61px）才不會頂到上半截
function bootPickup(opts = {}) {
  const game = bootSave(validSave({
    score: 3,
    passCount: 3,
    spawnTimer: 0,
    cat: { y: 335, vy: 0, rot: 0 },
    pipes: [{ x: 68, gapY: 315, passed: false, variant: 'post', item: 'can' }]
  }), opts);
  assert.equal(game.snap().items.length, 1);
  assert.equal(game.snap().invincible, false);
  game.key('ArrowUp');
  game.tick();
  assert.equal(game.snap().invincible, true, '續玩第一步就應該吃到罐頭');
  return game;
}

// 里程碑那一步：新道具必須掛在「生成順序中第一個還沒通過、原本也沒有道具」的障礙物上，位置是縫隙正中央
function assertMilestoneItem(before, after, label) {
  assert.equal(after.obstacles.length, before.obstacles.length, `${label}：這一步不該剛好有障礙物生成或移除`);
  const expected = after.obstacles.findIndex((o, i) => !o.passed && !before.obstacles[i].item);
  assert.ok(expected >= 0, `${label}：找不到下一組還沒通過的障礙物`);
  after.obstacles.forEach((o, i) => {
    const gained = o.item !== null && before.obstacles[i].item === null;
    assert.equal(gained, i === expected, `${label}：第 ${i} 組障礙物${gained ? '不該' : '應該'}拿到這次的道具`);
  });
  const holder = after.obstacles[expected];
  assert.ok(ITEM_KINDS.includes(holder.item), `${label}：道具種類 ${holder.item} 不合法`);
  assert.equal(after.items.length, before.items.length + 1, `${label}：一個里程碑只能多一顆道具`);
  assert.ok(
    after.items.some(it => it.kind === holder.item && it.x === holder.x + PIPE_HALF_W && it.y === holder.gapY),
    `${label}：道具不在縫隙正中央 ${JSON.stringify(after.items)} vs ${JSON.stringify(holder)}`
  );
  return holder;
}

// 目前要鑽的縫隙：第一個還沒完全離開貓（貓左緣 x = 86）的障礙物；沒有就守在畫面中段
function nextGap(s) {
  const next = s.obstacles.find(o => o.x + PIPE_HALF_W * 2 > 86);
  return next ? next.gapY : 315;
}

const pixelBufferOf = game => game.layers.find(l => l.width === BUFFER_SIZE.width && l.height === BUFFER_SIZE.height);
const bufferBlits = game => {
  const buffer = pixelBufferOf(game);
  return game.ops.filter(op => op.op === 'drawImage' && buffer && op.img === buffer);
};

// 像素主題的每一幀：先把主畫布的平滑關掉，再把 180×320 緩衝區放大貼滿 360×640 的虛擬畫面，而且只貼一次
function assertPixelFrame(game, label) {
  const buffer = pixelBufferOf(game);
  assert.ok(buffer, '像素主題要有 180×320 的離屏緩衝區');
  const blitAt = game.ops.findIndex(op => op.op === 'drawImage' && op.img === buffer);
  assert.ok(blitAt >= 0, `${label}：這一幀沒有把像素緩衝區貼到主畫布`);
  assert.equal(bufferBlits(game).length, 1, `${label}：緩衝區一幀只該貼一次`);
  const smoothing = game.ops.slice(0, blitAt).filter(op => op.op === 'smoothing');
  assert.ok(smoothing.length > 0, `${label}：這一幀沒有設定 imageSmoothingEnabled`);
  assert.equal(smoothing[smoothing.length - 1].value, false, `${label}：貼上緩衝區前必須關掉平滑`);
  assert.deepEqual(game.ops[blitAt].args.slice(-2), [360, 640], `${label}：緩衝區要放大貼滿虛擬畫面`);
}

function assertClassicFrame(game, label) {
  assert.equal(bufferBlits(game).length, 0, `${label}：經典主題不該貼像素緩衝區`);
  assert.ok(
    !game.ops.some(op => op.op === 'smoothing' && op.value === false),
    `${label}：經典主題不該關掉平滑`
  );
}

// ---- 像素緩衝區的內容（boot 要開 draws: true）----
// 與 cat-agility.js 對齊的顏色：貓身三色（墨黑、暗部、輪廓光）只有像素貓會用
const CAT_SILHOUETTE = new Set(['#1E1E24', '#131317', '#4A4A59']);
const CAT_BODY = '#1E1E24';
const FLOOR_SEAM = '#553A26';
const MOSS = '#4D5D44';
const CLASSIC_DEBRIS_COLORS = new Set(['#E6CFA8', '#D2B48C', '#B48F62', '#8B5A2B']);
const PX = 2; // 1 美術像素 = 2 虛擬像素

const ghostLayerOf = game => game.layers.find(l => l.width === 64 && l.height === 64);
const bufferRects = game => pixelBufferOf(game).draws.filter(d => d.op === 'fillRect');
const ghostBlits = game => {
  const ghost = ghostLayerOf(game);
  return pixelBufferOf(game).draws.filter(d => d.op === 'drawImage' && d.img === ghost);
};

function boundsOf(rects) {
  assert.ok(rects.length > 0, '找不到要量範圍的矩形');
  return {
    x0: Math.min(...rects.map(r => r.x)),
    y0: Math.min(...rects.map(r => r.y)),
    x1: Math.max(...rects.map(r => r.x + r.w)),
    y1: Math.max(...rects.map(r => r.y + r.h))
  };
}

// 從存檔開機、再推一幀暫停畫面，回傳這一幀緩衝區裡的 fillRect；亂數與時鐘都固定，同樣的存檔一定畫出同樣的東西
function pausedRects(save, opts = {}) {
  const game = bootSave(save, { draws: true, ...opts });
  game.tick();
  assert.equal(game.snap().state, 'PAUSED');
  return bufferRects(game);
}

const rectKey = r => `${r.x},${r.y},${r.w},${r.h},${r.color},${r.alpha}`;

// 兩幀只差在「中間多畫了一段」：前綴與後綴必須逐筆相同，回傳多出來的那一段
function insertedRects(base, withExtra, label) {
  let i = 0;
  while (i < base.length && rectKey(base[i]) === rectKey(withExtra[i])) i++;
  const n = withExtra.length - base.length;
  assert.ok(n > 0, `${label}：應該多畫出幾個矩形（實際多 ${n} 個）`);
  for (let j = i; j < base.length; j++) {
    assert.equal(rectKey(withExtra[j + n]), rectKey(base[j]), `${label}：多畫的那段之後，其他繪圖應該完全相同`);
  }
  return withExtra.slice(i, i + n);
}

// 兩幀從第一個不同的矩形開始的尾段（前綴必須相同）：分數畫在最後，換分數只會改到尾段
function tailFromFirstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && rectKey(a[i]) === rectKey(b[i])) i++;
  return { at: i, a: a.slice(i), b: b.slice(i) };
}

// 一局走遍所有狀態：暫停（存檔開機）→ 衝刺中飛行（含殘影與撞散）→ 摔地結算 → 回到 READY；每一幀都交給 onFrame 檢查
function driveAllStates(game, onFrame) {
  for (let i = 0; i < 3; i++) {
    game.tick();
    onFrame('PAUSED');
  }
  game.key('ArrowUp');
  for (let i = 0; i < 90 && game.snap().state === 'PLAYING'; i++) {
    game.step(345);
    onFrame(game.snap().invincible ? 'PLAYING（衝刺）' : 'PLAYING');
  }
  for (let i = 0; i < 400 && game.snap().state === 'PLAYING'; i++) {
    game.tick();
    onFrame('PLAYING（下墜）');
  }
  assert.equal(game.snap().state, 'GAMEOVER');
  for (let i = 0; i < 40; i++) {
    game.tick();
    onFrame('GAMEOVER');
  }
  game.key('Space');
  assert.equal(game.snap().state, 'READY');
  for (let i = 0; i < 5; i++) {
    game.tick();
    onFrame('READY');
  }
}

const frenzyFlightSave = () => validSave({
  score: 3,
  passCount: 3,
  frenzy: 150,
  speed: FRENZY_SPEED,
  spawnTimer: 0,
  cat: { y: 300, vy: 0, rot: 0 },
  pipes: [
    { x: 130, gapY: 150, passed: false, variant: 'drawer' },
    { x: 350, gapY: 315, passed: false, variant: 'plant', item: 'grass' }
  ]
});

// 靜態掃描前先去掉註解（註解裡提到 roundRect、Math.random 不算違規）；字串內容原樣保留
function stripComments(code) {
  let out = '';
  let quote = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

// 依 // #region 名稱 與 // #endregion 名稱 建出分區樹；開關必須一一對應、正確巢狀
function parseRegions(code) {
  const lines = code.split(/\r?\n/);
  const stack = [];
  const regions = new Map();
  lines.forEach((line, index) => {
    const open = line.match(/^\s*\/\/ #region (\S+)\s*$/);
    const close = line.match(/^\s*\/\/ #endregion (\S+)\s*$/);
    if (open) {
      assert.ok(!regions.has(open[1]), `分區 ${open[1]} 重複出現`);
      const region = { name: open[1], parent: stack.length ? stack[stack.length - 1].name : null, start: index, end: -1 };
      regions.set(open[1], region);
      stack.push(region);
    } else if (close) {
      const top = stack.pop();
      assert.ok(top, `第 ${index + 1} 行的 #endregion ${close[1]} 沒有對應的 #region`);
      assert.equal(close[1], top.name, `第 ${index + 1} 行關的是 ${close[1]}，但最內層開著的是 ${top.name}`);
      top.end = index;
    }
  });
  assert.equal(stack.length, 0, `沒有關閉的分區：${stack.map(r => r.name).join(', ')}`);
  const text = name => {
    const region = regions.get(name);
    return lines.slice(region.start, region.end + 1).join('\n');
  };
  return { regions, text };
}

// ---------------------------------------------------------------------------
// A. 狀態機與輸入
// ---------------------------------------------------------------------------

test('初次進入是 READY，沒有柱子也沒有分數', () => {
  const game = boot();
  const s = game.snap();
  assert.equal(s.state, 'READY');
  assert.equal(s.score, 0);
  assert.equal(s.pipes, 0);
  game.advance(2000);
  assert.equal(game.snap().state, 'READY', 'READY 畫面不能自己開局');
  assert.equal(game.snap().pipes, 0, 'READY 畫面不該生出柱子');
});

test('空白鍵、上方向鍵、W 與觸控都能開局', () => {
  for (const start of [g => g.key('Space'), g => g.key('ArrowUp'), g => g.key('KeyW'), g => g.tap()]) {
    const game = boot();
    start(game);
    assert.equal(game.snap().state, 'PLAYING');
  }
});

test('不相干的輸入不會開局', () => {
  const game = boot();
  game.key('KeyA');
  game.key('Enter');
  game.key('Space', { repeat: true });
  game.key('Space', { ctrlKey: true });
  game.key('Space', { metaKey: true });
  game.tap({ pointerType: 'mouse', button: 2 });
  assert.equal(game.snap().state, 'READY');
});

test('長按空白鍵的自動重複只算一下，但仍要擋掉捲動', () => {
  const game = boot();
  const event = game.key('Space', { repeat: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(game.snap().state, 'READY');
});

test('鍵盤聚焦在按鈕上時，空白鍵留給按鈕；方向鍵仍控制遊戲', () => {
  const game = boot();
  const space = game.key('Space', { target: game.soundBtn });
  assert.equal(space.defaultPrevented, false, '不能吃掉按鈕的空白鍵啟動');
  assert.equal(game.snap().state, 'READY');
  game.key('ArrowUp', { target: game.soundBtn });
  assert.equal(game.snap().state, 'PLAYING');
});

// ---------------------------------------------------------------------------
// B. 物理、碰撞與計分
// ---------------------------------------------------------------------------

test('開局後不操作，貓會摔到地板而結束，落點貼齊地面', () => {
  const game = boot();
  game.key('Space');
  assert.ok(game.runUntil(s => s.state === 'GAMEOVER', 3000), '3 秒內應該摔到地板');
  assert.equal(game.snap().catY, GROUND_REST_Y);
});

test('一直蹬跳會被天花板擋住，但天花板不會判死', () => {
  const game = boot();
  game.key('Space');
  for (let i = 0; i < 60; i++) {
    game.key('Space');
    game.tick();
  }
  const s = game.snap();
  assert.equal(s.state, 'PLAYING');
  assert.equal(s.catY, CEILING_Y);
});

test('穿過柱子空隙時每根柱子只計一分', () => {
  // random 固定 0.5 → 空隙中心 315；貓在 330 以下就蹬，會一直待在空隙裡
  const game = boot();
  game.key('Space');
  game.fly(8000, 330);
  const s = game.snap();
  assert.equal(s.state, 'PLAYING', '自動駕駛應該全程存活');
  // 第一根柱子在第 60 步生成、約第 194 步通過，之後每 100 步一根 → 480 步時剛好 3 分
  assert.equal(s.score, 3);
});

test('撞到柱子會在半空中結束，不必等落地', () => {
  // random 固定 0 → 空隙中心 150（77.5 ~ 222.5），貓守在 330 一定撞上下半截柱子
  const game = boot({ random: () => 0 });
  game.key('Space');
  game.fly(6000, 330);
  const s = game.snap();
  assert.equal(s.state, 'GAMEOVER');
  assert.ok(s.catY < GROUND_REST_Y - 100, `應該撞柱而不是摔地，catY=${s.catY}`);
  assert.equal(s.score, 0);
});

// ---------------------------------------------------------------------------
// C. 結算與重開
// ---------------------------------------------------------------------------

test('結算寫入戰績、清掉進行中局況，並朗讀結果', () => {
  const game = boot();
  game.key('Space');
  game.fly(8000, 330);
  // 停手後往下掉的途中還可能再穿過一根，分數以結束當下為準
  game.runUntil(s => s.state === 'GAMEOVER', 5000);

  const s = game.snap();
  const score = s.score;
  assert.ok(score >= 3);
  assert.equal(s.state, 'GAMEOVER');
  assert.equal(s.plays, 1);
  assert.equal(s.best, score);
  assert.deepEqual(game.readJson(KEYS.stats), { best: score, plays: 1 });
  assert.equal(game.storage.data.has(KEYS.state), false);
  assert.match(game.status.textContent, new RegExp(`本次 ${score} 分`));
});

test('結束後 400ms 內的輸入不會重開，之後回到 READY 再開新局', () => {
  const game = boot();
  game.key('Space');
  game.runUntil(s => s.state === 'GAMEOVER', 3000);

  game.key('Space');
  game.tap();
  assert.equal(game.snap().state, 'GAMEOVER', '剛結束時的連點不能直接跳過結算');
  game.advance(300);
  game.key('Space');
  assert.equal(game.snap().state, 'GAMEOVER');
  game.advance(150);
  game.key('Space');
  assert.equal(game.snap().state, 'READY');
  assert.equal(game.snap().pipes, 0);
  game.key('Space');
  assert.equal(game.snap().state, 'PLAYING');
  assert.equal(game.snap().score, 0);
});

test('較低的分數不會蓋掉最佳紀錄', () => {
  const game = boot();
  game.key('Space');
  game.fly(8000, 330);
  game.runUntil(s => s.state === 'GAMEOVER', 5000);
  const best = game.snap().best;
  assert.ok(best > 0);

  game.advance(500);
  game.key('Space');
  game.key('Space');
  game.runUntil(s => s.state === 'GAMEOVER', 3000);
  assert.equal(game.snap().plays, 2);
  assert.equal(game.snap().best, best);
  assert.deepEqual(game.readJson(KEYS.stats), { best, plays: 2 });
});

// ---------------------------------------------------------------------------
// D. 暫停與續玩（AGENTS.md 持久化規範）
// ---------------------------------------------------------------------------

test('切到背景會暫停並存檔，回前景不會自己續玩', () => {
  const game = boot();
  game.key('Space');
  game.fly(5000, 330);
  const before = game.snap();
  assert.ok(before.score >= 1);

  game.hide();
  assert.equal(game.snap().state, 'PAUSED');
  const saved = game.readJson(KEYS.state);
  assert.equal(saved.score, before.score);
  assert.equal(saved.pipes.length, before.pipes);

  game.show();
  game.advance(2000);
  const after = game.snap();
  assert.equal(after.state, 'PAUSED');
  assert.equal(after.catY, before.catY, '暫停中貓不能繼續下墜');
  game.key('Space');
  assert.equal(game.snap().state, 'PLAYING');
});

test('pagehide（重整、回首頁）也會存檔，重新載入後還原成暫停局', () => {
  const first = boot();
  first.key('Space');
  first.fly(5000, 330);
  const before = first.snap();
  first.pagehide();

  const second = boot({ storage: first.storage });
  const s = second.snap();
  assert.equal(s.state, 'PAUSED');
  assert.equal(s.score, before.score);
  assert.equal(s.pipes, before.pipes);
  assert.equal(s.catY, before.catY);
  assert.match(second.status.textContent, /未完成/);

  second.key('Space');
  assert.equal(second.snap().state, 'PLAYING');
});

test('壞掉的進行中局況一律丟棄並從 READY 開始', () => {
  const broken = [
    validSave({ v: 2 }),
    validSave({ score: -1 }),
    validSave({ score: '5' }),
    validSave({ scroll: null }),
    validSave({ cat: null }),
    validSave({ cat: { y: 'x', vy: 0, rot: 0 } }),
    validSave({ pipes: 'nope' }),
    validSave({ pipes: [{ x: 100, gapY: 10 }] }),
    validSave({ pipes: [{ x: 100, gapY: 999 }] }),
    validSave({ pipes: Array.from({ length: 9 }, (_, i) => ({ x: i * 40, gapY: 300 })) })
  ];
  broken.forEach((save, i) => {
    const game = boot({ storage: storageWithSave(save) });
    assert.equal(game.snap().state, 'READY', `第 ${i} 筆壞存檔不該被載入`);
    assert.equal(game.storage.data.has(KEYS.state), false, `第 ${i} 筆壞存檔應被刪掉`);
  });

  const garbage = boot({ storage: createStorage({ [KEYS.state]: '{not json' }) });
  assert.equal(garbage.snap().state, 'READY');
});

test('合法但超出範圍的存檔值會被夾回安全範圍', () => {
  const game = boot({
    storage: storageWithSave(validSave({ score: 7.9, cat: { y: -500, vy: 99, rot: 999 } }))
  });
  const s = game.snap();
  assert.equal(s.state, 'PAUSED');
  assert.equal(s.score, 7);
  assert.equal(s.catY, CEILING_Y);
});

test('壞掉的戰績資料回到 0，不會讓遊戲掛掉', () => {
  for (const raw of ['{bad json', '{"best":-5,"plays":"x"}', 'null', '[]']) {
    const game = boot({ storage: createStorage({ [KEYS.stats]: raw }) });
    assert.equal(game.snap().best, 0);
    assert.equal(game.snap().plays, 0);
  }
  const fractional = boot({ storage: createStorage({ [KEYS.stats]: '{"best":3.7,"plays":2}' }) });
  assert.equal(fractional.snap().best, 3);
  assert.equal(fractional.snap().plays, 2);
});

test('localStorage 全面拋錯時照樣能玩完一局', () => {
  const game = boot({ storage: createStorage({}, { broken: true }) });
  game.key('Space');
  game.hide();
  game.show();
  game.key('Space');
  assert.ok(game.runUntil(s => s.state === 'GAMEOVER', 3000));
  assert.equal(game.snap().plays, 1);
});

// 回歸：暫停面板原本固定在 y 250~380，貓的預設高度 280 正好被整個蓋住，
// 續玩時玩家看不到貓在哪，第一下蹬跳等於盲飛。
test('暫停面板不會蓋住貓', () => {
  const CAT_REACH = 30; // 耳朵、尾巴與旋轉後的繪製範圍
  const PANEL_H = 130;
  const TITLE_OFFSET = 42;
  for (const y of [16, 100, 200, 270, 280, 299, 300, 330, 420, 520, GROUND_REST_Y - 1]) {
    const game = boot({ storage: storageWithSave(validSave({ cat: { y, vy: 0, rot: 0 } })) });
    const catY = game.snap().catY;
    const title = game.tick().find(t => t.text === '暫停中');
    assert.ok(title, '暫停畫面要畫出「暫停中」');
    const panelTop = title.y - TITLE_OFFSET;
    const panelBottom = panelTop + PANEL_H;
    const clear = catY + CAT_REACH < panelTop || catY - CAT_REACH > panelBottom;
    assert.ok(clear, `貓在 y=${catY} 時被面板（${panelTop}~${panelBottom}）蓋住`);
    assert.ok(panelTop > 118, '面板不能壓到上方的分數');
    assert.ok(panelBottom < 580, '面板不能壓到地板');
  }
});

// ---------------------------------------------------------------------------
// E. 靜態契約
// ---------------------------------------------------------------------------

test('index.html 依序載入共用模組、記錄遊玩次數，且與首頁卡片 ID 一致', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, [
    '../../assets/js/bobo-theme.js',
    '../../assets/js/bobo-audio.js',
    '../../assets/js/stats.js',
    'cat-agility.js'
  ]);

  const recorded = html.match(/Stats\.recordGamePlay\('([^']+)'\)/);
  assert.ok(recorded, '必須呼叫 Stats.recordGamePlay');
  const home = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(home, new RegExp(`data-id="${recorded[1]}"[^>]*>\\s*<a class="card-link" href="games/cat-agility/`),
    '遊玩次數的 key 必須等於首頁卡片的 data-id，否則首頁看不到次數');

  assert.match(html, /<canvas id="game-canvas" role="img" aria-label="[^"]+"/);
  assert.match(html, /id="game-status" role="status" aria-live="polite"/);
  assert.match(html, /<meta name="theme-color"[^>]*data-theme-color-light="[^"]+"[^>]*data-theme-color-dark="[^"]+"/);
});

test('防閃爍片段在樣式表之前，且與 BoboTheme.ANTI_FLASH_SNIPPET 一致', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const BoboTheme = require('../assets/js/bobo-theme.js');
  const inline = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(inline, '缺少 inline 防閃爍 script');
  const squash = text => text.replace(/\s+/g, '');
  assert.equal(squash(inline[1]), squash(BoboTheme.ANTI_FLASH_SNIPPET));
  assert.ok(inline.index < html.indexOf('<link rel="stylesheet"'), '防閃爍片段必須排在 CSS 之前');
});

test('localStorage 只在 Store 的 try...catch 內存取，共用模組一律 typeof 守衛', () => {
  const store = source.match(/const Store = \{[\s\S]*?\n {2}\};/);
  assert.ok(store, '找不到 Store 物件');
  const inside = (store[0].match(/localStorage\./g) || []).length;
  const total = (source.match(/localStorage\./g) || []).length;
  assert.equal(inside, 3, 'Store 應有讀、寫、刪三處存取');
  assert.equal(total, inside, 'Store 以外不得直接存取 localStorage');
  assert.equal((store[0].match(/\btry \{/g) || []).length, 3);
  assert.equal((store[0].match(/\bcatch \(_\)/g) || []).length, 3);

  ['saveGameState', 'loadGameState', 'clearGameState'].forEach(name => {
    assert.match(source, new RegExp(`function ${name}\\(`), `缺少 ${name}()`);
  });
  ['BoboAudio', 'BoboTheme'].forEach(name => {
    assert.match(source, new RegExp(`typeof ${name} !== 'undefined'`), `${name} 必須以 typeof 守衛取得`);
    assert.doesNotMatch(source, new RegExp(`window\\.${name}\\b`));
  });
  assert.doesNotMatch(source, /\balert\s*\(/);
});

test('CSS 具備深色覆寫、reduced-motion 與 dvh，寬度不用 vw', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /:root\[data-theme="dark"\]\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /100dvh/);
  assert.doesNotMatch(css, /\d+vw\b/);
});

// ---------------------------------------------------------------------------
// F. 主題系統
// ---------------------------------------------------------------------------

test('預設畫面風格是 16-bit 像素，風格鍵顯示「像素」並說明下一步', () => {
  const game = boot();
  const s = game.snap();
  assert.equal(s.theme, 'pixel16');
  assert.equal(game.styleBtn.hidden, false);
  assert.equal(game.styleBtn.child && game.styleBtn.child.textContent, '像素');
  const label = game.styleBtn.getAttribute('aria-label');
  assert.match(label, /像素/);
  assert.match(label, /經典/, 'aria-label 要說明點下去會切成什麼');
  assert.equal(game.styleBtn.title, label);
});

test('風格鍵切換並寫回偏好，保留 BoboAudio 存的 sound 欄位；只有滑鼠／觸控點擊才交還焦點', () => {
  const game = boot({ storage: createStorage({ [KEYS.pref]: JSON.stringify({ sound: false }) }) });
  game.click(game.styleBtn, 1);
  assert.equal(game.snap().theme, 'classic');
  assert.deepEqual(game.readJson(KEYS.pref), { sound: false, style: 'classic' });
  assert.equal(game.styleBtn.child.textContent, '經典');
  assert.match(game.styleBtn.getAttribute('aria-label'), /經典.*像素/);
  assert.equal(game.styleBtn.blurCount, 1, '滑鼠點完要交還焦點，空白鍵才會回到遊戲');
  assert.match(game.status.textContent, /經典/, '切換風格要用狀態列告訴報讀器');

  game.click(game.styleBtn, 0);
  assert.equal(game.snap().theme, 'pixel16');
  assert.deepEqual(game.readJson(KEYS.pref), { sound: false, style: 'pixel16' });
  assert.equal(game.styleBtn.child.textContent, '像素');
  assert.equal(game.styleBtn.blurCount, 1, '鍵盤觸發的 click 不能把焦點丟掉');
  assert.match(game.status.textContent, /像素/);

  const reloaded = boot({ storage: game.storage });
  assert.equal(reloaded.snap().theme, 'pixel16');
});

test('偏好裡沒有或不合法的 style 一律用像素，而且不會洗掉 sound', () => {
  const raws = [
    null,
    '{}',
    '{"sound":false}',
    '{"sound":false,"style":"neon"}',
    '{"style":"CLASSIC"}',
    '{"style":null}',
    '{"style":1}',
    '{"style":["classic"]}',
    '["classic"]',
    '"classic"',
    'null',
    '{bad json'
  ];
  for (const raw of raws) {
    const storage = createStorage(raw === null ? {} : { [KEYS.pref]: raw });
    const game = boot({ storage });
    assert.equal(game.snap().theme, 'pixel16', `偏好 ${raw} 應該退回像素`);
    assert.equal(game.styleBtn.child.textContent, '像素');
    if (raw && raw.includes('"sound":false')) {
      assert.equal(game.readJson(KEYS.pref).sound, false, `偏好 ${raw} 的 sound 被洗掉了`);
    }
  }
});

test('切換風格只改 style：偏好裡其他欄位原樣保留，壞掉的偏好（陣列）會換成物件再存', () => {
  const game = bootPref({ sound: true, volume: 3 });
  game.click(game.styleBtn);
  assert.deepEqual(game.readJson(KEYS.pref), { sound: true, volume: 3, style: 'classic' });

  const broken = boot({ storage: createStorage({ [KEYS.pref]: '["classic"]' }) });
  broken.click(broken.styleBtn);
  assert.deepEqual(broken.readJson(KEYS.pref), { style: 'classic' }, '陣列存不住 style，重開就會忘記');
  assert.equal(boot({ storage: broken.storage }).snap().theme, 'classic');
});

test('偏好存的是 classic 就以經典開機，切回像素後重開也記得', () => {
  const game = bootPref({ sound: true, style: 'classic' });
  assert.equal(game.snap().theme, 'classic');
  assert.equal(game.styleBtn.child.textContent, '經典');
  game.tick();
  assertClassicFrame(game, '以經典開機的第一幀');

  game.click(game.styleBtn);
  assert.deepEqual(game.readJson(KEYS.pref), { sound: true, style: 'pixel16' });
  const reloaded = boot({ storage: game.storage });
  assert.equal(reloaded.snap().theme, 'pixel16');
});

test('環境建不出離屏畫布時退回經典主題，風格鍵藏起來，照樣能玩完一局', () => {
  const game = boot({ offscreen: false, storage: createStorage({ [KEYS.pref]: JSON.stringify({ style: 'pixel16' }) }) });
  assert.equal(game.snap().theme, 'classic');
  assert.equal(game.styleBtn.hidden, true, '只剩經典可用時不該顯示切換鍵');
  game.key('Space');
  game.tick();
  assertClassicFrame(game, '退回經典');
  assert.ok(game.runUntil(s => s.state === 'GAMEOVER', 3000));
  assert.equal(game.snap().plays, 1);
});

test('進行中（含衝刺中）切換風格完全不影響模擬：兩局逐步快照一致', () => {
  const save = validSave({
    score: 9,
    passCount: 9,
    frenzy: 150,
    speed: FRENZY_SPEED,
    spawnTimer: 50,
    cat: { y: 300, vy: 0, rot: 0 },
    pipes: [
      { x: 130, gapY: 150, passed: false, variant: 'drawer' },
      { x: 350, gapY: 400, passed: false, variant: 'plant' }
    ]
  });
  const clicks = new Set([3, 8, 9, 40, 41, 42, 120, 260, 261, 400, 555]);
  const run = (withClicks) => {
    const game = bootSave(save, { random: seeded(20261001) });
    const frames = [];
    let overAt = -1;
    for (let i = 0; i < 700; i++) {
      if (withClicks && clicks.has(i)) game.click(game.styleBtn, i % 2);
      const s = game.snap();
      if (s.state === 'PAUSED' || s.state === 'READY') {
        overAt = -1;
        game.key('Space');
      } else if (s.state === 'PLAYING') {
        // 480～600 步放手不蹬，確保劇本裡一定有摔地結算
        const handsOff = i >= 480 && i < 600;
        if (!handsOff && s.catY > nextGap(s) + 15) game.key('Space');
      } else {
        if (overAt < 0) overAt = i;
        if (i - overAt === 40) game.key('Space');
      }
      game.tick();
      frames.push(game.snap());
    }
    game.pagehide();
    return { frames, saved: game.storage.data.get(KEYS.state) || null };
  };

  const plain = run(false);
  const toggled = run(true);
  const strip = ({ theme, ...rest }) => rest;
  plain.frames.forEach((s, i) => {
    assert.deepEqual(strip(toggled.frames[i]), strip(s), `第 ${i} 步的模擬狀態因為切換風格而不同`);
  });
  assert.equal(toggled.saved, plain.saved, '切換風格不能影響存檔內容');

  // 確認這段劇本真的涵蓋了衝刺中切換、撞散、吃道具與結算
  assert.ok([...clicks].some(i => toggled.frames[i - 1].invincible), '至少要有一次在衝刺中切換');
  assert.ok(toggled.frames.some(s => s.theme === 'classic') && toggled.frames.some(s => s.theme === 'pixel16'));
  assert.ok(plain.frames.some(s => s.obstacles.some(o => o.brokenTop || o.brokenBottom)), '劇本裡要有撞散家具');
  assert.ok(plain.frames.some((s, i) => i > 0 && s.frenzyMs > plain.frames[i - 1].frenzyMs), '劇本裡要吃到道具');
  assert.ok(plain.frames.some(s => s.state === 'GAMEOVER'), '劇本裡要有結算');
});

// ---------------------------------------------------------------------------
// G. 像素管線
// ---------------------------------------------------------------------------

test('像素主題每一幀都關掉平滑，並把 180×320 緩衝區以最近鄰放大貼滿畫面', () => {
  const game = bootSave(frenzyFlightSave());
  const seen = new Set();
  driveAllStates(game, (label) => {
    seen.add(label);
    assertPixelFrame(game, label);
  });
  assert.ok(seen.has('PLAYING（衝刺）') && seen.has('GAMEOVER') && seen.has('READY'));
});

test('經典主題走原本的向量管線：不貼像素緩衝區，也不關平滑', () => {
  const game = bootSave(frenzyFlightSave(), { pref: { style: 'classic' } });
  assert.equal(game.snap().theme, 'classic');
  driveAllStates(game, label => assertClassicFrame(game, label));
});

test('遊戲中切換風格，下一幀就換成對應的繪製管線', () => {
  const game = boot();
  game.key('Space');
  for (let i = 0; i < 10; i++) {
    game.step(330);
    assertPixelFrame(game, '切換前');
  }
  game.click(game.styleBtn);
  for (let i = 0; i < 10; i++) {
    game.step(330);
    assertClassicFrame(game, '切到經典');
  }
  game.click(game.styleBtn);
  for (let i = 0; i < 10; i++) {
    game.step(330);
    assertPixelFrame(game, '切回像素');
  }
  assert.equal(game.snap().state, 'PLAYING');
});

test('像素主題的畫面震動對齊 2px 網格，整張圖不會被重新取樣而糊掉', () => {
  const game = boot({ random: seeded(42) });
  game.key('Space');
  const offsets = [];
  for (let i = 0; i < 400 && offsets.length < 8; i++) {
    game.tick();
    if (game.snap().state !== 'GAMEOVER') continue;
    // 緩衝區實際貼上的位置 = 貼上前所有 translate 的累計 + drawImage 本身的座標
    const buffer = pixelBufferOf(game);
    const blitAt = game.ops.findIndex(op => op.op === 'drawImage' && op.img === buffer);
    assert.ok(blitAt >= 0);
    const moves = game.ops.slice(0, blitAt).filter(op => op.op === 'translate');
    const dx = moves.reduce((sum, op) => sum + op.args[0], game.ops[blitAt].args[0]);
    const dy = moves.reduce((sum, op) => sum + op.args[1], game.ops[blitAt].args[1]);
    offsets.push([dx, dy]);
  }
  assert.equal(offsets.length, 8);
  for (const [dx, dy] of offsets) {
    assert.ok(Number.isInteger(dx / 2) && Number.isInteger(dy / 2), `震動位移 (${dx}, ${dy}) 沒有對齊美術像素`);
  }
  assert.ok(offsets.some(([dx, dy]) => dx !== 0 || dy !== 0), '摔地的那幾幀應該要有震動');
});

test('像素主題的分數以點陣字畫進緩衝區；經典主題維持原本的向量文字', () => {
  const save = validSave({ score: 7, passCount: 7 });
  const pixel = bootSave(save);
  pixel.key('ArrowUp');
  const pixelTexts = pixel.tick();
  assert.equal(pixel.snap().state, 'PLAYING');
  assert.ok(!pixelTexts.some(t => t.text === '7'), '像素主題不該用 fillText 在主畫布上畫分數');
  assert.ok(!pixel.layerTexts.some(t => t.text === '7'), '像素主題的分數要用點陣字，不是 fillText');
  assertPixelFrame(pixel, '像素分數');

  const classic = bootSave(save, { pref: { style: 'classic' } });
  classic.key('ArrowUp');
  const classicTexts = classic.tick();
  assert.ok(classicTexts.some(t => t.text === '7' && t.x === 180 && t.y === 84), '經典主題的分數位置不能變');
});

test('兩種主題的介面文字版面完全相同（READY、暫停、結算）', () => {
  const isScore = t => t.y === 84 && /^\d+$/.test(t.text);
  const collect = (pref) => {
    const ready = bootPref(pref).tick();
    const game = bootSave(validSave({ score: 4, cat: { y: 420, vy: 0, rot: 0 } }), { pref });
    const paused = game.tick().filter(t => !isScore(t));
    game.key('ArrowUp');
    game.runUntil(s => s.state === 'GAMEOVER', 5000);
    let over = [];
    for (let i = 0; i < 40; i++) over = game.tick();
    return { ready, paused, over };
  };
  const pixel = collect({ style: 'pixel16' });
  const classic = collect({ style: 'classic' });
  assert.ok(pixel.ready.some(t => t.text === '貓咪跳箱'));
  assert.ok(pixel.paused.some(t => t.text === '暫停中'));
  assert.ok(pixel.over.some(t => t.text === '遊戲結束'));
  assert.deepEqual(pixel.ready, classic.ready);
  assert.deepEqual(pixel.paused, classic.paused);
  assert.deepEqual(pixel.over, classic.over);
});

// ---------------------------------------------------------------------------
// H. 道具與無敵衝刺
// ---------------------------------------------------------------------------

test('障礙物生成時在三種家具組合中隨機三選一', () => {
  const seen = new Set();
  for (const [random, variant] of [[0, 'post'], [0.34, 'drawer'], [0.5, 'drawer'], [0.67, 'plant'], [0.9999, 'plant']]) {
    const game = boot({ random: () => random });
    game.key('Space');
    let s = game.snap();
    for (let i = 0; i < 200 && s.obstacles.length === 0; i++) s = game.step(330);
    assert.equal(s.obstacles.length, 1);
    const [spawned] = s.obstacles;
    assert.equal(spawned.variant, variant, `亂數 ${random} 應該選到 ${variant}`);
    assert.equal(spawned.item, null);
    assert.equal(spawned.brokenTop, false);
    assert.equal(spawned.brokenBottom, false);
    seen.add(spawned.variant);
  }
  assert.deepEqual([...seen].sort(), [...VARIANT_NAMES].sort());
});

test('從頭飛過第 10 組障礙物：道具出現在下一組的縫隙正中央，而且只有一顆', () => {
  const game = boot();
  game.key('Space');
  let prev = game.snap();
  const appeared = [];
  for (let i = 0; i < 2500 && prev.passCount < 12; i++) {
    const s = game.step(330);
    assert.equal(s.state, 'PLAYING', '自動駕駛應該全程存活');
    assert.equal(s.passCount, s.score, '累計通過數要跟分數一起加');
    if (s.items.length > prev.items.length) appeared.push({ before: prev, after: s });
    prev = s;
  }
  assert.ok(prev.passCount >= 12);
  assert.equal(appeared.length, 1, '0～11 組之間只能生成一顆道具');
  const { before, after } = appeared[0];
  assert.equal(before.passCount, 9);
  assert.equal(after.passCount, 10, '道具要在剛好第 10 組通過的那一步生成');
  const holder = assertMilestoneItem(before, after, '第 10 組');
  assert.equal(holder.item, 'grass', 'Math.random() 固定 0.5 → 不小於 0.5 → 貓草');
});

test('里程碑 10／20／30 在各種縫隙位置與亂數下 100% 生成於縫隙中央；9、11 不會多生', () => {
  const gapPairs = [[150, 480], [480, 150], [315, 222]];
  const randoms = [0, 0.25, 0.5, 0.9999];
  const passBefore = (passCount, rest, random, lead = []) => {
    const game = bootSave(validSave({
      score: passCount,
      passCount,
      spawnTimer: 0,
      cat: { y: 315, vy: 0, rot: 0 },
      pipes: [...lead, { x: 70, gapY: 315, passed: false }, ...rest]
    }), { random });
    game.key('ArrowUp');
    const before = game.snap();
    game.tick();
    const after = game.snap();
    assert.equal(after.state, 'PLAYING');
    assert.equal(after.passCount, passCount + 1, '續玩第一步就通過貓所在的那一組');
    return { before, after };
  };

  let cases = 0;
  for (const milestone of [10, 20, 30]) {
    for (const [g1, g2] of gapPairs) {
      for (const random of randoms) {
        const lead = [{ x: 4, gapY: 200, passed: true, variant: 'plant' }];
        const rest = [{ x: 290, gapY: g1, passed: false, variant: 'drawer' }, { x: 410, gapY: g2, passed: false }];
        const { before, after } = passBefore(milestone - 1, rest, () => random, lead);
        const label = `第 ${milestone} 組（縫隙 ${g1}、亂數 ${random}）`;
        const holder = assertMilestoneItem(before, after, label);
        assert.equal(holder.gapY, g1, `${label}：道具要給緊接在後的那一組`);
        assert.equal(holder.item, random < 0.5 ? 'can' : 'grass', `${label}：罐頭與貓草各半`);
        assert.equal(after.itemPending, false);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 36);

  // 下一組已經帶著道具（沒吃到的舊道具）：新道具順延給再下一組
  const skip = passBefore(29, [
    { x: 290, gapY: 200, passed: false, item: 'can' },
    { x: 410, gapY: 400, passed: false }
  ], () => 0.7);
  const holder = assertMilestoneItem(skip.before, skip.after, '第 30 組（下一組已有道具）');
  assert.equal(holder.gapY, 400);

  // 第 9 組與第 11 組不是里程碑：不能多生
  for (const passCount of [8, 10, 18, 20]) {
    const { after } = passBefore(passCount, [{ x: 290, gapY: 260, passed: false }, { x: 410, gapY: 300, passed: false }], () => 0.3);
    assert.equal(after.items.length, 0, `第 ${passCount + 1} 組不該生成道具`);
    assert.equal(after.itemPending, false);
  }
});

test('里程碑看的是累計通過數，不是分數（兩者不同步的存檔也一樣）', () => {
  const run = (score, passCount) => {
    const game = bootSave(validSave({
      score,
      passCount,
      spawnTimer: 0,
      cat: { y: 315, vy: 0, rot: 0 },
      pipes: [{ x: 70, gapY: 315, passed: false }, { x: 290, gapY: 260, passed: false }]
    }));
    game.key('ArrowUp');
    return game.step();
  };
  const hit = run(5, 9);
  assert.equal(hit.passCount, 10);
  assert.equal(hit.items.length, 1, '累計通過到第 10 組就要送道具，即使分數才 6');
  const miss = run(9, 5);
  assert.equal(miss.score, 10);
  assert.equal(miss.items.length, 0, '分數到 10 但累計通過數才 6，不該送道具');
});

test('里程碑當下還沒有下一組障礙物：道具留給下一次生成的那一組', () => {
  const game = bootSave(validSave({
    score: 9,
    passCount: 9,
    spawnTimer: 0,
    cat: { y: 335, vy: 0, rot: 0 },
    pipes: [{ x: 70, gapY: 315, passed: false }]
  }));
  game.key('ArrowUp');
  let s = game.step();
  assert.equal(s.passCount, 10);
  assert.equal(s.itemPending, true);
  assert.equal(s.items.length, 0);

  // 剛生成的障礙物在畫面右緣外（x ≈ 360）；在那之前道具一直保留、不能先出現
  const isFresh = o => o.x > 340;
  for (let i = 0; i < 150 && !s.obstacles.some(isFresh); i++) {
    s = game.step(330);
    if (!s.obstacles.some(isFresh)) {
      assert.equal(s.items.length, 0, '生成前不該有道具');
      assert.equal(s.itemPending, true);
    }
  }
  const spawned = s.obstacles.find(isFresh);
  assert.ok(spawned, '150 步內應該生成下一組');
  assert.equal(s.itemPending, false);
  assert.equal(s.items.length, 1);
  assert.deepEqual(s.items[0], { kind: spawned.item, x: spawned.x + PIPE_HALF_W, y: spawned.gapY });
  assert.ok(ITEM_KINDS.includes(spawned.item));

  for (let i = 0; i < 60; i++) s = game.step(330);
  assert.ok(s.items.length <= 1, '同一個里程碑只能有一顆道具');
});

test('吃到道具：立刻無敵 3000ms、速度線性升到剛好 1.6，並播放由低到高的 4 音琶音', () => {
  const game = bootSave(validSave({
    score: 3,
    passCount: 3,
    spawnTimer: 0,
    cat: { y: 335, vy: 0, rot: 0 },
    pipes: [{ x: 68, gapY: 315, passed: false, variant: 'post', item: 'can' }]
  }), { audio: true });
  const arpeggios = () => game.audio.filter(c => c.kind === 'chord' && Array.isArray(c.args[0]) && c.args[0].length === 4);
  game.key('ArrowUp');
  assert.equal(arpeggios().length, 0, '還沒吃到就不該播琶音');
  const effectsBefore = game.snap().effects;

  const s = game.step();
  assert.equal(s.items.length, 0, '道具被吃掉');
  assert.equal(s.obstacles[0].item, null);
  assert.equal(s.invincible, true);
  assert.equal(s.frenzyMs, 3000);
  assert.ok(s.effects > effectsBefore, '吃到時要噴出星光');

  const played = arpeggios();
  assert.equal(played.length, 1, '吃到一次只播一段琶音');
  const [notes, shared = {}] = played[0].args;
  const freqs = notes.map(n => (typeof n === 'number' ? n : n.freq));
  freqs.forEach(f => assert.ok(Number.isFinite(f) && f > 0));
  for (let i = 1; i < freqs.length; i++) assert.ok(freqs[i] > freqs[i - 1], `琶音要由低到高：${freqs.join(', ')}`);
  assert.ok(shared.stagger > 0, '四個音要依序錯開（琶音），不是同時響的和弦');

  // 速度倍率每步只能往上爬、不超過 1.6，而且精準停在 1.6（不累積浮點誤差）
  let speed = s.speed;
  let reachedAt = -1;
  for (let i = 1; i <= 60; i++) {
    const next = game.step(345);
    assert.equal(next.invincible, true);
    assert.ok(next.speed >= speed && next.speed <= FRENZY_SPEED, `第 ${i} 步速度 ${next.speed}`);
    if (reachedAt < 0 && next.speed === FRENZY_SPEED) reachedAt = i;
    speed = next.speed;
  }
  assert.ok(reachedAt > 1 && reachedAt <= 12, `速度要在約 10 步內平滑升到 1.6（實際第 ${reachedAt} 步）`);
  assert.equal(speed, FRENZY_SPEED);
  assert.equal(game.timers.length, 0, '衝刺不能靠 setTimeout／setInterval 計時');
});

test('衝刺中再吃到道具會把時間補滿', () => {
  const game = bootSave(validSave({
    score: 3,
    passCount: 3,
    frenzy: 30,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 335, vy: 0, rot: 0 },
    pipes: [{ x: 68, gapY: 315, passed: false, variant: 'plant', item: 'grass' }]
  }));
  assert.equal(game.snap().frenzyMs, 500);
  game.key('ArrowUp');
  const s = game.step();
  assert.equal(s.items.length, 0);
  assert.equal(s.frenzyMs, 3000, '再吃一次要重新計滿 3000ms，不是疊加也不是忽略');
  assert.equal(s.invincible, true);
});

test('無敵時撞到家具只會撞散那半截，噴出 8～12 顆碎屑，穿過後照樣計分', () => {
  const counts = [];
  for (const random of [0, 0.5, 0.9999]) {
    const game = bootSave(validSave({
      score: 2,
      passCount: 2,
      frenzy: 150,
      speed: FRENZY_SPEED,
      spawnTimer: 0,
      cat: { y: 300, vy: 0, rot: 0 },
      pipes: [{ x: 130, gapY: 150, passed: false, variant: 'plant' }]
    }), { random: () => random, audio: true });
    game.key('ArrowUp');
    let prev = game.snap();
    let smashed = null;
    for (let i = 0; i < 30 && !smashed; i++) {
      const mark = game.audio.length;
      const s = game.step();
      assert.equal(s.state, 'PLAYING', '無敵時撞到家具不能結束');
      if (s.obstacles[0].brokenBottom) smashed = { before: prev, after: s, sounds: game.audio.slice(mark) };
      prev = s;
    }
    assert.ok(smashed, '貓守在下半截的高度，應該撞上');
    const { before, after, sounds } = smashed;
    assert.equal(after.obstacles[0].brokenTop, false, '只撞散碰到的那一半');
    const debris = after.effects - before.effects;
    assert.ok(debris >= 8 && debris <= 12, `碎屑 ${debris} 顆，應為 8～12`);
    assert.ok(sounds.some(c => c.kind === 'noise'), '撞散要有碎裂的噪音');
    counts.push(debris);

    const scored = game.runUntil(s => s.obstacles[0].passed, 2000);
    assert.ok(scored, '撞散的障礙物還是要能通過');
    const s = game.snap();
    assert.equal(s.state, 'PLAYING');
    assert.equal(s.score, 3, '撞散的障礙物照樣計分');
    assert.equal(s.passCount, 3);
    assert.equal(s.obstacles[0].brokenBottom, true);
  }
  assert.equal(Math.min(...counts), 8, '亂數最小時碎屑是 8 顆');
  assert.equal(Math.max(...counts), 12, '亂數最大時碎屑是 12 顆');
});

test('無敵剛好撐到計時歸零：剩 1 步時撞到照樣結束；剩 2 步時那一步撞散，之後已撞散的半截不再判死', () => {
  // 障礙物 x 68（續玩那步移到 64.48，柱身 72.48～120.48 正對貓），縫隙 150 → 下半截從 220 起；貓在下半截柱身裡
  const save = frenzy => validSave({
    score: 2,
    passCount: 2,
    frenzy,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 300, vy: 0, rot: 0 },
    pipes: [{ x: 68, gapY: 150, passed: false, variant: 'drawer' }]
  });
  const last = bootSave(save(1));
  last.key('ArrowUp');
  assert.equal(last.step().state, 'GAMEOVER', '衝刺計時倒數到 0 的那一步已經不是無敵');

  const game = bootSave(save(2));
  game.key('ArrowUp');
  let s = game.step();
  assert.equal(s.state, 'PLAYING', '無敵的最後一步撞到只會撞散');
  assert.equal(s.invincible, true);
  assert.equal(s.obstacles[0].brokenBottom, true);
  assert.equal(s.obstacles[0].brokenTop, false);
  for (let i = 1; i <= 4; i++) {
    s = game.step();
    assert.equal(s.invincible, false);
    assert.equal(s.state, 'PLAYING', `衝刺結束後第 ${i} 步，貓還在已撞散的下半截裡，不能被判死`);
  }
});

test('撞散上半截不會連下半截一起撞散', () => {
  // 縫隙 440 → 上半截一路到 352（頂蓋到 370）；貓在 y ≈ 210，正對上半截柱身
  const game = bootSave(validSave({
    score: 2,
    passCount: 2,
    frenzy: 100,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 216, vy: 0, rot: 0 },
    pipes: [{ x: 68, gapY: 440, passed: false, variant: 'plant' }]
  }));
  game.key('ArrowUp');
  const s = game.step();
  assert.equal(s.state, 'PLAYING');
  assert.equal(s.obstacles[0].brokenTop, true);
  assert.equal(s.obstacles[0].brokenBottom, false, '只撞到上半截，下半截要留著');
});

test('只擦到頂蓋外緣（碰不到柱身）也算撞到：上下兩個頂蓋都要判定', () => {
  // 障礙物 x 110 → 續玩那步 107.8：頂蓋 107.8～171.8 碰得到貓（右緣 114），柱身從 115.8 起碰不到
  // 縫隙 300：上半截頂蓋 212～230、下半截頂蓋 370～388；續玩那一蹬讓貓升 6.42
  for (const [label, y, over] of [['下半截頂蓋', 379, true], ['上半截頂蓋', 221, true], ['縫隙中央（對照組）', 300, false]]) {
    const game = bootSave(validSave({ cat: { y: y + 6.42, vy: 0, rot: 0 }, pipes: [{ x: 110, gapY: 300, passed: false }] }));
    game.key('ArrowUp');
    assert.equal(game.step().state, over ? 'GAMEOVER' : 'PLAYING', `${label}：貓 y=${y}`);
  }
});

test('道具要真的碰到才吃得到：在縫隙裡離道具中心超過 26px 飛過不會觸發衝刺', () => {
  // 障礙物 x 70 → 續玩那步 67.8，道具中心 (99.8, 300) 幾乎正對貓（x 100）；判定半徑 = 貓 14 + 道具 12
  for (const [dy, picked] of [[20, true], [-20, true], [28, false], [-28, false], [40, false], [-40, false]]) {
    const game = bootSave(validSave({
      score: 3,
      passCount: 3,
      spawnTimer: 0,
      cat: { y: 300 + dy + 6.42, vy: 0, rot: 0 },
      pipes: [{ x: 70, gapY: 300, passed: false, variant: 'post', item: 'can' }]
    }));
    game.key('ArrowUp');
    const s = game.step();
    assert.equal(s.state, 'PLAYING', `離縫隙中心 ${dy}px 的貓應該安全穿過`);
    assert.ok(Math.abs(s.catY - (300 + dy)) < 1e-6);
    assert.equal(s.invincible, picked, `離道具 ${dy}px ${picked ? '應該' : '不該'}吃到`);
    assert.equal(s.items.length, picked ? 0 : 1);
  }
});

test('撞散後馬上切到背景：暫停畫面不會一直震動，續玩後也不會補震', () => {
  const game = bootSave(validSave({
    score: 2,
    passCount: 2,
    frenzy: 150,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 300, vy: 0, rot: 0 },
    pipes: [{ x: 130, gapY: 150, passed: false, variant: 'plant' }]
  }));
  game.key('ArrowUp');
  let smashed = false;
  for (let i = 0; i < 30 && !smashed; i++) smashed = game.step().obstacles[0].brokenBottom;
  assert.ok(smashed, '劇本要先撞散下半截');
  assert.ok(game.ops.some(op => op.op === 'translate'), '撞散的那一幀要有輕微震動');
  game.hide();
  assert.equal(game.snap().state, 'PAUSED');
  for (let i = 0; i < 30; i++) {
    game.tick();
    assert.ok(!game.ops.some(op => op.op === 'translate'), `暫停第 ${i + 1} 幀還在震動`);
  }
  game.show();
  game.key('Space');
  game.tick();
  assert.equal(game.snap().state, 'PLAYING');
  assert.ok(!game.ops.some(op => op.op === 'translate'), '續玩後不該補上剩下的震動');
});

test('撞散的碎屑從撞擊點噴出：柱身很長時也貼著貓頭前方的家具，不會從遠處的縫隙邊緣冒出來', () => {
  // 只有碎屑會用到的顏色（撞散的那半截已經不畫，另一半截與背景都不用這些色）
  const scenes = [
    { half: 'top', catY: 66, gapY: 480, variant: 'drawer', colors: new Set(['#8C6446', '#A07858', '#8E9BAA']) },
    { half: 'bottom', catY: 470, gapY: 150, variant: 'plant', colors: new Set(['#ECE6D9', '#7E8E9E']) }
  ];
  for (const { half, catY, gapY, variant, colors } of scenes) {
    const game = bootSave(validSave({
      score: 2,
      passCount: 2,
      frenzy: 150,
      speed: FRENZY_SPEED,
      spawnTimer: 0,
      cat: { y: catY, vy: 0, rot: 0 },
      pipes: [{ x: 68, gapY, passed: false, variant }]
    }), { draws: true, random: seeded(7) });
    game.key('ArrowUp');
    const s = game.step();
    assert.equal(s.obstacles[0][half === 'top' ? 'brokenTop' : 'brokenBottom'], true, `${half}：續玩第一步就要撞散`);
    const chips = bufferRects(game).filter(r => colors.has(r.color));
    assert.ok(chips.length >= 4, `${half}：這一幀應該畫出碎屑（${chips.length}）`);
    assert.ok(!bufferRects(game).some(r => CLASSIC_DEBRIS_COLORS.has(r.color)), `${half}：像素主題的碎屑要用家具自己的顏色`);
    const xs = [];
    for (const r of chips) {
      const cy = (r.y + r.h / 2) * PX;
      const cx = (r.x + r.w / 2) * PX;
      xs.push(cx);
      assert.ok(Math.abs(cy - s.catY) <= 24, `${half}：碎屑 y=${cy} 離貓（${s.catY}）太遠`);
      // 家具柱身這時在 x 72.5～120.5，貓中心 100：碎屑撒在貓頭前方的柱身上，不是貓身上
      assert.ok(cx >= 96 && cx <= 126, `${half}：碎屑 x=${cx} 應該落在貓頭前方的家具柱身上`);
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(mean >= 105, `${half}：碎屑整體應該在貓頭前方（平均 x=${mean.toFixed(1)}）`);
  }
});

test('撞散時家具已經滑到貓身後：碎屑撒在柱身靠貓的那一段，不會全擠在貓的中心線上', () => {
  const colors = new Set(['#ECE6D9', '#7E8E9E']);
  // 續玩那一步障礙物左移 3.52：x 34.48／40.48／46.48，柱身右緣 90.5／96.5／102.5，已經在貓中心（100）附近或身後；
  // 貓那一步升 6.42 到 379，正好從後緣擦到下頂蓋（縫隙 300 → 頂蓋 370～388）
  for (const startX of [38, 44, 50]) {
    const game = bootSave(validSave({
      score: 2,
      passCount: 2,
      frenzy: 150,
      speed: FRENZY_SPEED,
      spawnTimer: 0,
      cat: { y: 385.42, vy: 0, rot: 0 },
      pipes: [{ x: startX, gapY: 300, passed: false, variant: 'plant' }]
    }), { draws: true, random: seeded(7) });
    game.key('ArrowUp');
    const s = game.step();
    const pipe = s.obstacles[0];
    assert.equal(s.state, 'PLAYING');
    assert.equal(pipe.brokenBottom, true, `x ${startX}：續玩第一步就要撞散下半截`);
    assert.equal(pipe.brokenTop, false);
    const chips = bufferRects(game).filter(r => colors.has(r.color));
    assert.ok(chips.length >= 4, `x ${startX}：這一幀應該畫出碎屑（${chips.length}）`);
    const xs = chips.map(r => (r.x + r.w / 2) * PX);
    const postLeft = pipe.x + 8;
    const postRight = pipe.x + 56;
    // 取整到美術像素、碎屑本身 1～3 格寬：容許幾個虛擬像素
    for (const cx of xs) {
      assert.ok(cx >= postLeft - 2 && cx <= postRight + 4, `x ${startX}：碎屑 x=${cx} 應該落在柱身 ${postLeft}～${postRight} 上`);
    }
    assert.ok(Math.max(...xs) - Math.min(...xs) >= 6, `x ${startX}：碎屑要散開，不能疊成一條直線：${xs.join(', ')}`);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(mean >= pipe.x + 32, `x ${startX}：碎屑應該在柱身靠貓的那一半（平均 x=${mean.toFixed(1)}）`);
    for (const r of chips) {
      const cy = (r.y + r.h / 2) * PX;
      assert.ok(Math.abs(cy - s.catY) <= 24, `x ${startX}：碎屑 y=${cy} 離貓（${s.catY}）太遠`);
    }
  }
});

test('衝刺剛結束、速度還在降時存檔重開：彩虹殘影接著淡出，不會一載入就消失', () => {
  const game = bootSave(validSave({
    score: 12,
    passCount: 12,
    frenzy: 0,
    speed: 1.4,
    spawnTimer: 0,
    cat: { y: 300, vy: 0, rot: 0 },
    pipes: []
  }));
  assert.equal(game.snap().invincible, false);
  game.key('ArrowUp');
  let s = game.step(320);
  assert.ok(s.speed < 1.4 && s.speed > 1);
  assert.equal(s.ghosts, 1, '淡出期間續玩，殘影要重新取樣');
  let steps = 0;
  while (s.speed > 1) {
    s = game.step(320);
    steps += 1;
    if (s.speed > 1) assert.ok(s.ghosts > 0);
  }
  assert.ok(steps >= 15 && steps <= 22, `從 1.4 每步降 0.02，約 20 步回到 1（實際 ${steps}）`);
  assert.equal(s.ghosts, 0, '速度回到 1 時殘影要釋放');
});

test('存檔裡的捲動量過大會被夾回，重開後的存檔也不會再帶著天文數字', () => {
  // 經典畫風的牆面裝飾迴圈遇到超過 2^53 的捲動量會停不下來；像素主題不受影響，所以用它安全地驗證夾值
  const game = bootSave(validSave({ scroll: 1e19 }));
  assert.equal(game.snap().state, 'PAUSED', '數值合法，只是太大：夾回後照常載入');
  game.key('Space');
  game.step(330);
  game.pagehide();
  const saved = game.readJson(KEYS.state);
  assert.ok(saved.scroll <= 1e9 + 100, `存回去的捲動量 ${saved.scroll} 沒有被夾住`);

  // 夾回後的經典畫風照常繪製
  const classic = bootSave(validSave({ scroll: 1e19 }), { pref: { style: 'classic' } });
  classic.tick();
  assert.equal(classic.snap().theme, 'classic');
  assert.ok(classic.tick().some(t => t.text === '暫停中'));
});

test('無敵衝刺中碰到地板仍然結束，衝刺狀態一併歸零', () => {
  const game = bootSave(validSave({
    score: 3,
    passCount: 3,
    frenzy: 150,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 540, vy: 5, rot: 0 },
    pipes: []
  }));
  game.key('ArrowUp');
  let prev = game.snap();
  let s = prev;
  for (let i = 0; i < 200 && s.state === 'PLAYING'; i++) {
    prev = s;
    s = game.step();
  }
  assert.equal(prev.invincible, true, '落地前一步仍在無敵中');
  assert.equal(s.state, 'GAMEOVER');
  assert.equal(s.catY, GROUND_REST_Y);
  assert.equal(s.invincible, false);
  assert.equal(s.frenzyMs, 0);
  assert.equal(s.speed, 1);
  assert.equal(s.ghosts, 0);
  assert.deepEqual(game.readJson(KEYS.stats), { best: 3, plays: 1 });
});

test('衝刺剛好 180 步後結束：速度平滑降回 1、殘影清空，之後撞柱照常判死，粒子也會自然消光', () => {
  const game = bootPickup();
  let s = game.snap();
  assert.equal(s.ghosts, TRAIL_LEN, '吃到的那一幀殘影取樣就要補滿，3 道殘影立刻出現');
  let invincibleSteps = 1; // 吃到的那一步已經是無敵
  let maxGhosts = s.ghosts;
  for (let i = 0; i < 400; i++) {
    const prev = s;
    s = game.step(345);
    assert.equal(s.state, 'PLAYING');
    if (!s.invincible) break;
    assert.ok(s.frenzyMs < prev.frenzyMs, '衝刺時間每步遞減');
    assert.ok(s.speed >= prev.speed, '衝刺中速度只升不降');
    maxGhosts = Math.max(maxGhosts, s.ghosts);
    invincibleSteps += 1;
  }
  assert.equal(invincibleSteps, FRENZY_STEPS, '無敵剛好 180 步（3000ms）');
  assert.equal(s.frenzyMs, 0);
  assert.equal(maxGhosts, TRAIL_LEN, '殘影取樣最多 10 筆');

  // 衝刺結束：速度每步只降不升，精準回到 1；回到 1 時殘影已經清空
  let fadeSteps = 0;
  while (s.speed !== 1) {
    const prev = s;
    s = game.step(345);
    fadeSteps += 1;
    assert.ok(s.speed < prev.speed, `第 ${fadeSteps} 步速度沒有下降：${prev.speed} → ${s.speed}`);
    // 淡出期間殘影照樣取樣、維持滿的 10 筆，速度回到 1 的那一步才一次釋放
    if (s.speed > 1) assert.equal(s.ghosts, TRAIL_LEN, `淡出第 ${fadeSteps} 步殘影就不見了（速度 ${s.speed}）`);
    assert.equal(s.invincible, false);
    assert.ok(fadeSteps <= 35, '速度應在約 30 步內降回 1');
  }
  assert.ok(fadeSteps >= 20, `速度要平滑降回，不能瞬間歸位（${fadeSteps} 步）`);
  assert.equal(s.ghosts, 0, '淡出結束時殘影要清空');
  for (let i = 0; i < 20; i++) {
    s = game.step(345);
    assert.equal(s.speed, 1);
    assert.equal(s.ghosts, 0);
    assert.equal(s.frenzyMs, 0);
  }

  // 不再無敵：一路往天花板蹬，下一組家具的上半截就會撞死
  for (let i = 0; i < 300 && s.state === 'PLAYING'; i++) {
    game.key('Space');
    game.tick();
    s = game.snap();
  }
  assert.equal(s.state, 'GAMEOVER');
  assert.ok(s.catY < GROUND_REST_Y - 100, `應該撞柱而不是摔地，catY=${s.catY}`);
  assert.ok(s.obstacles.every(o => !o.brokenTop && !o.brokenBottom), '沒有無敵時不會撞散家具');

  game.advance(1500);
  s = game.snap();
  assert.equal(s.effects, 0, '粒子壽命到了就要回收');
  assert.equal(s.ghosts, 0);
  assert.equal(game.timers.length, 0);
});

test('連續多輪衝刺與一般飛行，陣列大小都有上限，不會越積越多', () => {
  const game = bootSave(validSave({
    score: 9,
    passCount: 9,
    spawnTimer: 0,
    cat: { y: 340, vy: 0, rot: 0 },
    pipes: [{ x: 70, gapY: 315, passed: false }, { x: 290, gapY: 315, passed: false }]
  }));
  game.key('ArrowUp');
  let s = game.snap();
  const motes = s.motes;
  let starts = 0;
  let ends = 0;
  let maxEffects = 0;
  let maxPipes = 0;
  for (let i = 0; i < 5000 && s.passCount < 41; i++) {
    const prev = s;
    s = game.step(345);
    assert.equal(s.state, 'PLAYING', `第 ${i} 步意外結束`);
    if (!prev.invincible && s.invincible) starts += 1;
    if (prev.speed > 1 && s.speed === 1) {
      ends += 1;
      assert.equal(s.ghosts, 0, '每一輪衝刺淡出後殘影都要清空');
    }
    if (!s.invincible && s.speed === 1) assert.equal(s.ghosts, 0);
    assert.ok(s.ghosts <= TRAIL_LEN);
    assert.equal(s.motes, motes, '環境微塵數量固定');
    maxEffects = Math.max(maxEffects, s.effects);
    maxPipes = Math.max(maxPipes, s.pipes);
  }
  assert.ok(s.passCount >= 41);
  assert.ok(starts >= 4, `四個里程碑應該觸發四輪衝刺（實際 ${starts} 輪）`);
  assert.ok(ends >= starts - 1);
  assert.ok(maxEffects <= 40, `粒子數量失控：${maxEffects}`);
  assert.ok(maxPipes <= 3, `障礙物數量失控：${maxPipes}`);

  game.runUntil(x => x.state === 'GAMEOVER', 5000);
  game.advance(1500);
  s = game.snap();
  assert.equal(s.effects, 0);
  assert.equal(s.ghosts, 0);
  assert.equal(s.frenzyMs, 0);
  assert.equal(s.speed, 1);
  assert.equal(game.timers.length, 0);
});

test('結算與回到 READY 會把道具與衝刺狀態歸零', () => {
  const game = bootSave(validSave({
    score: 12,
    passCount: 12,
    itemPending: true,
    frenzy: 100,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 400, vy: 0, rot: 0 },
    pipes: [{ x: 300, gapY: 300, passed: false, variant: 'drawer', item: 'can' }]
  }));
  game.key('ArrowUp');
  assert.ok(game.runUntil(s => s.state === 'GAMEOVER', 5000));
  let s = game.snap();
  assert.equal(s.frenzyMs, 0);
  assert.equal(s.invincible, false);
  assert.equal(s.speed, 1);
  assert.equal(s.ghosts, 0);

  game.advance(500);
  game.key('Space');
  s = game.snap();
  assert.equal(s.state, 'READY');
  assert.equal(s.passCount, 0);
  assert.equal(s.itemPending, false);
  assert.deepEqual(s.items, []);
  assert.deepEqual(s.obstacles, []);
  assert.equal(s.frenzyMs, 0);
  assert.equal(s.speed, 1);
  assert.equal(s.ghosts, 0);

  game.key('Space');
  s = game.snap();
  assert.equal(s.state, 'PLAYING');
  assert.equal(s.passCount, 0);
  assert.equal(s.itemPending, false);
});

test('快照每次都是新的純物件，外部修改不影響遊戲', () => {
  const game = bootSave(validSave({ pipes: [{ x: 220, gapY: 300, passed: false, variant: 'drawer', item: 'can' }] }));
  const raw = game.rawSnap();
  raw.obstacles[0].item = null;
  raw.obstacles.length = 0;
  raw.items.length = 0;
  const s = game.snap();
  assert.equal(s.obstacles.length, 1);
  assert.equal(s.obstacles[0].item, 'can');
  assert.deepEqual(s.items, [{ kind: 'can', x: 220 + PIPE_HALF_W, y: 300 }]);
});

test('暫停時衝刺計時凍結，續玩後才繼續倒數', () => {
  const game = bootSave(validSave({
    score: 3,
    passCount: 3,
    frenzy: 150,
    speed: FRENZY_SPEED,
    spawnTimer: 0,
    cat: { y: 315, vy: 0, rot: 0 },
    pipes: []
  }));
  assert.equal(game.snap().frenzyMs, 2500);
  game.advance(1000);
  assert.equal(game.snap().frenzyMs, 2500, '存檔開機的暫停局也不能倒數');

  game.key('ArrowUp');
  for (let i = 0; i < 10; i++) game.step(345);
  const before = game.snap();
  assert.equal(before.frenzyMs, Math.round(140 * STEP_MS));
  game.hide();
  assert.equal(game.snap().state, 'PAUSED');
  assert.equal(game.readJson(KEYS.state).frenzy, 140);

  game.advance(3000);
  game.show();
  game.advance(1000);
  const after = game.snap();
  assert.equal(after.state, 'PAUSED');
  assert.equal(after.frenzyMs, before.frenzyMs);
  assert.equal(after.invincible, true);
  assert.equal(after.speed, before.speed);
  assert.equal(after.ghosts, before.ghosts);
  assert.equal(after.catY, before.catY);

  game.key('Space');
  const resumed = game.step();
  assert.equal(resumed.state, 'PLAYING');
  assert.equal(resumed.frenzyMs, Math.round(139 * STEP_MS), '續玩後才繼續倒數');
});

test('衝刺加速時障礙物間距仍維持約 220px（依距離生成）', () => {
  const game = bootSave(validSave({
    score: 3,
    passCount: 3,
    frenzy: FRENZY_STEPS,
    speed: FRENZY_SPEED,
    spawnTimer: 99,
    cat: { y: 315, vy: 0, rot: 0 },
    pipes: []
  }));
  game.key('ArrowUp');
  let s = game.snap();
  const spacings = [];
  for (let i = 0; i < 520; i++) {
    const prev = s;
    s = game.step(345);
    assert.equal(s.state, 'PLAYING');
    if (s.obstacles.length > prev.obstacles.length && s.obstacles.length >= 2) {
      const [a, b] = s.obstacles.slice(-2);
      spacings.push({ dx: b.x - a.x, speed: s.speed, fast: prev.speed === FRENZY_SPEED && s.speed === FRENZY_SPEED });
    }
  }
  const fast = spacings.filter(sp => sp.fast);
  assert.ok(fast.length >= 2, `全速衝刺期間至少要量到兩段間距（${JSON.stringify(spacings)}）`);
  assert.ok(spacings.some(sp => sp.speed === 1), '也要量到衝刺結束後的間距');
  for (const { dx, speed } of spacings) {
    // 生成時機只能落在步與步之間，誤差最多一步的位移（1.6 倍時 3.52px）
    assert.ok(Math.abs(dx - SPAWN_SPACING) <= PIPE_SPEED * FRENZY_SPEED + 1e-6, `速度 ${speed} 時間距 ${dx}`);
  }
});

// ---------------------------------------------------------------------------
// I. 存讀檔擴充
// ---------------------------------------------------------------------------

test('新欄位存檔往返：pagehide 後重新載入完全還原', () => {
  const first = bootSave(validSave({
    score: 12,
    passCount: 12,
    itemPending: true,
    frenzy: 120,
    speed: 1.3,
    spawnTimer: 10,
    cat: { y: 300, vy: -2, rot: -10 },
    pipes: [
      { x: 10, gapY: 200, passed: true, variant: 'drawer', item: null, brokenTop: true, brokenBottom: false },
      { x: 240, gapY: 300, passed: false, variant: 'plant', item: 'can', brokenTop: false, brokenBottom: true },
      { x: 420, gapY: 420, passed: false, variant: 'post', item: 'grass' }
    ]
  }));
  first.key('ArrowUp');
  for (let i = 0; i < 5; i++) first.step(330);
  first.pagehide();
  const before = first.snap();
  assert.equal(before.state, 'PAUSED');
  assert.ok(before.ghosts > 0);

  const saved = first.readJson(KEYS.state);
  assert.equal(saved.v, 1);
  assert.equal(saved.passCount, 12);
  assert.equal(saved.itemPending, true);
  assert.equal(saved.frenzy, 115);
  assert.equal(typeof saved.speed, 'number');
  assert.deepEqual(saved.pipes.map(p => [p.variant, p.item, p.brokenTop, p.brokenBottom]), [
    ['drawer', null, true, false],
    ['plant', 'can', false, true],
    ['post', 'grass', false, false]
  ]);

  const second = boot({ storage: first.storage });
  const after = second.snap();
  assert.equal(after.state, 'PAUSED');
  for (const key of ['score', 'passCount', 'itemPending', 'speed', 'frenzyMs', 'invincible', 'catY', 'catVy', 'pipes']) {
    assert.deepEqual(after[key], before[key], `${key} 沒有還原`);
  }
  assert.deepEqual(after.obstacles, before.obstacles);
  assert.deepEqual(after.items, before.items);
  assert.equal(after.ghosts, 0, '殘影不存檔，續玩後重新取樣');

  second.key('Space');
  const resumed = second.step();
  assert.equal(resumed.invincible, true);
  assert.equal(resumed.ghosts, 1);
});

test('沒有新欄位的舊存檔照樣載入並補預設值', () => {
  const game = bootSave(validSave());
  const s = game.snap();
  assert.equal(s.state, 'PAUSED');
  assert.equal(s.passCount, 5, '舊存檔的累計通過數以分數補上');
  assert.equal(s.itemPending, false);
  assert.equal(s.frenzyMs, 0);
  assert.equal(s.invincible, false);
  assert.equal(s.speed, 1);
  assert.equal(s.ghosts, 0);
  assert.deepEqual(s.obstacles, [
    { x: 220, gapY: 300, variant: 'post', item: null, brokenTop: false, brokenBottom: false, passed: false }
  ]);
  assert.deepEqual(s.items, []);

  game.key('Space');
  game.step(330);
  game.pagehide();
  const upgraded = game.readJson(KEYS.state);
  assert.equal(upgraded.passCount, 5);
  assert.equal(upgraded.pipes[0].variant, 'post');
  assert.equal(upgraded.pipes[0].item, null);
});

test('新欄位型別錯誤或列舉值未知時整包丟棄', () => {
  const pipe = extra => ({ pipes: [{ x: 220, gapY: 300, passed: false, ...extra }] });
  const broken = [
    { passCount: '3' },
    { passCount: null },
    { passCount: true },
    { frenzy: null },
    { frenzy: '150' },
    { speed: 'x' },
    { speed: false },
    { itemPending: 1 },
    { itemPending: 'true' },
    { itemPending: null },
    pipe({ variant: 'sofa' }),
    pipe({ variant: null }),
    pipe({ variant: 2 }),
    pipe({ item: 'fish' }),
    pipe({ item: false }),
    pipe({ item: 0 }),
    pipe({ brokenTop: 'yes' }),
    pipe({ brokenTop: null }),
    pipe({ brokenBottom: 1 })
  ];
  broken.forEach((extra) => {
    const game = bootSave(validSave(extra));
    assert.equal(game.snap().state, 'READY', `${JSON.stringify(extra)} 不該被載入`);
    assert.equal(game.storage.data.has(KEYS.state), false, `${JSON.stringify(extra)} 應被刪掉`);
  });
});

test('新欄位數值超出範圍會被夾回', () => {
  const cases = [
    [{ frenzy: 999 }, s => s.frenzyMs === 3000 && s.invincible],
    [{ frenzy: -5 }, s => s.frenzyMs === 0 && !s.invincible],
    [{ frenzy: 150.7 }, s => s.frenzyMs === 2500],
    [{ speed: 5 }, s => s.speed === FRENZY_SPEED],
    [{ speed: 0.2 }, s => s.speed === 1],
    [{ speed: -3 }, s => s.speed === 1],
    [{ passCount: -3 }, s => s.passCount === 0],
    [{ passCount: 7.8 }, s => s.passCount === 7]
  ];
  cases.forEach(([extra, check]) => {
    const s = bootSave(validSave(extra)).snap();
    assert.equal(s.state, 'PAUSED', `${JSON.stringify(extra)} 應該夾回後載入`);
    assert.ok(check(s), `${JSON.stringify(extra)} 夾回結果不對：${JSON.stringify(s)}`);
  });
});

// ---------------------------------------------------------------------------
// J. Squash & Stretch
// ---------------------------------------------------------------------------

const expectedPose = s => (s.catVy < 0 ? 'stretch' : s.catVy > 4 ? 'ball' : s.catVy > 0 ? 'squash' : 'idle');

test('蹬跳後立刻伸展，數步內拉長到 0.8 × 1.25', () => {
  const game = boot();
  game.key('Space');
  assert.equal(game.snap().catPose, 'stretch', '蹬下去的當下就要伸展');
  let minSx = Infinity;
  let maxSy = -Infinity;
  for (let i = 0; i < 10; i++) {
    const s = game.step();
    assert.ok(s.catVy < 0);
    assert.equal(s.catPose, 'stretch');
    assert.ok(s.catSx >= 0.8 - 1e-9 && s.catSy <= 1.25 + 1e-9, '伸展不能超過 0.8 × 1.25');
    minSx = Math.min(minSx, s.catSx);
    maxSy = Math.max(maxSy, s.catSy);
  }
  assert.ok(minSx <= 0.81, `水平應縮到約 0.8（實際 ${minSx}）`);
  assert.ok(maxSy >= 1.24, `垂直應拉到約 1.25（實際 ${maxSy}）`);
});

test('持續下墜時壓扁到 1.25 × 0.8，速度超過 4 縮成肉球', () => {
  const game = boot();
  game.key('Space');
  let fullSquash = 0;
  let sawSquash = false;
  let sawBall = false;
  let checked = false;
  for (let i = 0; i < 300; i++) {
    const s = game.step();
    if (s.state !== 'PLAYING') break;
    assert.equal(s.catPose, expectedPose(s), `vy=${s.catVy} 時姿勢應為 ${expectedPose(s)}`);
    assert.ok(s.catSx >= 0.8 - 1e-9 && s.catSx <= 1.25 + 1e-9 && s.catSy >= 0.8 - 1e-9 && s.catSy <= 1.25 + 1e-9);
    if (s.catPose === 'squash') sawSquash = true;
    if (s.catPose === 'ball') sawBall = true;
    fullSquash = s.catVy >= 3 ? fullSquash + 1 : 0;
    if (fullSquash >= 10) {
      assert.ok(Math.abs(s.catSx - 1.25) <= 0.01, `catSx=${s.catSx}`);
      assert.ok(Math.abs(s.catSy - 0.8) <= 0.01, `catSy=${s.catSy}`);
      checked = true;
    }
  }
  assert.ok(sawSquash && sawBall && checked);
  const over = game.snap();
  assert.equal(over.state, 'GAMEOVER');
  game.advance(300);
  assert.equal(game.snap().catPose, 'squash', '落地結算維持蜷縮');
});

test('形變量跟著速度大小走：慢慢下墜只微微壓扁，速度到 3 以上才壓到 1.25 × 0.8', () => {
  // 存檔載入時 S&S 直接跳到目標值：vy 0.6 → t = 0.2
  const slow = bootSave(validSave({ cat: { y: 300, vy: 0.6, rot: 0 } })).snap();
  assert.ok(Math.abs(slow.catSx - 1.05) < 1e-9 && Math.abs(slow.catSy - 0.96) < 1e-9, `vy 0.6：${slow.catSx} × ${slow.catSy}`);
  const rise = bootSave(validSave({ cat: { y: 300, vy: -1.5, rot: 0 } })).snap();
  assert.ok(Math.abs(rise.catSx - 0.9) < 1e-9 && Math.abs(rise.catSy - 1.125) < 1e-9, `vy −1.5：${rise.catSx} × ${rise.catSy}`);
  const fast = bootSave(validSave({ cat: { y: 300, vy: 5, rot: 0 } })).snap();
  assert.equal(fast.catSx, 1.25);
  assert.equal(fast.catSy, 0.8);
});

// 回歸：經典主題的貓原本只會跟著 cat.rot 旋轉，沒有跳躍伸展與縮成肉球的動態，跟像素主題不同步
test('經典主題跟像素主題同步：依姿勢套用同樣的形變，不再拿 cat.rot 旋轉整隻貓', () => {
  const tilt = 60 * Math.PI / 180;
  for (const [vy, pose] of [[-6, 'stretch'], [3.5, 'squash'], [6, 'ball']]) {
    const game = bootSave(validSave({ cat: { y: 300, vy, rot: 60 } }), { pref: { style: 'classic' } });
    game.tick();
    const s = game.snap();
    assert.equal(s.theme, 'classic');
    assert.equal(s.catPose, pose);
    // 球只保留 35% 形變，跟像素貓一樣維持圓形
    const keep = pose === 'ball' ? 0.35 : 1;
    const want = [1 + (s.catSx - 1) * keep, 1 + (s.catSy - 1) * keep];
    const scales = game.ops.filter(op => op.op === 'scale');
    assert.ok(
      scales.some(op => Math.abs(op.args[0] - want[0]) < 1e-9 && Math.abs(op.args[1] - want[1]) < 1e-9),
      `${pose}：經典貓要以 ${want.join(' × ')} 縮放（實際 ${JSON.stringify(scales.map(op => op.args))}）`
    );
    const rotations = game.ops.filter(op => op.op === 'rotate');
    assert.ok(!rotations.some(op => Math.abs(op.args[0] - tilt) < 1e-6), `${pose}：不該再用存檔的 rot 旋轉整隻貓`);
  }
});

test('READY 維持 1 × 1 的待機姿勢，回到 READY 立刻復原', () => {
  const game = boot();
  for (let i = 0; i < 60; i++) {
    const s = game.step();
    assert.equal(s.catPose, 'idle');
    assert.equal(s.catSx, 1);
    assert.equal(s.catSy, 1);
  }
  game.key('Space');
  game.runUntil(s => s.state === 'GAMEOVER', 5000);
  game.advance(500);
  game.key('Space');
  const s = game.snap();
  assert.equal(s.state, 'READY');
  assert.equal(s.catPose, 'idle');
  assert.equal(s.catSx, 1);
  assert.equal(s.catSy, 1);
});

// ---------------------------------------------------------------------------
// K. 靜態契約（主題分區與設定）
// ---------------------------------------------------------------------------

test('主題程式碼分區標記齊全且正確巢狀', () => {
  const { regions } = parseRegions(source);
  const expected = {
    'theme:classic': null,
    'classic:fx': 'theme:classic',
    'theme:pixel16': null,
    'pixel:bg': 'theme:pixel16',
    'pixel:furn': 'theme:pixel16',
    'pixel:cat': 'theme:pixel16',
    'pixel:fx': 'theme:pixel16'
  };
  for (const [name, parent] of Object.entries(expected)) {
    assert.ok(regions.has(name), `缺少 // #region ${name}`);
    assert.equal(regions.get(name).parent, parent, `${name} 應該位於 ${parent || '最外層'}`);
  }
  assert.ok(regions.get('theme:classic').end < regions.get('theme:pixel16').start, '經典區在像素區之前且不重疊');
});

test('像素主題區只用矩形不畫曲線；兩個主題區都不用亂數', () => {
  const { text } = parseRegions(source);
  const pixel = stripComments(text('theme:pixel16'));
  const classic = stripComments(text('theme:classic'));
  assert.match(pixel, /function createPix\(/, '去註解不能把程式碼吃掉');
  assert.match(classic, /function drawCat\(/, '去註解不能把程式碼吃掉');
  const curves = {
    'arc(': /\barc\s*\(/,
    'arcTo(': /\barcTo\s*\(/,
    'ellipse(': /\bellipse\s*\(/,
    bezierCurveTo: /\bbezierCurveTo\b/,
    quadraticCurveTo: /\bquadraticCurveTo\b/,
    roundRect: /\broundRect\b/
  };
  for (const [name, pattern] of Object.entries(curves)) {
    assert.doesNotMatch(pixel, pattern, `像素主題區不能用 ${name}`);
  }
  for (const [name, body] of [['theme:classic', classic], ['theme:pixel16', pixel]]) {
    assert.doesNotMatch(body, /\bMath\.random\b/, `${name} 的繪製必須是決定性的（改用 hash01）`);
    assert.doesNotMatch(body, /\brand\s*\(/, `${name} 不能呼叫 rand()`);
  }
});

test('預設主題為 pixel16、縫隙 140，index.html 有風格鍵，計時不靠 setTimeout', () => {
  assert.match(source, /const GameConfig = \{[^}]*\bcurrentTheme:\s*'pixel16'/);
  const pipe = source.match(/const PIPE = Object\.freeze\(\{[\s\S]*?\}\);/);
  assert.ok(pipe, '找不到 PIPE 常數');
  assert.match(pipe[0], /\bgap:\s*140\b/);

  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const button = html.match(/<button\b[^>]*\bid="style-btn"[^>]*>/);
  assert.ok(button, 'index.html 缺少 #style-btn');
  assert.match(button[0], /\btype="button"/);
  assert.match(button[0], /\bclass="[^"]*\bhud-btn\b[^"]*"/);
  assert.match(button[0], /\baria-label="[^"]+"/);
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /\.style-btn\s*\{/);

  assert.doesNotMatch(stripComments(source), /\bset(Timeout|Interval)\s*\(/, '計時一律用模擬步數');
});

test('Themes 策略表的兩個主題實作同一組繪製方法', () => {
  const table = source.match(/const Themes = Object\.freeze\(\{[\s\S]*?\n {2}\}\);/);
  assert.ok(table, '找不到 Themes 策略表');
  const split = table[0].indexOf('pixel16:');
  assert.ok(split > 0 && table[0].indexOf('classic:') < split);
  const parts = { classic: table[0].slice(0, split), pixel16: table[0].slice(split) };
  const methods = ['drawBackground', 'drawObstacles', 'drawItems', 'drawGround', 'drawPlayer', 'drawEffects'];
  for (const [name, body] of Object.entries(parts)) {
    for (const method of methods) {
      assert.match(body, new RegExp(`\\b${method}\\b\\s*[:,\\n]`), `${name} 缺少 ${method}`);
    }
  }
  assert.match(source, /Themes\[/, 'render() 要透過 Themes 表分派');
});

test('像素主題的畫布以最近鄰合成；舞台太窄時 HUD 會收窄，不會疊在一起', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  // 畫布 CSS 尺寸常是小數，瀏覽器合成時的雙線性縮放會在每條像素邊緣糊出一條混色
  assert.match(css, /\.stage\[data-style="pixel16"\]\s+#game-canvas\s*\{[^}]*image-rendering:\s*pixelated/);
  // 橫拿手機時舞台只有約 200px 寬：容器查詢讓回首頁只留箭頭
  assert.match(css, /\.stage\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(css, /@container\s*\(max-width:\s*\d+px\)\s*\{[\s\S]*?\.back-btn span\s*\{[^}]*display:\s*none/);

  // 上面的樣式靠舞台的 data-style 切換，JS 要跟著目前實際生效的主題寫
  const game = boot();
  assert.equal(game.stage.getAttribute('data-style'), 'pixel16');
  game.click(game.styleBtn);
  assert.equal(game.stage.getAttribute('data-style'), 'classic');
  assert.equal(boot({ offscreen: false }).stage.getAttribute('data-style'), 'classic');
});

// ---------------------------------------------------------------------------
// L. 像素緩衝區的實際內容（離屏畫布逐筆記錄 fillRect／drawImage）
// ---------------------------------------------------------------------------

test('像素分數真的畫進緩衝區：換分數只改到最後畫的分數區（第 35～50 列、水平置中）', () => {
  const save = validSave({ score: 7, passCount: 7, pipes: [] });
  const { a, b } = tailFromFirstDiff(pausedRects(save), pausedRects({ ...save, score: 8 }));
  assert.ok(a.length > 10 && b.length > 10, '分數的點陣字要畫進緩衝區');
  for (const r of [...a, ...b]) {
    assert.ok(r.y >= 35 && r.y + r.h <= 51, `換分數不該改到分數區以外：${rectKey(r)}`);
  }
  const box = boundsOf(b);
  assert.ok(Math.abs((box.x0 + box.x1) / 2 - 90) <= 1.5, `分數要水平置中：${JSON.stringify(box)}`);
});

test('雙層視差：牆面遠景以 0.3 倍速、地板以 1 倍速跟著捲動', () => {
  // 捲動 1000 → 1060：遠景位移 floor(1060×0.3/2) − floor(1000×0.3/2) = 9 格、地板 530 − 500 = 30 格
  const at = scroll => pausedRects(validSave({ scroll, cat: { y: 200, vy: 0, rot: 0 }, pipes: [] }));
  const before = at(1000);
  const after = new Set(at(1060).map(rectKey));
  const share = (pred, dx) => {
    const rects = before.filter(pred);
    return rects.filter(r => after.has(rectKey({ ...r, x: r.x - dx }))).length / rects.length;
  };
  // 牆面取貓（美術 y 84～116）與分數下方、踢腳板以上的區段；整排的橫條不會隨捲動改變，排除
  const wall = r => r.y >= 120 && r.y + r.h <= 282 && r.w < 180;
  const floor = r => r.y >= 291 && r.w < 180;
  assert.ok(share(wall, 9) > 0.7, `牆面擺設應該整體移動 9 格（${share(wall, 9)}）`);
  assert.ok(share(wall, 30) < 0.2, '牆面不能跟地板一樣快');
  assert.ok(share(floor, 30) > 0.7, `地板應該整體移動 30 格（${share(floor, 30)}）`);
  assert.ok(share(floor, 9) < 0.2, '地板不能跟遠景一樣慢');
});

test('像素貓真的依 S&S 變形與換姿勢：拉長時畫得更高更瘦、不同姿勢畫法不同、肉球維持圓形', () => {
  const catRects = vy => pausedRects(validSave({ cat: { y: 300, vy, rot: 0 }, pipes: [] })).filter(r => CAT_SILHOUETTE.has(r.color));
  const size = vy => {
    const box = boundsOf(catRects(vy));
    return { w: box.x1 - box.x0, h: box.y1 - box.y0 };
  };
  // 同樣是伸展姿勢：vy −0.3 幾乎不變形，vy −6 拉到 0.8 × 1.25
  const mild = size(-0.3);
  const full = size(-6);
  assert.ok(full.h >= mild.h * 1.15, `拉長後應該更高：${JSON.stringify({ mild, full })}`);
  assert.ok(full.w <= mild.w * 0.9, `拉長後應該更瘦：${JSON.stringify({ mild, full })}`);
  // 幾乎沒有形變時，待機（vy 0）與伸展（vy 稍微往上）仍是兩種畫法
  assert.notDeepEqual(catRects(-1e-6).map(rectKey), catRects(0).map(rectKey), '姿勢要真的換 sprite');
  assert.notDeepEqual(catRects(4.5).map(rectKey), catRects(3.5).map(rectKey), '縮成球與蜷縮要是兩種畫法');
  // 下墜很快時整體壓扁到 1.25 × 0.8，但肉球本身維持「緊繃的圓球」，不是扁麵包
  const ball = size(8);
  assert.ok(ball.w / ball.h <= 1.35, `肉球太扁：${ball.w}×${ball.h}`);
});

test('家具組合真的畫得不一樣，撞散的半截完全不畫', () => {
  const withPipe = extra => pausedRects(validSave({ pipes: [{ x: 200, gapY: 300, passed: false, ...extra }] }));
  const empty = pausedRects(validSave({ pipes: [] }));
  const block = extra => insertedRects(empty, withPipe(extra), JSON.stringify(extra));
  const plant = block({ variant: 'plant' });
  const post = block({ variant: 'post' });
  const drawer = block({ variant: 'drawer' });
  assert.ok(plant.some(r => r.color === MOSS), '組合 C 要畫出抹茶綠的吊盆藤蔓');
  assert.ok(!post.some(r => r.color === MOSS) && !drawer.some(r => r.color === MOSS), '貓抓柱與抽屜櫃不該有藤蔓');
  assert.notDeepEqual(post.map(rectKey), drawer.map(rectKey), '組合 A 與 B 要長得不一樣');

  // 縫隙 300 → 上緣 115、下緣 185（美術像素）
  const topOnly = block({ variant: 'drawer', brokenBottom: true });
  assert.ok(topOnly.every(r => r.y + r.h <= 115), '撞散下半截後，縫隙下方不能再畫任何東西');
  const bottomOnly = block({ variant: 'drawer', brokenTop: true });
  assert.ok(bottomOnly.every(r => r.y >= 185), '撞散上半截後，縫隙上方不能再畫任何東西');
  assert.deepEqual(withPipe({ variant: 'plant', brokenTop: true, brokenBottom: true }).map(rectKey), empty.map(rectKey),
    '上下都撞散的家具整組不畫');
});

test('道具畫在縫隙正中央：緩衝區裡量得到的道具中心就是 (障礙物 x + 32, 縫隙中心)', () => {
  const save = item => validSave({ cat: { y: 480, vy: 0, rot: 0 }, pipes: [{ x: 200, gapY: 300, passed: false, variant: 'post', item }] });
  const box = boundsOf(insertedRects(pausedRects(save(null)), pausedRects(save('can')), '罐頭'));
  const cx = ((box.x0 + box.x1) / 2) * PX;
  const cy = ((box.y0 + box.y1) / 2) * PX;
  // 浮動 ±3px、取整到美術像素，再加上閃光讓外框略為不對稱：容許 3 個虛擬像素
  assert.ok(Math.abs(cx - (200 + PIPE_HALF_W)) <= 3, `道具中心 x=${cx}，應為 ${200 + PIPE_HALF_W}`);
  assert.ok(Math.abs(cy - 300) <= 3 + 3, `道具中心 y=${cy}，應為 300（±3 浮動）`);
});

test('家具腳跟地板接縫一起捲動：同一組家具底下的接縫不會左右抖 1 格', () => {
  const CONTACT_SHADOW = 'rgba(40, 26, 16, 0.28)';
  for (const scroll of [0, 37.3, 91.9]) {
    const game = bootSave(validSave({ scroll, cat: { y: 315, vy: 0, rot: 0 }, pipes: [{ x: 300, gapY: 300, passed: false }] }), { draws: true });
    game.key('ArrowUp');
    const offsets = new Set();
    for (let i = 0; i < 80; i++) {
      game.step(330);
      const rects = bufferRects(game);
      // 柱腳貼地的接觸陰影（第 289 列、寬 24）當家具腳的位置
      const leg = rects.find(r => r.y === 289 && r.h === 1 && r.w === 24 && r.color === CONTACT_SHADOW);
      assert.ok(leg, `第 ${i} 幀找不到家具腳`);
      for (const r of rects) {
        if (r.color === FLOOR_SEAM && r.w === 1 && r.y === 291) offsets.add((((r.x - leg.x) % 240) + 240) % 240);
      }
    }
    assert.ok(offsets.size >= 3, '應該量到好幾條接縫');
    for (const v of offsets) {
      assert.ok(!offsets.has((v + 1) % 240), `捲動 ${scroll}：接縫相對家具腳在 ${v} 與 ${v + 1} 之間來回跳`);
    }
  }
});

test('家具畫在碰撞框上：柱腳跟碰撞框的柱身左緣差不到 1 個美術像素，整體也不會往同一邊偏', () => {
  const CONTACT_SHADOW = 'rgba(40, 26, 16, 0.28)';
  // 柱腳貼地的接觸陰影（第 289 列、寬 24 = 柱身）對碰撞框的柱身左緣 x + 8。測試時鐘的插值 alpha 幾乎是 0，
  // 畫出來的是這一步之前的位置（上一張快照的 x）。障礙物 x 與捲動量的小數部分都要涵蓋到：
  // 世界座標 (x + scroll) / 2 的小數決定家具的取整方向，捲動量的小數決定地板換格的時機
  let sum = 0;
  let count = 0;
  for (const scroll of [0, 37.3, 91.9, 120.5]) {
    for (const x of [300, 300.4, 300.8, 301.2, 301.6]) {
      const game = bootSave(validSave({ scroll, cat: { y: 315, vy: 0, rot: 0 }, pipes: [{ x, gapY: 300, passed: false }] }), { draws: true });
      game.key('ArrowUp');
      let prevX = game.snap().obstacles[0].x;
      for (let i = 0; i < 60; i++) {
        const s = game.step(330);
        assert.equal(s.state, 'PLAYING');
        const leg = bufferRects(game).find(r => r.y === 289 && r.h === 1 && r.w === 24 && r.color === CONTACT_SHADOW);
        assert.ok(leg, `捲動 ${scroll}、x ${x}：第 ${i} 幀找不到家具腳`);
        const err = leg.x * PX - (prevX + 8);
        assert.ok(Math.abs(err) <= PX + 1e-6,
          `捲動 ${scroll}、x ${x}：第 ${i} 幀柱腳畫在 ${leg.x * PX}，碰撞框在 ${(prevX + 8).toFixed(2)}，差超過 1 格`);
        sum += err;
        count += 1;
        prevX = s.obstacles[0].x;
      }
    }
  }
  // 取整誤差應該左右平均；整體偏一邊，玩家就會在看得到的木頭前「撞到空氣」、或擦過木頭卻沒事
  const mean = sum / count;
  assert.ok(Math.abs(mean) <= 0.5, `家具整體往${mean > 0 ? '右' : '左'}偏了 ${Math.abs(mean).toFixed(2)}px`);
});

test('衝刺畫面：每幀 3 道殘影錯開排在貓後方、貓換成彩虹色、計量條在分數下方；淡出後全部收掉', () => {
  const game = bootPickup({ draws: true });
  const meter = rects => rects.some(r => r.x === 69 && r.y === 57 && r.w === 42 && r.h === 6);
  let s = game.snap();
  let lastFade = Infinity;
  let fadeFrames = 0;
  let calmFrames = 0;
  for (let i = 0; i < 400 && calmFrames < 5; i++) {
    const blits = ghostBlits(game);
    const rects = bufferRects(game);
    if (s.invincible) {
      assert.equal(blits.length, 3, `衝刺中第 ${i} 幀應該有 3 道殘影`);
      const xs = blits.map(b => b.args[0] + 32);
      assert.equal(new Set(xs).size, 3, `3 道殘影要依落後步數錯開：${xs}`);
      assert.ok(xs.every(x => x < 50), `殘影要在貓（美術 x 50）後方：${xs}`);
      // 由遠到近畫：越後面的越淡，本尊前面那道最濃
      assert.ok(blits[0].alpha < blits[1].alpha && blits[1].alpha < blits[2].alpha);
      assert.ok(!rects.some(r => r.color === CAT_BODY), '衝刺中黑貓要換成彩虹色');
      assert.ok(meter(rects), '衝刺中要畫計量條');
    } else if (s.speed > 1) {
      // 淡出：殘影照畫，但一幀比一幀淡；計量條已經收起來
      assert.equal(blits.length, 3, `淡出第 ${fadeFrames} 幀殘影不見了`);
      const strongest = Math.max(...blits.map(b => b.alpha));
      assert.ok(strongest < lastFade, '殘影要一幀比一幀淡');
      lastFade = strongest;
      fadeFrames += 1;
      assert.ok(!meter(rects));
    } else {
      assert.equal(blits.length, 0, '淡出結束後不再畫殘影');
      assert.ok(rects.some(r => r.color === CAT_BODY), '淡出結束後貓變回墨黑');
      assert.ok(!meter(rects));
      calmFrames += 1;
    }
    s = game.step(345);
    assert.equal(s.state, 'PLAYING');
  }
  assert.ok(fadeFrames >= 20, `淡出應該持續約 30 幀（實際 ${fadeFrames}）`);
  assert.equal(calmFrames, 5);
});

test('經典主題的彩虹貓只靠上色轉色相，不用 ctx.filter（軟體繪圖時一次濾鏡就要好幾毫秒）', () => {
  const game = bootPickup({ draws: true, pref: { style: 'classic' } });
  assert.equal(game.snap().theme, 'classic');
  const layer = game.layers.find(l => l !== pixelBufferOf(game) && l !== ghostLayerOf(game));
  const hues = new Set();
  for (let i = 0; i < 60; i++) {
    game.step(345);
    assert.ok(!game.ops.some(op => op.op === 'filter'), `第 ${i} 幀設定了 ctx.filter`);
    for (const d of layer.draws) {
      const m = d.op === 'fillRect' && /^hsl\((\d+), 95%, 58%\)$/.exec(String(d.color));
      if (m) hues.add(Number(m[1]));
    }
  }
  assert.ok(hues.size >= 20, `上色的色相要一路轉：${[...hues].join(', ')}`);
});

test('減少動態：衝刺計量條最後 1/4 固定成提醒色不閃；一般設定下的提醒閃爍也不超過每秒約 2 次', () => {
  const frameColors = (reduceMotion) => {
    const game = bootSave(validSave({ frenzy: 60, speed: FRENZY_SPEED, cat: { y: 315, vy: 0, rot: 0 }, pipes: [] }), { draws: true, reduceMotion });
    game.key('ArrowUp');
    const colors = [];
    for (let i = 0; i < 80; i++) {
      const s = game.step(345);
      if (!s.invincible) break;
      const frame = bufferRects(game).find(r => r.x === 69 && r.y === 57 && r.w === 42 && r.h === 6);
      colors.push(frame ? frame.color : null);
    }
    return colors;
  };
  const runs = (colors) => {
    const out = [];
    for (const c of colors) {
      if (out.length && out[out.length - 1].color === c) out[out.length - 1].n += 1;
      else out.push({ color: c, n: 1 });
    }
    return out;
  };
  const calm = runs(frameColors(true));
  assert.equal(calm.length, 2, `減少動態時只該換一次色（一般 → 提醒）：${JSON.stringify(calm)}`);
  const normal = runs(frameColors(false));
  assert.ok(normal.length >= 3, `一般設定下最後 1/4 要閃爍提醒：${JSON.stringify(normal)}`);
  // 中間每一段（不含頭尾）至少維持 12 幀：切換間隔 ≥ 0.2 秒
  normal.slice(1, -1).forEach(run => assert.ok(run.n >= 12, `提醒閃得太快：${JSON.stringify(normal)}`));
});

// WCAG 相對亮度與對比值；半透明色先以白底合成
function relativeLuminance(color) {
  let rgb = null;
  let m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) {
    rgb = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  } else if ((m = /^#([0-9a-f]{3})$/i.exec(color))) {
    rgb = [...m[1]].map(h => parseInt(h + h, 16));
  } else if ((m = /^rgba?\(([^)]+)\)$/.exec(color))) {
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    rgb = [r, g, b].map(v => v * a + 255 * (1 - a));
  }
  assert.ok(rgb, `看不懂的顏色：${color}`);
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('衝刺計量條最後 1/4 的提醒色跟空軌道對比夠高：兩種主題都不會看起來像已經見底', () => {
  // 像素：軌道是 (70, 58) 起 40×4 的矩形，緊接著畫的第一段就是液面；框（69, 57, 42×6）換色代表提醒中。
  // 經典：主畫布上 rect(0, 0, 104 × 剩餘比例, 10) 之後的 fill 是液面，它之前的 fill 是軌道；液面平常是彩虹漸層，提醒時是單色
  const meterColors = (game, style, left) => {
    if (style === 'pixel16') {
      const rects = bufferRects(game);
      const at = rects.findIndex(r => r.x === 70 && r.y === 58 && r.w === 40 && r.h === 4);
      const frame = rects.find(r => r.x === 69 && r.y === 57 && r.w === 42 && r.h === 6);
      assert.ok(at >= 0 && frame, '找不到像素計量條');
      assert.equal(rects[at + 1].x, 70);
      return { track: rects[at].color, fill: rects[at + 1].color, frame: frame.color };
    }
    const paths = game.paths;
    const at = paths.findIndex(p => p.op === 'rect' && p.args[0] === 0 && p.args[1] === 0 && p.args[3] === 10
      && Math.abs(p.args[2] - 104 * left / FRENZY_STEPS) < 1e-6);
    assert.ok(at > 0, '找不到經典計量條的液面');
    assert.equal(paths[at - 1].op, 'fill');
    assert.equal(paths[at + 1].op, 'fill');
    return { track: paths[at - 1].color, fill: paths[at + 1].color, frame: typeof paths[at + 1].color };
  };
  for (const style of ['pixel16', 'classic']) {
    for (const reduceMotion of [true, false]) {
      const label = `${style}${reduceMotion ? '（減少動態）' : ''}`;
      const game = bootSave(validSave({ frenzy: 60, speed: FRENZY_SPEED, cat: { y: 315, vy: 0, rot: 0 }, pipes: [] }),
        { draws: true, paths: true, reduceMotion, pref: { style } });
      game.key('ArrowUp');
      let calmFrame = null;
      let lastQuarter = 0;
      let warned = 0;
      for (let i = 0; i < 80; i++) {
        const s = game.step(345);
        if (!s.invincible) break;
        assert.equal(s.theme, style);
        const left = Math.round(s.frenzyMs / STEP_MS);
        const colors = meterColors(game, style, left);
        if (left >= FRENZY_STEPS / 4) {
          calmFrame = colors.frame;
          continue;
        }
        lastQuarter += 1;
        if (colors.frame === calmFrame) continue;
        warned += 1;
        assert.equal(typeof colors.fill, 'string', `${label}：提醒時液面要是單色`);
        const ratio = contrastRatio(colors.fill, colors.track);
        assert.ok(ratio >= 3, `${label}：剩 ${left} 步時液面 ${colors.fill} 對軌道 ${colors.track} 只有 ${ratio.toFixed(2)}:1，看起來像已經見底`);
      }
      assert.ok(calmFrame !== null && lastQuarter >= 30, `${label}：應該量到計量條的一般時段與最後 1/4`);
      if (reduceMotion) assert.equal(warned, lastQuarter, `${label}：減少動態時最後 1/4 整段都是提醒色`);
      else assert.ok(warned > 0 && warned < lastQuarter, `${label}：一般設定下最後 1/4 要閃爍提醒（${warned}/${lastQuarter}）`);
    }
  }
});
