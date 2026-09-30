// 貓咪跳箱（cat-agility）測試。
//
// 遊戲是單一 IIFE、一載入就碰 canvas 與 localStorage，沒有可以 require 的純邏輯核心。
// 所以這裡用 vm 把真正的 cat-agility.js 跑在一個假 DOM 裡：
//   - requestAnimationFrame 與 performance.now 都由測試掌控，物理以固定 60 步／秒推進，
//     同樣的輸入必然得到同樣的結果
//   - Math.random 固定，柱子空隙的位置可預測
//   - 2D context 是記錄 fillText 的 Proxy，用來驗證畫面文字的位置
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

  querySelector() {
    return { textContent: '' };
  }

  closest(selector) {
    return selector.split(',').map(s => s.trim()).includes(this.tag) ? this : null;
  }

  blur() {}
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

function createContext2d(texts) {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (key === 'fillText') return (text, x, y) => texts.push({ text: String(text), x, y });
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    }
  });
}

function boot({ storage = createStorage(), random = () => 0.5 } = {}) {
  let clock = 1000;
  let frame = null;
  const texts = [];

  const canvas = new FakeElement('game-canvas', 'canvas');
  canvas.width = 0;
  canvas.height = 0;
  canvas.getContext = () => createContext2d(texts);
  canvas.getBoundingClientRect = () => ({ width: 360, height: 640 });
  const soundBtn = new FakeElement('sound-btn', 'button');
  const status = new FakeElement('game-status', 'p');
  const elements = { 'game-canvas': canvas, 'sound-btn': soundBtn, 'game-status': status };

  const doc = new FakeElement('document');
  doc.visibilityState = 'visible';
  doc.body = new FakeElement('body', 'body');
  doc.documentElement = { dataset: {} };
  doc.getElementById = id => elements[id] || null;

  const win = new FakeElement('window');
  win.devicePixelRatio = 1;
  win.matchMedia = () => ({ matches: false, addEventListener() {} });

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
    __random: random
  };
  vm.createContext(sandbox);
  vm.runInContext('Math.random = () => __random();', sandbox);
  vm.runInContext(source, sandbox, { filename: 'cat-agility.js' });

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

  const snap = () => win.CatAgility.snapshot();

  // 推進一個畫面（約一步物理）；回傳這一幀畫出來的文字
  const tick = () => {
    clock += STEP_MS;
    const fn = frame;
    frame = null;
    texts.length = 0;
    fn(clock);
    return texts.slice();
  };

  const game = {
    snap,
    storage,
    status,
    soundBtn,
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
    key: (code, extra = {}) => fire(win, 'keydown', { code, ...extra }),
    tap: (extra = {}) => fire(canvas, 'pointerdown', { pointerType: 'touch', button: 0, ...extra }),
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
