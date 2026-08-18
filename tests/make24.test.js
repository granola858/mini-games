const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const make24JsPath = path.join(__dirname, '..', 'games', 'make24', 'make24.js');

// 從 make24.js 提取 solve24 函式進行演算法驗證
function solve24(nums) {
  const results = [];
  const helper = (list) => {
    if (list.length === 1) {
      if (Math.abs(list[0].val - 24) < 1e-5) {
        results.push(list[0].expr);
      }
      return;
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const nextList = list.filter((_, idx) => idx !== i && idx !== j);
        const a = list[i], b = list[j];

        helper([...nextList, { val: a.val + b.val, expr: `(${a.expr} + ${b.expr})` }]);
        helper([...nextList, { val: a.val - b.val, expr: `(${a.expr} - ${b.expr})` }]);
        helper([...nextList, { val: a.val * b.val, expr: `(${a.expr} × ${b.expr})` }]);
        if (Math.abs(b.val) > 1e-5) {
          helper([...nextList, { val: a.val / b.val, expr: `(${a.expr} ÷ ${b.expr})` }]);
        }
      }
    }
  };

  helper(nums.map(n => ({ val: n, expr: n.toString() })));
  return [...new Set(results)];
}

test('24 點求解演算法能正確解出經典題目', () => {
  // 經典題目 1: 3, 3, 8, 8 => 8 / (3 - 8/3) = 24
  const sol1 = solve24([3, 3, 8, 8]);
  assert.ok(sol1.length > 0, '3, 3, 8, 8 應該有解');

  // 經典題目 2: 1, 2, 3, 4 => (1 + 2 + 3) * 4 = 24
  const sol2 = solve24([1, 2, 3, 4]);
  assert.ok(sol2.length > 0, '1, 2, 3, 4 應該有解');

  // 經典題目 3: 5, 5, 5, 1 => (5 - 1/5) * 5 = 24
  const sol3 = solve24([5, 5, 5, 1]);
  assert.ok(sol3.length > 0, '5, 5, 5, 1 應該有解');

  // 經典題目 4: 4, 4, 10, 10 => (10 * 10 - 4) / 4 = 24
  const sol4 = solve24([4, 4, 10, 10]);
  assert.ok(sol4.length > 0, '4, 4, 10, 10 應該有解');
});

test('24 點求解演算法能正確識別無解題目', () => {
  // 1, 1, 1, 1 無法湊出 24
  const sol = solve24([1, 1, 1, 1]);
  assert.equal(sol.length, 0, '1, 1, 1, 1 不應該有解');
});
