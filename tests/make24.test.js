const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const make24JsPath = path.join(__dirname, '..', 'games', 'make24', 'make24.js');
const make24HtmlPath = path.join(__dirname, '..', 'games', 'make24', 'index.html');
const {
  MODES,
  CURATED_MASTER_PUZZLES,
  solve24Detailed,
  solve24,
  analyzePuzzle,
  isPuzzleMatchingDifficulty
} = require(make24JsPath);

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
  const sol = solve24([1, 1, 1, 1]);
  assert.equal(sol.length, 0, '1, 1, 1, 1 不應該有解');
});

test('24 點詳細求解引擎能精準辨別「中繼分數運算 (Fraction)」與「純整數解」', () => {
  // 3, 3, 8, 8 只有分數解 (8 / (3 - 8/3))
  const p1 = analyzePuzzle([3, 3, 8, 8]);
  assert.equal(p1.isFractionOnly, true, '3, 3, 8, 8 應判定為純分數解題');
  assert.equal(p1.hasIntegerSolution, false, '3, 3, 8, 8 不應存在純整數解');

  // 5, 5, 5, 1 只有分數解 ((5 - 1/5) * 5)
  const p2 = analyzePuzzle([5, 5, 5, 1]);
  assert.equal(p2.isFractionOnly, true, '5, 5, 5, 1 應判定為純分數解題');

  // 1, 2, 3, 4 有純整數解 ((1+2+3)*4)
  const p3 = analyzePuzzle([1, 2, 3, 4]);
  assert.equal(p3.hasIntegerSolution, true, '1, 2, 3, 4 應包含純整數解');
  assert.equal(p3.isFractionOnly, false, '1, 2, 3, 4 不應為純分數解');
});

test('24 點題目特徵分析器能準確計算奇偶比例與特色標籤', () => {
  // 4 奇數
  const pAllOdd = analyzePuzzle([3, 5, 7, 9]);
  assert.equal(pAllOdd.oddCount, 4);
  assert.equal(pAllOdd.evenCount, 0);

  // 4 偶數
  const pAllEven = analyzePuzzle([2, 4, 6, 8]);
  assert.equal(pAllEven.oddCount, 0);
  assert.equal(pAllEven.evenCount, 4);

  // 2 奇 2 偶
  const pMixed = analyzePuzzle([2, 3, 4, 5]);
  assert.equal(pMixed.oddCount, 2);
  assert.equal(pMixed.evenCount, 2);
});

test('24 點 4 檔難度規則過濾器 (isPuzzleMatchingDifficulty) 邏輯驗證', () => {
  // 簡單模式 (Easy): 偶數 >= 2, 解法數 >= 4, 必須有整數解
  const easyPuzzle = analyzePuzzle([2, 4, 6, 8]);
  assert.equal(isPuzzleMatchingDifficulty(easyPuzzle, 'easy'), true, '[2,4,6,8] 應符合簡單模式');

  // 簡單模式應排除純分數題
  const fractionPuzzle = analyzePuzzle([3, 3, 8, 8]);
  assert.equal(isPuzzleMatchingDifficulty(fractionPuzzle, 'easy'), false, '[3,3,8,8] 分數題不可出現在簡單模式');
  assert.equal(isPuzzleMatchingDifficulty(fractionPuzzle, 'medium'), false, '[3,3,8,8] 分數題不可出現在標準模式');

  // 大師模式應支援經典分數題
  assert.equal(isPuzzleMatchingDifficulty(fractionPuzzle, 'master'), true, '[3,3,8,8] 應符合大師模式');

  // 困難模式應涵蓋高奇數題型 (如 3 奇 1 偶 或 4 奇數)
  const hardOddPuzzle = analyzePuzzle([3, 3, 7, 7]);
  assert.equal(isPuzzleMatchingDifficulty(hardOddPuzzle, 'hard'), true, '[3,3,7,7] 高奇數題應符合困難模式');
});

test('24 點大師經典題庫 (CURATED_MASTER_PUZZLES) 皆保證有解', () => {
  assert.ok(CURATED_MASTER_PUZZLES.length >= 10, '經典大師題庫數量應充足');
  CURATED_MASTER_PUZZLES.forEach(nums => {
    const solutions = solve24(nums);
    assert.ok(solutions.length > 0, `經典題庫 ${JSON.stringify(nums)} 必須保證有解`);
  });
});

test('24 點 HTML 結構包含 4 檔難度切換按鈕 (easy, medium, hard, master)', () => {
  const html = fs.readFileSync(make24HtmlPath, 'utf8');
  assert.match(html, /id="tab-easy"/, '應包含 id="tab-easy"');
  assert.match(html, /id="tab-medium"/, '應包含 id="tab-medium"');
  assert.match(html, /id="tab-hard"/, '應包含 id="tab-hard"');
  assert.match(html, /id="tab-master"/, '應包含 id="tab-master"');
});

test('24 點程式碼具備完整的遊戲進度持久化方法 (saveGameState / loadGameState / clearGameState)', () => {
  const make24Source = fs.readFileSync(make24JsPath, 'utf8');
  assert.match(make24Source, /saveGameState\s*\(/, '應包含 saveGameState');
  assert.match(make24Source, /loadGameState\s*\(/, '應包含 loadGameState');
  assert.match(make24Source, /clearGameState\s*\(/, '應包含 clearGameState');
  assert.match(make24Source, /make24_game_state/, '應使用 make24_game_state 作為存檔 key');
  assert.match(make24Source, /make24_best_streak_/, '應具備各模式獨立的連勝 key');
});
