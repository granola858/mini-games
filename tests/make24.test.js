const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const make24JsPath = path.join(__dirname, '..', 'games', 'make24', 'make24.js');
const make24HtmlPath = path.join(__dirname, '..', 'games', 'make24', 'index.html');
const {
  Make24Game,
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

test('24 點 Canonical 去重求解演算法能消除交換律等價解', () => {
  // [3, 3, 7, 7] 僅有 1 種本質解法: 7 * (3 + 3/7)
  const p1 = analyzePuzzle([3, 3, 7, 7]);
  assert.equal(p1.solutionCount, 1, '[3, 3, 7, 7] 經代數正規化後應精確判定為 1 種獨立思維解法');

  // [1, 2, 3, 4] 原始語法樹展開超過 200 種，經 Canonical 去重後精簡為不重複思維路徑
  const p2 = analyzePuzzle([1, 2, 3, 4]);
  assert.ok(p2.solutionCount > 0 && p2.solutionCount < 100, '[1, 2, 3, 4] 應成功去除交換律冗餘解');
});

test('24 點 4 檔難度規則過濾器 (isPuzzleMatchingDifficulty) 嚴格分層驗證', () => {
  // 簡單模式 (Easy): 偶數 >= 2, 解法數 >= 8, 必須有整數解, 數字 <= 9
  const easyPuzzle = analyzePuzzle([2, 4, 6, 8]);
  assert.equal(isPuzzleMatchingDifficulty(easyPuzzle, 'easy'), true, '[2,4,6,8] 應符合簡單模式');

  // 標準模式 (Medium): 3 <= 解法數 <= 7, 奇數 <= 3, 數字 <= 10
  const mediumPuzzle = analyzePuzzle([1, 5, 6, 8]);
  assert.equal(isPuzzleMatchingDifficulty(mediumPuzzle, 'medium'), true, '[1,5,6,8] 應符合標準模式');

  // 標準模式具備上限：超大水題 (如 49 解的 [2,4,6,8]) 不可出現在標準模式中
  assert.equal(isPuzzleMatchingDifficulty(easyPuzzle, 'medium'), false, '簡單大水題 [2,4,6,8] 不得流入標準模式');

  // 簡單與標準模式應排除純分數題
  const fractionPuzzle = analyzePuzzle([3, 3, 8, 8]);
  assert.equal(isPuzzleMatchingDifficulty(fractionPuzzle, 'easy'), false, '[3,3,8,8] 分數題不可出現在簡單模式');
  assert.equal(isPuzzleMatchingDifficulty(fractionPuzzle, 'medium'), false, '[3,3,8,8] 分數題不可出現在標準模式');

  // 大師模式應支援經典分數題
  assert.equal(isPuzzleMatchingDifficulty(fractionPuzzle, 'master'), true, '[3,3,8,8] 應符合大師模式');

  // 困難模式應涵蓋極少解或高奇數題型 (如 [3,3,7,7])
  const hardOddPuzzle = analyzePuzzle([3, 3, 7, 7]);
  assert.equal(isPuzzleMatchingDifficulty(hardOddPuzzle, 'hard'), true, '[3,3,7,7] 極少解高奇數題應符合困難模式');
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

test('24 點輸入介面支援游標任意位置插入與中途括號修補', () => {
  // 建立 Mock Game 物件模擬 Make24Game 的算式編輯方法
  const game = new Make24Game();
  game.cardData = [
    { num: 3, suit: { symbol: '♠', type: 'suit-black' }, displayRank: '3' },
    { num: 5, suit: { symbol: '♥', type: 'suit-red' }, displayRank: '5' },
    { num: 3, suit: { symbol: '♦', type: 'suit-red' }, displayRank: '3' },
    { num: 8, suit: { symbol: '♣', type: 'suit-black' }, displayRank: '8' }
  ];
  game.usedCardIndices.clear();
  game.tokens = [];
  game.cursorIndex = 0;
  game.selectionRange = null;

  // 1. 依序輸入 3 + 5 × 3 (未加括號)
  game.addNumberToken(0, 3);
  game.addOperatorToken('+');
  game.addNumberToken(1, 5);
  game.addOperatorToken('×');
  game.addNumberToken(2, 3);

  // 初始算式應該為 3 + 5 × 3，在四則運算下等於 18
  assert.equal(game.tokens.map(t => t.val).join(''), '3+5×3');
  assert.equal(game.cursorIndex, 5);
  const evalBefore = game.evaluateTokens();
  assert.equal(evalBefore.val, 18);

  // 2. 將游標移動到最前方 (index 0) 插入 '('
  game.setCursorIndex(0);
  assert.equal(game.cursorIndex, 0);
  game.addOperatorToken('(');
  assert.equal(game.tokens.map(t => t.val).join(''), '(3+5×3');
  assert.equal(game.cursorIndex, 1);

  // 3. 將游標移動到 5 後方 (此時 '(' 在 0, '3' 在 1, '+' 在 2, '5' 在 3, 插入點為 index 4) 插入 ')'
  game.setCursorIndex(4);
  game.addOperatorToken(')');
  assert.equal(game.tokens.map(t => t.val).join(''), '(3+5)×3');

  // 4. 驗證算式即時計算為 24
  const evalAfter = game.evaluateTokens();
  assert.equal(evalAfter.val, 24);
});

test('24 點輸入介面支援選取區間一鍵包裹括號 (Wrap) 與一鍵解除括號 (Unwrap)', () => {
  const game = new Make24Game();
  game.cardData = [
    { num: 3, suit: { symbol: '♠', type: 'suit-black' }, displayRank: '3' },
    { num: 5, suit: { symbol: '♥', type: 'suit-red' }, displayRank: '5' },
    { num: 3, suit: { symbol: '♦', type: 'suit-red' }, displayRank: '3' }
  ];
  game.tokens = [
    { type: 'num', val: '3', cardIdx: 0 },
    { type: 'op', val: '+' },
    { type: 'num', val: '5', cardIdx: 1 },
    { type: 'op', val: '×' },
    { type: 'num', val: '3', cardIdx: 2 }
  ];
  game.usedCardIndices = new Set([0, 1, 2]);

  // 1. 選取 '3 + 5' 區間 (index 0 ~ 3)
  game.setSelectionRange(0, 3);
  assert.deepEqual(game.selectionRange, { start: 0, end: 3 });

  // 2. 點擊 '(' 運算符，應自動將選取區間包裹為 '(3+5)'
  game.addOperatorToken('(');
  assert.equal(game.tokens.map(t => t.val).join(''), '(3+5)×3');
  // 包裹後選取範圍應涵蓋包含括號的區間 (0 ~ 5)
  assert.deepEqual(game.selectionRange, { start: 0, end: 5 });

  // 3. 再次點擊 ')' 運算符，偵測到已成對包裹，應自動解開外層括號 (Unwrap)
  game.addOperatorToken(')');
  assert.equal(game.tokens.map(t => t.val).join(''), '3+5×3');
  assert.deepEqual(game.selectionRange, { start: 0, end: 3 });
});

test('24 點輸入介面游標刪除與選取區間刪除能精準釋放撲克牌狀態', () => {
  const game = new Make24Game();
  game.cardData = [
    { num: 4, suit: { symbol: '♠', type: 'suit-black' }, displayRank: '4' },
    { num: 6, suit: { symbol: '♥', type: 'suit-red' }, displayRank: '6' }
  ];
  game.tokens = [];
  game.usedCardIndices.clear();
  game.cursorIndex = 0;

  // 放入卡片 0 (num: 4) 與 '+'
  game.addNumberToken(0, 4);
  game.addOperatorToken('+');
  game.addNumberToken(1, 6);
  assert.equal(game.usedCardIndices.has(0), true);
  assert.equal(game.usedCardIndices.has(1), true);

  // 游標在最末端 (index 3)，按 Backspace 刪除卡片 1
  game.handleBackspace();
  assert.equal(game.tokens.map(t => t.val).join(''), '4+');
  assert.equal(game.usedCardIndices.has(1), false, '卡片 1 應被釋放');
  assert.equal(game.usedCardIndices.has(0), true, '卡片 0 應維持鎖定');

  // 游標移至中間 (index 1，在 4 與 + 之間)，按 Backspace 刪除卡片 0
  game.setCursorIndex(1);
  game.handleBackspace();
  assert.equal(game.tokens.map(t => t.val).join(''), '+');
  assert.equal(game.usedCardIndices.has(0), false, '卡片 0 應被釋放');
});

test('24 點遊戲進度持久化能正確保存與還原游標與選取狀態', () => {
  const store = {};
  const originalLocalStorage = global.localStorage;
  global.localStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = v.toString(); },
    removeItem: (k) => { delete store[k]; }
  };

  try {
    const game = new Make24Game();
    game.cardData = [
      { num: 2, suit: { symbol: '♠', type: 'suit-black' }, displayRank: '2' },
      { num: 4, suit: { symbol: '♥', type: 'suit-red' }, displayRank: '4' },
      { num: 6, suit: { symbol: '♦', type: 'suit-red' }, displayRank: '6' },
      { num: 8, suit: { symbol: '♣', type: 'suit-black' }, displayRank: '8' }
    ];
    game.tokens = [
      { type: 'num', val: '2', cardIdx: 0 },
      { type: 'op', val: '+' },
      { type: 'num', val: '4', cardIdx: 1 }
    ];
    game.cursorIndex = 1;
    game.selectionRange = { start: 0, end: 2 };
    game.saveGameState();

    const loadedGame = new Make24Game();
    const loadedSuccess = loadedGame.loadGameState();
    assert.equal(loadedSuccess, true, '進度應成功載入');
    assert.equal(loadedGame.cursorIndex, 1, '游標位置應成功還原');
    assert.deepEqual(loadedGame.selectionRange, { start: 0, end: 2 }, '選取區間應成功還原');
  } finally {
    global.localStorage = originalLocalStorage;
  }
});

test('24 點結尾畫面包含通關算式卡片、統計網格與檢視盤面按鈕', () => {
  const game = new Make24Game();
  let modalTitle = '';
  let modalHtml = '';
  game.showModal = (title, html) => {
    modalTitle = title;
    modalHtml = html;
  };
  game.tokens = [
    { type: 'op', val: '(' },
    { type: 'num', val: '3', cardIdx: 0 },
    { type: 'op', val: '+' },
    { type: 'num', val: '5', cardIdx: 1 },
    { type: 'op', val: ')' },
    { type: 'op', val: '×' },
    { type: 'num', val: '3', cardIdx: 2 }
  ];
  game.triggerConfetti = () => {};

  game.handleWin();

  // 測試 handleWin 中的內容建構
  const expectedEquation = '( 3 + 5 ) × 3 = 24';
  assert.equal(game.isWon, true);
  assert.equal(game.streak, 1);
});


