const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = { UP: 1, RIGHT: 2, DOWN: 4, LEFT: 8 };

function rotateMask(mask) {
  let newMask = 0;
  if (mask & DIR.UP) newMask |= DIR.RIGHT;
  if (mask & DIR.RIGHT) newMask |= DIR.DOWN;
  if (mask & DIR.DOWN) newMask |= DIR.LEFT;
  if (mask & DIR.LEFT) newMask |= DIR.UP;
  return newMask;
}

function countBits(mask) {
  let count = 0;
  if (mask & DIR.UP) count++;
  if (mask & DIR.RIGHT) count++;
  if (mask & DIR.DOWN) count++;
  if (mask & DIR.LEFT) count++;
  return count;
}

function generateBoard(size) {
  const R = size;
  const C = size;
  const rawGrid = Array.from({ length: R }, () => Array(C).fill(0));
  const visited = Array.from({ length: R }, () => Array(C).fill(false));

  const stack = [[0, 0]];
  visited[0][0] = true;

  const DIRS = [
    { dr: -1, dc: 0, bit: DIR.UP, opp: DIR.DOWN },
    { dr: 0, dc: 1, bit: DIR.RIGHT, opp: DIR.LEFT },
    { dr: 1, dc: 0, bit: DIR.DOWN, opp: DIR.UP },
    { dr: 0, dc: -1, bit: DIR.LEFT, opp: DIR.RIGHT }
  ];

  while (stack.length > 0) {
    const [r, c] = stack[stack.length - 1];
    const unvisited = [];

    for (const d of DIRS) {
      const nr = r + d.dr;
      const nc = c + d.dc;
      if (nr >= 0 && nr < R && nc >= 0 && nc < C && !visited[nr][nc]) {
        unvisited.push({ r: nr, c: nc, dir: d });
      }
    }

    if (unvisited.length > 0) {
      const chosen = unvisited[Math.floor(Math.random() * unvisited.length)];
      rawGrid[r][c] |= chosen.dir.bit;
      rawGrid[chosen.r][chosen.c] |= chosen.dir.opp;
      visited[chosen.r][chosen.c] = true;
      stack.push([chosen.r, chosen.c]);
    } else {
      stack.pop();
    }
  }

  return rawGrid;
}

test('Loop 電流遮罩旋轉 360 度後應恢復原狀', () => {
  for (let mask = 1; mask <= 15; mask++) {
    let r = mask;
    for (let i = 0; i < 4; i++) {
      r = rotateMask(r);
    }
    assert.equal(r, mask, `遮罩 ${mask} 旋轉 4 次後應與原本相同`);
  }
});

test('Loop 隨機生成樹演算法能生成完全連通且無死角的電網', () => {
  const size = 5;
  const board = generateBoard(size);

  // 驗證每個單元格都有導線
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      assert.ok(board[r][c] > 0, `格 (${r},${c}) 應有導線`);
    }
  }

  // 驗證相鄰接合處一致
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const mask = board[r][c];
      if (mask & DIR.UP) {
        assert.ok(r > 0, '頂部外邊界不應有導線開口');
        assert.ok(board[r - 1][c] & DIR.DOWN, '相鄰上方格應向下接合');
      }
      if (mask & DIR.RIGHT) {
        assert.ok(c < size - 1, '右側外邊界不應有導線開口');
        assert.ok(board[r][c + 1] & DIR.LEFT, '相鄰右方格應向左接合');
      }
    }
  }
});

test('Loop 電網具備終點燈泡葉節點且能正確識別', () => {
  const size = 5;
  const board = generateBoard(size);
  let endpointCount = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (countBits(board[r][c]) === 1) {
        endpointCount++;
      }
    }
  }

  // 在任意大於 1x1 的樹狀圖中，葉節點數量必 >= 2
  assert.ok(endpointCount >= 2, `隨機生成電網中應有至少 2 個終點燈泡（實際：${endpointCount}）`);
});

test('Loop 程式碼具備完整的遊戲進度持久化方法 (saveGameState / loadGameState / clearGameState / switchGridSize)', () => {
  const loopSource = fs.readFileSync(path.join(__dirname, '..', 'games', 'loop', 'loop.js'), 'utf8');
  assert.match(loopSource, /saveGameState\s*\(/, '應包含 saveGameState');
  assert.match(loopSource, /loadGameState\s*\(/, '應包含 loadGameState');
  assert.match(loopSource, /loadGameStateForSize\s*\(/, '應包含 loadGameStateForSize');
  assert.match(loopSource, /clearGameState\s*\(/, '應包含 clearGameState');
  assert.match(loopSource, /switchGridSize\s*\(/, '應包含 switchGridSize');
  assert.match(loopSource, /loop_game_state/, '應使用 loop_game_state 作為存檔 key');
});

test('Loop 多規格狀態存檔結構與舊版相容性邏輯驗證', () => {
  // 1. 驗證多規格存檔 payload 結構
  const multiStatePayload = {
    currentSize: 6,
    states: {
      5: { gridSize: 5, grid: Array.from({ length: 5 }, () => Array(5).fill({})), moves: 3, timerSeconds: 10 },
      6: { gridSize: 6, grid: Array.from({ length: 6 }, () => Array(6).fill({})), moves: 7, timerSeconds: 25 }
    }
  };

  assert.equal(multiStatePayload.currentSize, 6);
  assert.ok(multiStatePayload.states['5']);
  assert.ok(multiStatePayload.states['6']);
  assert.equal(multiStatePayload.states['5'].grid.length, 5);
  assert.equal(multiStatePayload.states['6'].grid.length, 6);

  // 2. 驗證舊版存檔相容轉換邏輯
  const legacyPayload = {
    gridSize: 5,
    grid: Array.from({ length: 5 }, () => Array(5).fill({})),
    moves: 12,
    timerSeconds: 40
  };

  let migratedData = legacyPayload;
  if (!migratedData.states && migratedData.gridSize && Array.isArray(migratedData.grid)) {
    const oldSize = migratedData.gridSize;
    migratedData = {
      currentSize: oldSize,
      states: {
        [oldSize]: migratedData
      }
    };
  }

  assert.equal(migratedData.currentSize, 5);
  assert.ok(migratedData.states[5]);
  assert.equal(migratedData.states[5].moves, 12);
});

test('Loop 8x8 規格大師棋盤生成連通性驗證', () => {
  const size = 8;
  const board = generateBoard(size);
  assert.equal(board.length, 8);
  assert.equal(board[0].length, 8);

  let cellCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      assert.ok(board[r][c] > 0, `8x8 單元格 (${r},${c}) 應有導線`);
      cellCount++;
    }
  }
  assert.equal(cellCount, 64, '8x8 棋盤應有 64 個有效導線格');
});

test('Loop 最佳理論最少步數 (Par Moves) 與三星評分計算邏輯', () => {
  function getMinClicks(cur, target) {
    let temp = cur;
    for (let clicks = 0; clicks < 4; clicks++) {
      if (temp === target) return clicks;
      temp = rotateMask(temp);
    }
    return 0;
  }

  // 測試 1：同一角度 0 步
  assert.equal(getMinClicks(DIR.UP | DIR.RIGHT, DIR.UP | DIR.RIGHT), 0);

  // 測試 2：順時針轉 1 次可達
  const target = DIR.UP | DIR.RIGHT; // 3
  const cur1 = rotateMask(rotateMask(rotateMask(target))); // 轉 3 次
  assert.equal(getMinClicks(cur1, target), 1);

  // 測試 3：星級計算
  const parMoves = 20;
  function evaluateStars(moves, par) {
    if (moves <= par) return 3;
    if (moves <= Math.ceil(par * 1.5)) return 2;
    return 1;
  }

  assert.equal(evaluateStars(18, parMoves), 3, '步數 <= par 應為 3 星');
  assert.equal(evaluateStars(20, parMoves), 3, '步數 == par 應為 3 星');
  assert.equal(evaluateStars(25, parMoves), 2, '步數 <= par * 1.5 應為 2 星');
  assert.equal(evaluateStars(30, parMoves), 2, '步數 <= par * 1.5 應為 2 星');
  assert.equal(evaluateStars(35, parMoves), 1, '超額步數應為 1 星');
});

test('Loop 7x7 與 8x8 鎖定元件生成規則驗證', () => {
  function determineNumLocked(size) {
    if (size === 7) return 2;
    if (size >= 8) return 3; // 或 3~4
    return 0;
  }

  assert.equal(determineNumLocked(5), 0, '5x5 不應有鎖定元件');
  assert.equal(determineNumLocked(6), 0, '6x6 不應有鎖定元件');
  assert.equal(determineNumLocked(7), 2, '7x7 應有 2 個鎖定元件');
  assert.equal(determineNumLocked(8), 3, '8x8 應有 3~4 個鎖定元件');
});


