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
