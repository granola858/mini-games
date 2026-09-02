const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MODES,
  SKINS,
  ACTION_MODES,
  DIFFICULTY_PRESETS,
  DUNGEON_FLOORS,
  createEmptyBoard,
  getNeighbors,
  populateMines,
  revealCell,
  chordCell,
  checkWinCondition
} = require('../games/minesweeper/minesweeper.js');

test('DIFFICULTY_PRESETS 與 DUNGEON_FLOORS 規格定義完整', () => {
  assert.ok(DIFFICULTY_PRESETS.easy.rows === 9 && DIFFICULTY_PRESETS.easy.mines === 10);
  assert.ok(DIFFICULTY_PRESETS.medium.rows === 16 && DIFFICULTY_PRESETS.medium.mines === 40);
  assert.ok(DIFFICULTY_PRESETS.hard.rows === 16 && DIFFICULTY_PRESETS.hard.mines === 99);
  assert.ok(DIFFICULTY_PRESETS.inferno.doubleMines === true);

  assert.equal(DUNGEON_FLOORS.length, 5);
  DUNGEON_FLOORS.forEach((floor, idx) => {
    assert.equal(floor.floor, idx + 1);
    assert.ok(floor.mines > 0);
    assert.ok(floor.chests >= 2);
  });
});

test('createEmptyBoard 建立正確維度之初始盤面', () => {
  const grid = createEmptyBoard(9, 9);
  assert.equal(grid.length, 9);
  assert.equal(grid[0].length, 9);

  grid.forEach((row, r) => {
    row.forEach((cell, c) => {
      assert.equal(cell.row, r);
      assert.equal(cell.col, c);
      assert.equal(cell.isMine, false);
      assert.equal(cell.revealed, false);
      assert.equal(cell.flagged, false);
    });
  });
});

test('getNeighbors 回傳正確之角落、邊緣與中心鄰居數量', () => {
  const grid = createEmptyBoard(5, 5);

  // 角落 (0,0) 應有 3 個鄰居
  const cornerNeighbors = getNeighbors(grid, 0, 0);
  assert.equal(cornerNeighbors.length, 3);

  // 邊緣 (0,2) 應有 5 個鄰居
  const edgeNeighbors = getNeighbors(grid, 0, 2);
  assert.equal(edgeNeighbors.length, 5);

  // 中心 (2,2) 應有 8 個鄰居
  const centerNeighbors = getNeighbors(grid, 2, 2);
  assert.equal(centerNeighbors.length, 8);
});

test('populateMines 保證首次點擊 3x3 安全區零雷 (Zero-Safe Guarantee)', () => {
  for (let trial = 0; trial < 10; trial++) {
    const grid = createEmptyBoard(9, 9);
    const clickR = 4;
    const clickC = 4;
    populateMines(grid, 10, clickR, clickC);

    // 檢查點擊格及其周圍 8 格皆無地雷
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = clickR + dr;
        const c = clickC + dc;
        assert.equal(grid[r][c].isMine, false, `安全區 (${r},${c}) 出現了地雷！`);
      }
    }

    // 檢查總地雷數量正確
    let mineCount = 0;
    grid.forEach(row => row.forEach(cell => {
      if (cell.isMine) mineCount++;
    }));
    assert.equal(mineCount, 10);
  }
});

test('雙重地雷 (Double Mine) 正確為周圍格子累加 +2 數字', () => {
  const grid = createEmptyBoard(3, 3);
  // (1, 1) 放置 1 顆雙重地雷
  grid[1][1].isMine = true;
  grid[1][1].isDouble = true;

  // 計算數字
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (grid[r][c].isMine) continue;
      const neighbors = getNeighbors(grid, r, c);
      let count = 0;
      for (const n of neighbors) {
        if (n.isMine) count += n.isDouble ? 2 : 1;
      }
      grid[r][c].count = count;
    }
  }

  // 檢查周圍所有 8 格數字皆為 2
  const neighbors = getNeighbors(grid, 1, 1);
  assert.equal(neighbors.length, 8);
  neighbors.forEach(n => {
    assert.equal(n.count, 2, `格子 (${n.row}, ${n.col}) 數字應為 2，實際為 ${n.count}`);
  });
});

test('雙重地雷仍以實體地雷數生成，正確旗幟可滿足 +2 連開條件', () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const populated = createEmptyBoard(9, 9);
    populateMines(populated, 10, 4, 4, { allowDouble: true });
    const mines = populated.flat().filter(cell => cell.isMine);
    assert.equal(mines.length, 10, '總雷數應代表實體地雷格數');
    assert.ok(mines.every(cell => cell.isDouble), '固定亂數下應生成雙重雷');
  } finally {
    Math.random = originalRandom;
  }

  const grid = createEmptyBoard(3, 3);
  grid[1][1].isMine = true;
  grid[1][1].isDouble = true;
  grid[1][1].flagged = true;
  grid[0][0].revealed = true;
  grid[0][0].count = 2;

  const result = chordCell(grid, 0, 0);
  assert.equal(result.success, true);
  assert.equal(result.triggeredMine, false);
});

test('revealCell 正確遞迴展開 0-空白區域並包含邊界數字', () => {
  const grid = createEmptyBoard(3, 3);
  // 僅 (2, 2) 放置 1 顆雷，(0, 0) 是 0 空白
  grid[2][2].isMine = true;

  // 計算數字
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (grid[r][c].isMine) continue;
      const neighbors = getNeighbors(grid, r, c);
      grid[r][c].count = neighbors.filter(n => n.isMine).length;
    }
  }

  assert.equal(grid[0][0].count, 0);

  // 翻開 (0,0)
  const revealed = revealCell(grid, 0, 0);
  // (0,0) 會連鎖翻開所有除了 (2,2) 以外的安全格子 (共 8 格)
  assert.equal(revealed.length, 8);
  assert.equal(grid[2][2].revealed, false);
});

test('chordCell 當周圍旗幟數相符時正確觸發連開，旗幟不符時不動作', () => {
  const grid = createEmptyBoard(3, 3);
  // 設置 (0,1) 為地雷
  grid[0][1].isMine = true;
  grid[1][1].count = 1;
  grid[1][1].revealed = true;

  // 1. 未插旗時連開 -> 失敗
  const res1 = chordCell(grid, 1, 1);
  assert.equal(res1.success, false);

  // 2. 正確插旗後連開 -> 成功展開其餘 7 個鄰居
  grid[0][1].flagged = true;
  const res2 = chordCell(grid, 1, 1);
  assert.equal(res2.success, true);
  assert.equal(res2.triggeredMine, false);

  // 3. (0,0), (0,2), (1,0), (1,2), (2,0), (2,1), (2,2) 皆被翻開
  assert.equal(grid[0][0].revealed, true);
  assert.equal(grid[2][2].revealed, true);
  assert.equal(grid[0][1].revealed, false); // 旗幟保護
});

test('checkWinCondition 正確判斷勝利狀態', () => {
  const grid = createEmptyBoard(2, 2);
  grid[0][0].isMine = true;
  grid[0][1].revealed = true;
  grid[1][0].revealed = true;
  grid[1][1].revealed = false;

  // 尚有 (1,1) 未翻開
  assert.equal(checkWinCondition(grid), false);

  // (1,1) 翻開 -> 勝利
  grid[1][1].revealed = true;
  assert.equal(checkWinCondition(grid), true);
});

test('地宮模式 (Dungeon) 元素分配：階梯、寶箱與金幣格正確生成', () => {
  const grid = createEmptyBoard(8, 8);
  populateMines(grid, 8, 0, 0, { chests: 2, goldTiles: 2, hasStair: true });

  let stairCount = 0;
  let chestCount = 0;
  let goldCount = 0;

  grid.forEach(row => row.forEach(cell => {
    if (cell.isStair) stairCount++;
    if (cell.isChest) chestCount++;
    if (cell.isGold) goldCount++;
  }));

  assert.equal(stairCount, 1, '階梯應剛好有 1 個');
  assert.equal(chestCount, 2, '寶箱應有 2 個');
  assert.equal(goldCount, 2, '金幣格應有 2 個');
});

test('首次挖掘前不可啟動會讀取地雷配置的戰術道具', () => {
  const app = Object.create(require('../games/minesweeper/minesweeper.js').MinesweeperApp.prototype);
  const messages = [];
  Object.assign(app, {
    gameOver: false,
    gameWon: false,
    firstClick: true,
    activeItem: null,
    radars: 1,
    showToast: message => messages.push(message),
    updateActiveItemUI: () => {}
  });

  app.handleItemClick('radar');
  assert.equal(app.activeItem, null);
  assert.equal(app.radars, 1);
  assert.match(messages[0], /先挖開第一格/);
});

test('載入進行中戰局會保留計時並同步控制狀態', () => {
  const { MinesweeperApp } = require('../games/minesweeper/minesweeper.js');
  const originalStorage = global.localStorage;
  const savedGrid = createEmptyBoard(2, 2);
  global.localStorage = {
    getItem: () => JSON.stringify({
      mode: MODES.DUNGEON,
      difficulty: 'easy',
      rows: 2,
      cols: 2,
      totalMines: 1,
      timer: 42,
      grid: savedGrid
    })
  };

  try {
    const app = Object.create(MinesweeperApp.prototype);
    app.el = { modeTabs: [], diffBtns: [], actionBtns: [] };
    app.timerInterval = null;
    app.action = ACTION_MODES.DIG;
    app.renderBoard = () => {};
    app.updateHUD = () => {};
    app.showToast = () => {};

    assert.equal(app.loadGameState(), true);
    assert.equal(app.timer, 42);
    assert.equal(app.mode, MODES.DUNGEON);
  } finally {
    global.localStorage = originalStorage;
  }
});

test('地宮重開會建立新冒險，跨層時則保留冒險資源', () => {
  const { MinesweeperApp } = require('../games/minesweeper/minesweeper.js');
  const app = Object.create(MinesweeperApp.prototype);
  Object.assign(app, {
    el: { modeTabs: [], diffBtns: [], actionBtns: [] },
    mode: MODES.DUNGEON,
    difficulty: 'medium',
    action: ACTION_MODES.DIG,
    currentFloor: 4,
    maxHp: 5,
    hp: 1,
    gold: 80,
    shields: 3,
    radars: 2,
    detectors: 1,
    defusers: 1,
    timerInterval: null,
    shopTimer: null,
    renderBoard: () => {},
    updateHUD: () => {},
    clearGameState: () => {},
    updateActiveItemUI: () => {},
    closeShopModal: () => {}
  });

  app.startNewGame();
  assert.deepEqual(
    { floor: app.currentFloor, hp: app.hp, maxHp: app.maxHp, gold: app.gold, shields: app.shields, radars: app.radars },
    { floor: 1, hp: 3, maxHp: 3, gold: 0, shields: 0, radars: 0 }
  );

  Object.assign(app, { currentFloor: 2, hp: 2, maxHp: 4, gold: 70, shields: 1, radars: 2 });
  app.startNewGame({ preserveDungeonRun: true });
  assert.deepEqual(
    { floor: app.currentFloor, hp: app.hp, maxHp: app.maxHp, gold: app.gold, shields: app.shields, radars: app.radars },
    { floor: 2, hp: 2, maxHp: 4, gold: 70, shields: 1, radars: 2 }
  );

  app.mode = MODES.CLASSIC;
  app.shields = 3;
  app.radars = 2;
  app.startNewGame();
  assert.equal(app.shields, 0, '經典模式不得沿用護盾');
  assert.equal(app.radars, 0, '經典模式不得沿用戰術道具');
});

test('頁面只記錄一次遊玩，關閉彈窗不留在鍵盤導覽樹', () => {
  const htmlPath = path.join(__dirname, '..', 'games', 'minesweeper', 'index.html');
  const jsPath = path.join(__dirname, '..', 'games', 'minesweeper', 'minesweeper.js');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  assert.equal((html + js).match(/Stats\.recordGamePlay\('minesweeper'\)/g)?.length, 1);
  assert.equal((html.match(/class="modal-overlay"[^>]*\shidden/g) || []).length, 4);
  assert.match(js, /document\.createElement\('button'\)/);
  assert.doesNotMatch(js, /bindCellEvents\(/);
});

test('純粹經典模式會套用 Windows 95 復古皮膚並同步標題', () => {
  const { MinesweeperApp, SKINS, SKIN_TITLES } = require('../games/minesweeper/minesweeper.js');
  const app = Object.create(MinesweeperApp.prototype);
  const skinBtn = { innerHTML: '', style: {} };
  const titleText = { textContent: '' };
  const titleBadge = { textContent: '' };

  Object.assign(app, {
    el: { modeTabs: [], diffBtns: [], actionBtns: [], skinToggleBtn: skinBtn, titleText, titleBadge },
    mode: MODES.TACTICAL,
    skin: SKINS.TACTICAL,
    difficulty: 'medium',
    action: ACTION_MODES.DIG,
    timerInterval: null,
    shopTimer: null,
    renderBoard: () => {},
    updateHUD: () => {},
    showToast: () => {},
    clearGameState: () => {},
    updateActiveItemUI: () => {},
    closeShopModal: () => {}
  });

  app.switchMode(MODES.CLASSIC);
  assert.equal(app.skin, SKINS.CLASSIC, '切到經典模式必須換成經典皮膚');
  assert.equal(titleText.textContent, SKIN_TITLES[SKINS.CLASSIC].text, '標題不得停留在上一個風格');
  assert.equal(titleBadge.textContent, SKIN_TITLES[SKINS.CLASSIC].badge);
  assert.equal(skinBtn.style.display, 'none', '經典模式應隱藏風格切換鈕');

  // 經典模式下風格切換鈕無效，避免混入特工/地宮配色
  app.toggleSkin();
  assert.equal(app.skin, SKINS.CLASSIC);

  app.switchMode(MODES.TACTICAL);
  assert.equal(app.skin, SKINS.TACTICAL, '切回戰術模式須復原皮膚');
  assert.equal(titleText.textContent, SKIN_TITLES[SKINS.TACTICAL].text);
  assert.equal(skinBtn.style.display, '', '非經典模式應重新顯示風格切換鈕');
});

test('經典皮膚不寫入偏好，載入經典存檔時強制套用經典皮膚', () => {
  const { MinesweeperApp, SKINS } = require('../games/minesweeper/minesweeper.js');
  const originalStorage = global.localStorage;
  const written = {};
  global.localStorage = {
    getItem: (key) => (key === 'minesweeper_save_state_v1'
      ? JSON.stringify({
        mode: MODES.CLASSIC,
        difficulty: 'easy',
        rows: 2,
        cols: 2,
        totalMines: 1,
        skin: SKINS.DUNGEON,
        grid: createEmptyBoard(2, 2)
      })
      : '{}'),
    setItem: (key, value) => { written[key] = value; }
  };

  try {
    const app = Object.create(MinesweeperApp.prototype);
    app.el = { modeTabs: [], diffBtns: [], actionBtns: [] };
    app.timerInterval = null;
    app.action = ACTION_MODES.DIG;
    app.skin = SKINS.TACTICAL;
    app.renderBoard = () => {};
    app.updateHUD = () => {};
    app.showToast = () => {};

    assert.equal(app.loadGameState(), true);
    assert.equal(app.skin, SKINS.CLASSIC, '經典存檔須忽略舊皮膚欄位');
    assert.equal(written.minesweeper_pref_v1, undefined, '經典皮膚不應污染使用者偏好');
  } finally {
    global.localStorage = originalStorage;
  }
});

test('經典皮膚具備 Windows 95 灰階配色與立體邊框', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'games', 'minesweeper', 'minesweeper.css'),
    'utf8'
  );

  assert.match(css, /\[data-skin="classic"\]\[data-theme="light"\]/);
  assert.match(css, /\[data-skin="classic"\]\[data-theme="dark"\]/);

  const lightBlock = css.slice(
    css.indexOf('[data-skin="classic"][data-theme="light"]'),
    css.indexOf('[data-skin="classic"][data-theme="dark"]')
  );
  assert.match(lightBlock, /--bg-primary:\s*#c0c0c0/i, '底圖須為 Win95 灰');
  assert.match(lightBlock, /--w95-hilite:\s*#ffffff/i);
  assert.match(lightBlock, /--w95-shadow:\s*#808080/i);
  assert.match(lightBlock, /--radius-md:\s*0px/, '經典風格須為方角');
  assert.match(lightBlock, /--num-1:\s*#0000ff/i, '數字須採用原版配色');

  // 棋盤磚塊採無間隙的立體浮凸樣式
  assert.match(css, /\[data-skin="classic"\] \.minesweeper-grid \{[^}]*gap:\s*0/);
  assert.match(css, /\[data-skin="classic"\] \.cell \{[^}]*border-radius:\s*0/);
});

test('掃雷預設進入純粹經典模式，分頁置中且左右為進階模式', () => {
  const gameDir = path.join(__dirname, '..', 'games', 'minesweeper');
  const html = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(gameDir, 'minesweeper.js'), 'utf8');

  assert.match(html, /<html[^>]*data-skin="classic"/, '首次載入即套用經典皮膚');

  const tabs = [...html.matchAll(
    /<button class="mode-tab-btn( active)?" data-mode="([a-z]+)" role="tab" aria-selected="(true|false)"/g
  )].map(([, active, mode, selected]) => ({ mode, active: Boolean(active), selected: selected === 'true' }));

  assert.deepEqual(tabs.map(t => t.mode), [MODES.TACTICAL, MODES.CLASSIC, MODES.DUNGEON], '經典分頁須置中，左右才是進階模式');
  assert.deepEqual(tabs.filter(t => t.active).map(t => t.mode), [MODES.CLASSIC]);
  assert.deepEqual(tabs.filter(t => t.selected).map(t => t.mode), [MODES.CLASSIC]);

  // 建構子與存檔回復的預設值同步指向經典模式
  assert.match(js, /this\.mode = MODES\.CLASSIC;/);
  assert.match(js, /this\.skin = SKINS\.CLASSIC;/);
  assert.match(js, /this\.mode = state\.mode \|\| MODES\.CLASSIC;/);
});

test('預設經典模式下不會閃現戰術道具列與風格切換鈕', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'games', 'minesweeper', 'index.html'),
    'utf8'
  );

  assert.match(html, /id="item-bar"[^>]*style="display: none;"/, '道具列初始須隱藏');
  assert.match(html, /id="energy-bar-container"[^>]*style="display: none;"/, '能量條初始須隱藏');
  assert.match(html, /id="skin-toggle-btn"[^>]*style="display: none;"/, '經典模式不提供風格切換');
});
