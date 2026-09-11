// 骰寶核心測試：注項目錄、賠率、逐注結算、連勝加成、懸念與存檔驗證。
// 核心是純邏輯（不碰 DOM / localStorage），所以這裡直接 require 它跑真實運算，
// 只有最後四條改用正則掃原始碼，鎖住「核心不得碰瀏覽器全域」這類無法用單元測試表達的契約。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GAME_DIR = path.join(__dirname, '..', 'games', 'sic-bo');
const CORE_PATH = path.join(GAME_DIR, 'sic-bo-core.js');
const JS_PATH = path.join(GAME_DIR, 'sic-bo.js');
const HTML_PATH = path.join(GAME_DIR, 'index.html');
const CSS_PATH = path.join(GAME_DIR, 'sic-bo.css');

// 即使核心檔尚未完成，也只讓「斷言失敗」而不是整份測試檔炸掉
let moduleLoadError = null;
let core = {};
try {
  // eslint-disable-next-line global-require
  core = require(CORE_PATH) || {};
} catch (err) {
  moduleLoadError = err;
}

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

const TOTAL_OUTCOMES = 216;   // 6³，所有機率計算的分母

// 216 種骰面一次列好，重複使用。順序固定，斷言訊息裡的骰面才能對得起來。
const ALL_DICE = (() => {
  const out = [];
  for (let d1 = 1; d1 <= 6; d1++) {
    for (let d2 = 1; d2 <= 6; d2++) {
      for (let d3 = 1; d3 <= 6; d3++) out.push([d1, d2, d3]);
    }
  }
  return out;
})();

// 檔案還沒建立時給人看得懂的紅燈，而不是 ENOENT 堆疊
function needFile(filePath) {
  let text = null;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    text = null;
  }
  assert.ok(text !== null, `${filePath} 尚未建立（實作未完成）`);
  return text;
}

// ---------------------------------------------------------------------------
// 測試自帶的參考實作
//
// 刻意「不」呼叫 SicBoCore.settle，也不讀 BETS 的 type / multiplier 欄位，
// 只從注項 id 字串反推該怎麼賠 —— 賠率表在這裡重打一份。
// 兩份實作都對才算對：若核心把某一格的賠率或中獎條件改錯，比對會立刻指名
// 是哪一格、哪一種骰面。若用核心自己的邏輯算期望值，這條測試就只是在說「等於自己」。
// ---------------------------------------------------------------------------

const REF_SUM_ODDS = {
  4: 60, 5: 30, 6: 18, 7: 12, 8: 8, 9: 7, 10: 6,
  11: 6, 12: 7, 13: 8, 14: 12, 15: 18, 16: 30, 17: 60
};

function refLine(betId, amount, dice) {
  const sum = dice[0] + dice[1] + dice[2];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < dice.length; i++) counts[dice[i]] += 1;
  const isTriple = dice[0] === dice[1] && dice[1] === dice[2];

  // 中獎 = 本金 + 本金 × 倍數；沒中則本金不退（returned 為 0）
  const verdict = (won, multiplier) => {
    const payout = won ? amount * multiplier : 0;
    return { won: won, payout: payout, returned: won ? amount + payout : 0 };
  };

  if (betId === 'bs-small') return verdict(!isTriple && sum >= 4 && sum <= 10, 1);
  if (betId === 'bs-big') return verdict(!isTriple && sum >= 11 && sum <= 17, 1);
  if (betId === 'triple-any') return verdict(isTriple, 30);

  let m = /^triple-([1-6])$/.exec(betId);
  if (m) return verdict(isTriple && dice[0] === Number(m[1]), 180);

  m = /^sum-(\d+)$/.exec(betId);
  if (m) {
    const target = Number(m[1]);
    assert.ok(REF_SUM_ODDS[target] !== undefined, `參考實作沒有 ${target} 點的賠率`);
    return verdict(sum === target, REF_SUM_ODDS[target]);
  }

  m = /^combo-([1-6])-([1-6])$/.exec(betId);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return verdict(counts[a] >= 1 && counts[b] >= 1, 5);
  }

  m = /^double-([1-6])$/.exec(betId);
  if (m) return verdict(counts[Number(m[1])] >= 2, 11);

  m = /^single-([1-6])$/.exec(betId);
  if (m) {
    const v = Number(m[1]);
    // 單骰是唯一「倍數看命中顆數」的注型：中 1／2／3 顆各賠 1／2／3 倍
    return verdict(counts[v] >= 1, counts[v]);
  }

  throw new Error('參考實作不認得注項 id：' + betId);
}

// 用參考實作獨立算一次莊家優勢（1 − RTP），押 1 元枚舉 216 面
function refHouseEdge(betId) {
  let returnedTotal = 0;
  for (let i = 0; i < ALL_DICE.length; i++) {
    returnedTotal += refLine(betId, 1, ALL_DICE[i]).returned;
  }
  return (TOTAL_OUTCOMES - returnedTotal) / TOTAL_OUTCOMES;
}

// ---------------------------------------------------------------------------
// 原始碼靜態掃描：把註解與字串／樣板字面值的「內容」塗成空白（保留換行以維持行號），
// 之後就能單純用大括號配對判斷「某個位置是不是落在某個 try 區塊裡」。
function blankLiterals(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (idx) => {
    if (idx < n && out[idx] !== '\n') out[idx] = ' ';
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i += 1; }
      blank(i); blank(i + 1); i += 2;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      i += 1; // 頭尾的引號原樣留著，只塗掉中間的內容
      while (i < n && src[i] !== ch) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        blank(i); i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// 找出所有「try { ... }」區塊在塗白後原始碼中的 [開括號, 閉括號] 位置
function tryBlockRanges(code) {
  const ranges = [];
  const re = /\btry\s*\{/g;
  let m = re.exec(code);
  while (m) {
    const open = code.indexOf('{', m.index);
    let depth = 0;
    let j = open;
    for (; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      else if (code[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    ranges.push([open, j]);
    m = re.exec(code);
  }
  return ranges;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// 0. 模組載入
// ---------------------------------------------------------------------------

test('sic-bo-core.js 可被 Node 載入並導出契約規定的 API 與常數', () => {
  assert.equal(moduleLoadError, null,
    `require('${CORE_PATH}') 失敗：${moduleLoadError && moduleLoadError.message}`);

  [
    'getBet',
    'roll',
    'analyze',
    'settle',
    'suspense',
    'nearMiss',
    'gambleRoll',
    'gambleResult',
    'checkMilestones',
    'emptySave',
    'normalizeSave',
    'emptyPrefs',
    'normalizePrefs',
    'formatNumber',
    'houseEdge'
  ].forEach(name => {
    assert.equal(typeof core[name], 'function', `缺少導出函式: ${name}`);
  });

  // 存檔 key 一旦改名，玩家的餘額與戰績就等於被清空，所以釘死在測試裡
  assert.equal(core.SAVE_KEY, 'sicbo_save_v1', '存檔 key 必須是 sicbo_save_v1');
  assert.equal(core.PREF_KEY, 'sicbo_pref_v1', '偏好 key 必須是 sicbo_pref_v1');
  assert.equal(core.SAVE_VERSION, 1, '存檔版本必須是 1');
  assert.equal(core.START_BALANCE, 1000, '起始餘額必須是 1000');
  assert.deepEqual(core.CHIPS, [10, 50, 100, 500], '籌碼面額必須是 10/50/100/500');
  assert.equal(core.HISTORY_LIMIT, 50, '歷史紀錄上限必須是 50 筆');
  assert.equal(core.STREAK_STEP, 0.1, '連勝每級加成必須是 10%');
  assert.equal(core.STREAK_MAX, 0.5, '連勝加成上限必須是 50%');
  assert.equal(core.STREAK_MIN_LEVEL, 2, '連勝必須達 2 才開始有加成');
  assert.equal(core.GAMBLE_MAX_ROUNDS, 3, '翻倍挑戰最多連續 3 次');

  assert.ok(Array.isArray(core.BETS), 'BETS 必須是陣列');
  assert.ok(Object.isFrozen(core.BETS), 'BETS 必須凍結，避免遊戲層誤改目錄');
  assert.equal(typeof core.BETS_BY_ID, 'object', 'BETS_BY_ID 必須是物件');
  assert.ok(Object.isFrozen(core.BETS_BY_ID), 'BETS_BY_ID 必須凍結');
  assert.ok(Array.isArray(core.MILESTONES), 'MILESTONES 必須是陣列');

  assert.deepEqual(core.BET_TYPES, {
    BIG_SMALL: 'bs',
    TRIPLE_ANY: 'triple_any',
    TRIPLE_ONE: 'triple_one',
    SUM: 'sum',
    COMBO: 'combo',
    DOUBLE: 'double',
    SINGLE: 'single'
  }, 'BET_TYPES 的字面值同時是存檔內容，不可改名');
});

// ---------------------------------------------------------------------------
// A. 注項目錄與賠率
// ---------------------------------------------------------------------------

test('注項目錄恰好 50 格：id 唯一、六組格數正確、賠率與 pips 逐項比對', () => {
  const bets = core.BETS;
  assert.equal(bets.length, 50, '注項目錄必須恰好 50 格');

  const ids = bets.map(bet => bet.id);
  assert.equal(new Set(ids).size, 50, `注項 id 必須全站唯一，實際只有 ${new Set(ids).size} 個不同 id`);

  const byGroup = {};
  bets.forEach(bet => {
    byGroup[bet.group] = (byGroup[bet.group] || 0) + 1;
  });
  assert.deepEqual(byGroup, { bs: 3, sum: 14, combo: 15, double: 6, triple: 6, single: 6 },
    '六個 group 的格數必須是 3/14/15/6/6/6，否則畫面的格線會排不滿');

  // 大小列：任意圍骰刻意夾在小與大中間，順序就是畫面順序
  assert.deepEqual(bets.filter(b => b.group === 'bs').map(b => b.id),
    ['bs-small', 'triple-any', 'bs-big'], '大小列順序必須是 小 → 任意圍骰 → 大');

  // 點數賠率表（釘死，不可改）
  Object.keys(REF_SUM_ODDS).forEach(key => {
    const sum = Number(key);
    const bet = core.getBet('sum-' + sum);
    assert.ok(bet, `缺少 sum-${sum} 注項`);
    assert.equal(bet.type, core.BET_TYPES.SUM, `sum-${sum} 的 type 不符`);
    assert.equal(bet.value, sum, `sum-${sum} 的 value 必須是 ${sum}`);
    assert.equal(bet.multiplier, REF_SUM_ODDS[sum],
      `sum-${sum} 的賠率必須是 ${REF_SUM_ODDS[sum]}，這張表已用 216 面驗算過莊家優勢`);
    assert.equal(bet.label, String(sum), `sum-${sum} 的 label 必須是數字本身`);
    assert.equal(bet.pips, null, `sum-${sum} 不該有 pips（它是數字格）`);
  });
  assert.equal(core.getBet('sum-3'), null, '3 點必然是圍骰，不該有 sum-3 注項');
  assert.equal(core.getBet('sum-18'), null, '18 點必然是圍骰，不該有 sum-18 注項');

  // 組合 15 組：順序即畫面順序，且一律 a < b
  const expectedCombos = [
    '1-2', '1-3', '1-4', '1-5', '1-6',
    '2-3', '2-4', '2-5', '2-6',
    '3-4', '3-5', '3-6',
    '4-5', '4-6',
    '5-6'
  ];
  const combos = bets.filter(b => b.group === 'combo');
  assert.deepEqual(combos.map(b => b.value), expectedCombos, '組合 15 組的順序必須與畫面一致');
  combos.forEach(bet => {
    const parts = bet.value.split('-').map(Number);
    assert.ok(parts[0] < parts[1], `${bet.id} 的兩顆點數必須 a < b，否則同一組會出現兩格`);
    assert.equal(bet.id, 'combo-' + bet.value, `${bet.id} 的 id 必須是 combo-<value>`);
    assert.equal(bet.multiplier, 5, `${bet.id} 的賠率必須是 5`);
    assert.deepEqual(bet.pips, parts, `${bet.id} 的 pips 必須是 [a, b] 才畫得出兩顆骰`);
  });

  // 其餘四組的賠率與 pips
  assert.equal(core.getBet('bs-small').multiplier, 1, '小的賠率必須是 1');
  assert.equal(core.getBet('bs-big').multiplier, 1, '大的賠率必須是 1');
  assert.equal(core.getBet('triple-any').multiplier, 30, '任意圍骰的賠率必須是 30');
  for (let v = 1; v <= 6; v++) {
    const dbl = core.getBet('double-' + v);
    const tri = core.getBet('triple-' + v);
    const sgl = core.getBet('single-' + v);
    assert.equal(dbl.multiplier, 11, `double-${v} 的賠率必須是 11`);
    assert.deepEqual(dbl.pips, [v, v], `double-${v} 的 pips 必須是兩顆 ${v}`);
    assert.equal(tri.multiplier, 180, `triple-${v} 的賠率必須是 180`);
    assert.deepEqual(tri.pips, [v, v, v], `triple-${v} 的 pips 必須是三顆 ${v}`);
    assert.equal(sgl.multiplier, 1, `single-${v} 的 multiplier 是「中一顆賠一倍」的門面值`);
    assert.deepEqual(sgl.pips, [v], `single-${v} 的 pips 必須是一顆 ${v}`);
  }

  // BETS_BY_ID 與 getBet 必須同一份真相，且不可從原型鏈撈東西回來
  bets.forEach(bet => {
    assert.equal(core.BETS_BY_ID[bet.id], bet, `BETS_BY_ID['${bet.id}'] 必須指向同一個物件`);
    assert.equal(core.getBet(bet.id), bet, `getBet('${bet.id}') 必須回傳目錄裡那一筆`);
  });
  assert.equal(core.getBet('nope'), null, '未知 id 必須回 null');
  assert.equal(core.getBet('constructor'), null,
    "getBet('constructor') 必須回 null，否則存檔被亂改時會撈到原型鏈上的函式當注項");
  assert.equal(core.getBet(null), null, '非字串 id 必須回 null');
});

test('216 枚舉：每一格的莊家優勢都落在 2.7%–16.7%，大小恰為 2.7777%', () => {
  const MIN_EDGE = 0.027;
  const MAX_EDGE = 0.167;

  core.BETS.forEach(bet => {
    const edge = core.houseEdge(bet.id);
    assert.ok(Number.isFinite(edge), `${bet.id} 的莊家優勢必須是有限數`);
    assert.ok(edge >= MIN_EDGE - 1e-12,
      `${bet.id} 的莊家優勢 ${(edge * 100).toFixed(4)}% 低於 2.7%（賠率過甜，RTP 超過 97.3%）`);
    assert.ok(edge <= MAX_EDGE + 1e-12,
      `${bet.id} 的莊家優勢 ${(edge * 100).toFixed(4)}% 高於 16.7%（賠率太苛，玩起來像被坑）`);

    // 再用測試自帶的參考實作獨立算一次：核心的 houseEdge 與 settleLine 共用同一份判定，
    // 只比對區間抓不到「兩邊一起錯」，所以這裡拿外部算式當第二個意見。
    const expected = refHouseEdge(bet.id);
    assert.ok(Math.abs(edge - expected) < 1e-12,
      `${bet.id} 的莊家優勢與參考實作不符：核心 ${edge}，參考 ${expected}`);
  });

  // 大小是全表最漂亮的一格：6/216 = 2.7777…%（只有圍骰通殺那 6 種盤面是莊家的優勢來源）
  const BS_EDGE = 6 / TOTAL_OUTCOMES;
  ['bs-small', 'bs-big'].forEach(id => {
    assert.ok(Math.abs(core.houseEdge(id) - BS_EDGE) < 1e-9,
      `${id} 的莊家優勢必須約等於 2.7777%（實際 ${(core.houseEdge(id) * 100).toFixed(6)}%）`);
  });

  assert.throws(() => core.houseEdge('nope'), TypeError, '未知 id 的莊家優勢必須丟 TypeError');
});

// ---------------------------------------------------------------------------
// B. 結算
// ---------------------------------------------------------------------------

test('結算正確性：50 格 × 216 種骰面全部與測試內獨立參考實作一致', () => {
  const AMOUNT = 10;
  let checked = 0;

  core.BETS.forEach(bet => {
    ALL_DICE.forEach(dice => {
      const expected = refLine(bet.id, AMOUNT, dice);
      const result = core.settle([{ id: bet.id, amount: AMOUNT }], dice);
      const line = result.lines[0];
      const label = `${bet.id} 開出 [${dice.join(',')}]`;

      assert.equal(line.won, expected.won,
        `${label} 的中獎判定不符（參考實作說 ${expected.won}）`);
      assert.equal(line.payout, expected.payout,
        `${label} 的純贏分不符（參考實作說 ${expected.payout}）`);
      assert.equal(line.returned, expected.returned,
        `${label} 的回收金額不符（參考實作說 ${expected.returned}）`);

      // 沒有連勝時，整局的數字必須等於這一注的數字，不能多冒出任何加成
      assert.equal(result.stake, AMOUNT, `${label} 的本局押注應等於這一注的金額`);
      assert.equal(result.basePayout, expected.payout, `${label} 的 basePayout 不符`);
      assert.equal(result.streakBonus, 0, `${label} 無連勝時不該有加成`);
      assert.equal(result.returned, expected.returned, `${label} 的整局回收不符`);
      assert.equal(result.net, expected.returned - AMOUNT, `${label} 的淨損益必須是回收減押注`);
      assert.equal(result.won, expected.returned - AMOUNT > 0, `${label} 的整局勝負旗標不符`);
      checked += 1;
    });
  });
  assert.equal(checked, core.BETS.length * TOTAL_OUTCOMES,
    `應枚舉 ${core.BETS.length * TOTAL_OUTCOMES} 種「注項 × 骰面」組合，實際 ${checked}`);

  // 整桌 50 格同時下注：逐注正確不代表加總正確（漏加、重複加都在這裡現形）。
  // 金額刻意每格不同，某一格算到別格的金額也會被抓出來。
  ALL_DICE.forEach(dice => {
    const bets = core.BETS.map((bet, i) => ({ id: bet.id, amount: 10 + i }));
    const result = core.settle(bets, dice);
    let stake = 0;
    let basePayout = 0;
    let returned = 0;
    bets.forEach(entry => {
      const ref = refLine(entry.id, entry.amount, dice);
      stake += entry.amount;
      basePayout += ref.payout;
      returned += ref.returned;
    });
    const label = `整桌 50 格開出 [${dice.join(',')}]`;
    assert.equal(result.lines.length, 50, `${label} 的 lines 必須逐注回報 50 筆`);
    assert.equal(result.stake, stake, `${label} 的總押注不符`);
    assert.equal(result.basePayout, basePayout, `${label} 的總純贏分不符`);
    assert.equal(result.returned, returned, `${label} 的總回收不符`);
    assert.equal(result.net, returned - stake, `${label} 的淨損益不符`);
  });

  // 空注單合法：UI 在「還沒下注就按 PLAY」時會走到這裡，不該炸掉
  const empty = core.settle([], [1, 2, 3]);
  assert.deepEqual(empty.lines, [], '空注單的 lines 必須是空陣列');
  assert.equal(empty.stake, 0, '空注單的押注必須是 0');
  assert.equal(empty.returned, 0, '空注單的回收必須是 0');
  assert.equal(empty.net, 0, '空注單的淨損益必須是 0');
  assert.equal(empty.won, false, '空注單不算贏');
  assert.deepEqual(empty.dice, [1, 2, 3], 'settle 必須轉送骰面');
  assert.equal(empty.sum, 6, 'settle 必須轉送點數');
});

test('圍骰通殺大小：[3,3,3] 時大小都不中，任意圍骰與圍骰 3 都中', () => {
  const dice = [3, 3, 3];
  const analysis = core.analyze(dice);
  assert.equal(analysis.isTriple, true, '[3,3,3] 必須判定為圍骰');
  assert.equal(analysis.tripleValue, 3, '圍骰點數必須是 3');
  assert.equal(analysis.bigSmall, 'triple',
    '圍骰的 bigSmall 必須是第三種結果 triple，而不是靠 sum 落在小的範圍就寫 small');
  assert.deepEqual(analysis.counts, [0, 0, 0, 3, 0, 0, 0], 'counts[3] 必須是 3，索引 0 不使用');

  const result = core.settle([
    { id: 'bs-small', amount: 10 },
    { id: 'bs-big', amount: 10 },
    { id: 'triple-any', amount: 10 },
    { id: 'triple-3', amount: 10 },
    { id: 'triple-4', amount: 10 },
    { id: 'double-3', amount: 10 }
  ], dice);
  const byId = {};
  result.lines.forEach(line => { byId[line.id] = line; });

  assert.equal(byId['bs-small'].won, false, '圍骰通殺：押小不中（sum 9 落在小的範圍也一樣）');
  assert.equal(byId['bs-small'].returned, 0, '圍骰通殺時押小的本金不退');
  assert.equal(byId['bs-big'].won, false, '圍骰通殺：押大不中');
  assert.equal(byId['bs-big'].returned, 0, '圍骰通殺時押大的本金不退');
  assert.equal(byId['triple-any'].won, true, '[3,3,3] 必須中任意圍骰');
  assert.equal(byId['triple-any'].returned, 10 + 10 * 30, '任意圍骰賠 30 倍加本金');
  assert.equal(byId['triple-3'].won, true, '[3,3,3] 必須中圍骰 3');
  assert.equal(byId['triple-3'].returned, 10 + 10 * 180, '特定圍骰賠 180 倍加本金');
  assert.equal(byId['triple-4'].won, false, '圍骰 4 不該被別的點數的圍骰帶中');
  assert.equal(byId['double-3'].won, true, '三顆同點也算中對子（沿用舊版行為）');
});

test('單骰按命中顆數賠：[2,2,5] 押 single-2 回收本金加兩倍', () => {
  const dice = [2, 2, 5];
  const result = core.settle([
    { id: 'single-2', amount: 10 },
    { id: 'single-5', amount: 10 },
    { id: 'single-1', amount: 10 }
  ], dice);
  const byId = {};
  result.lines.forEach(line => { byId[line.id] = line; });

  assert.equal(byId['single-2'].payout, 10 * 2, '中兩顆就賠兩倍，不是看 multiplier 欄位的 1');
  assert.equal(byId['single-2'].returned, 10 * 3, '回收 = 本金 + 兩倍純贏分 = 三倍金額');
  assert.equal(byId['single-5'].returned, 10 * 2, '中一顆回收兩倍金額');
  assert.equal(byId['single-1'].returned, 0, '沒開出的點數不退本金');

  // 三顆同點是單骰的最大值：回收四倍
  const triple = core.settle([{ id: 'single-6', amount: 25 }], [6, 6, 6]);
  assert.equal(triple.lines[0].payout, 75, '三顆全中賠三倍');
  assert.equal(triple.returned, 100, '三顆全中回收四倍金額（本金 + 三倍）');
});

test('本金與 won 分離：輸的注不退本金，中獎注回收本金加純贏分', () => {
  const result = core.settle([
    { id: 'sum-12', amount: 20 },   // [2,4,6] → 中，賠 7 倍
    { id: 'bs-big', amount: 30 },   // sum 12 → 中，賠 1 倍
    { id: 'sum-4', amount: 50 }     // 不中
  ], [2, 4, 6]);
  const byId = {};
  result.lines.forEach(line => { byId[line.id] = line; });

  assert.equal(byId['sum-12'].won, true, 'sum-12 開出 12 點必須中');
  assert.equal(byId['sum-12'].payout, 140, 'sum-12 的純贏分是 20 × 7');
  assert.equal(byId['sum-12'].returned, 160, '中獎回收 = 本金 20 + 純贏分 140');
  assert.equal(byId['bs-big'].returned, 60, '押大中獎回收兩倍金額');
  assert.equal(byId['sum-4'].won, false, 'sum-4 開出 12 點不該中');
  assert.equal(byId['sum-4'].payout, 0, '沒中的注純贏分是 0');
  assert.equal(byId['sum-4'].returned, 0, '沒中的注本金不退（本金在下注時就扣掉了）');

  assert.equal(result.stake, 100, '本局總押注是三筆之和');
  assert.equal(result.returned, 220, '整局回收是兩筆中獎注之和');
  assert.equal(result.net, 120, 'net 必須等於 returned 減 stake');
  assert.equal(result.won, true, 'net 為正才算贏');

  // won 是獨立布林，不得用 payout > 0 推導：每一筆的 won 與 returned 必須自洽
  result.lines.forEach(line => {
    assert.equal(typeof line.won, 'boolean', `${line.id} 的 won 必須是布林`);
    assert.equal(line.returned, line.won ? line.amount + line.payout : 0,
      `${line.id} 的 returned 與 won 不自洽`);
  });

  // 押注與回收相等 → 打平，won 必須是 false（不是「沒輸就算贏」）
  const push = core.settle([{ id: 'bs-big', amount: 40 }], [6, 5, 1]);
  assert.equal(push.returned, 80, '押大中獎回收兩倍');
  assert.equal(push.net, 40, '單注押大中獎的淨賺等於本金');
  const flat = core.settle([
    { id: 'bs-big', amount: 40 },
    { id: 'bs-small', amount: 40 }
  ], [6, 5, 1]);
  assert.equal(flat.net, 0, '大小對沖時淨損益為 0');
  assert.equal(flat.won, false, '打平不算贏');
});

test('連勝加成以「本局淨賺」為基底，且 2 級起跳、6 級封頂 50%', () => {
  // 單注中獎時「本局淨賺」與「毛贏分」剛好同值（都是 70），所以下面這張表的期望值
  // 不因基底改變而變。兩者分家的情境在本測試後半（大注沒中、純對沖）與下一條不變量測試。
  const bet = [{ id: 'sum-12', amount: 10 }];   // 中獎純贏分 70，本局淨賺也是 70
  const dice = [2, 4, 6];

  const cases = [
    { level: 0, rate: 0, bonus: 0 },
    { level: 1, rate: 0, bonus: 0 },     // 連勝 1 還沒有加成
    { level: 2, rate: 0.1, bonus: 7 },
    { level: 3, rate: 0.2, bonus: 14 },
    { level: 4, rate: 0.3, bonus: 21 },
    { level: 5, rate: 0.4, bonus: 28 },
    { level: 6, rate: 0.5, bonus: 35 },
    { level: 20, rate: 0.5, bonus: 35 }  // 封頂後不再成長
  ];
  cases.forEach(({ level, rate, bonus }) => {
    const result = core.settle(bet, dice, { streakLevel: level });
    assert.equal(result.streakLevel, level, `連勝 ${level} 級必須原樣轉送`);
    assert.equal(result.streakRate, rate,
      `連勝 ${level} 級的加成比例必須恰好是 ${rate}（不可出現 0.30000000000000004 這種浮點殘渣）`);
    assert.equal(result.basePayout, 70, `連勝 ${level} 級時 basePayout 不該被加成污染`);
    assert.equal(result.streakBonus, bonus, `連勝 ${level} 級的加成金額不符`);
    assert.equal(result.returned, 80 + bonus, `連勝 ${level} 級的回收 = 本金 + 純贏分 + 加成`);
    assert.equal(result.net, result.returned - result.stake, `連勝 ${level} 級的 net 必須是回收減押注`);
  });

  // 加成一律對整局合計取一次 floor：逐注四捨五入會讓 ×1 的小注在 +10%～+40% 完全吃不到加成
  const tiny = core.settle([{ id: 'bs-big', amount: 5 }], [6, 5, 1], { streakLevel: 2 });
  assert.equal(tiny.basePayout, 5, '押大 5 分的純贏分是 5');
  assert.equal(tiny.streakBonus, 0, 'floor(5 × 0.1) = 0，加成不足 1 分就是 0，不得四捨五入成 1');

  const pooled = core.settle([
    { id: 'bs-big', amount: 5 },
    { id: 'sum-12', amount: 5 }
  ], [2, 4, 6], { streakLevel: 2 });
  assert.equal(pooled.basePayout, 40, '兩注合計純贏分 5 + 35');
  assert.equal(pooled.streakBonus, 4, '加成算在整局合計上：floor(40 × 0.1) = 4');

  // 加成的基底是「本局真正賺到的錢」，不是中獎注的毛贏分。
  // 這一局小注中了（毛贏分 70）但大注沒中，整局淨損 930 —— 這種局不該拿到任何加成。
  const mixed = core.settle([
    { id: 'sum-12', amount: 10 },
    { id: 'sum-4', amount: 1000 }
  ], [2, 4, 6], { streakLevel: 6 });
  assert.equal(mixed.basePayout, 70, '沒中的 1000 分不得計入 basePayout');
  assert.equal(mixed.streakBonus, 0,
    '本局淨損 930，加成必須是 0（用毛贏分當基底會送出 35 分，那正是無限刷分漏洞的入口）');
  assert.equal(mixed.net, 80 - 1010, '大注沒中時淨損益仍是回收減押注');
  assert.equal(mixed.won, false, '淨損的局不算贏');

  // 沒中獎時沒有加成可加；連勝級數的壞值一律當 0，不得讓整局結算拋錯
  const lost = core.settle([{ id: 'sum-4', amount: 10 }], [2, 4, 6], { streakLevel: 6 });
  assert.equal(lost.streakBonus, 0, '沒有純贏分就沒有加成');
  [undefined, null, NaN, -3, '5', {}, Infinity].forEach(bad => {
    const result = core.settle(bet, dice, { streakLevel: bad });
    assert.equal(result.streakLevel, 0, `連勝級數 ${String(bad)} 必須當成 0`);
    assert.equal(result.streakBonus, 0, `連勝級數 ${String(bad)} 不該產生加成`);
  });
  assert.equal(core.settle(bet, dice).streakBonus, 0, '省略 options 時不該有加成');
  assert.equal(core.settle(bet, dice, null).streakBonus, 0, 'options 傳 null 時不該有加成');

  // 純對沖：毛贏分 500，但回收等於押注（淨賺 0）→ 任何連勝級數都不得有加成。
  // 用毛贏分當基底時，連勝 2 級就會白送 50 分，這一局會從「打平」變成「淨賺 50」。
  for (let level = 0; level <= 6; level++) {
    const hedge = core.settle([
      { id: 'bs-big', amount: 500 },
      { id: 'bs-small', amount: 500 }
    ], [6, 5, 1], { streakLevel: level });
    assert.equal(hedge.basePayout, 500, '押大中獎的毛贏分是 500');
    assert.equal(hedge.streakBonus, 0,
      `連勝 ${level} 級：純對沖（回收 === 押注）不得拿到任何加成`);
    assert.equal(hedge.net, 0, `連勝 ${level} 級：大小對沖的淨損益必須是 0`);
    assert.equal(hedge.won, false, `連勝 ${level} 級：打平不算贏，連勝不得因此續命`);
  }

  // 審查員實跑的漏洞注單：大 500 + 小 500 + 任意圍骰 40（總押注 1,040）。
  // 舊算法在連勝 2 級時，非圍骰面 net = +10、圍骰面 net = +320，216 面全部為正，
  // 於是 won 恆真、連勝永不歸零、加成一路升到 +50% 封頂，餘額可無上限成長。
  const exploit = [
    { id: 'bs-big', amount: 500 },
    { id: 'bs-small', amount: 500 },
    { id: 'triple-any', amount: 40 }
  ];
  const plainFace = core.settle(exploit, [6, 5, 1], { streakLevel: 2 });
  assert.equal(plainFace.basePayout, 500, '非圍骰面的毛贏分是押大那 500');
  assert.equal(plainFace.streakBonus, 0,
    '毛贏分 500 但本局淨損 40，加成必須是 0（舊算法會白送 50，把 −40 變成 +10）');
  assert.equal(plainFace.net, -40, '非圍骰面必須是淨輸 40（圍骰那 40 分的本金）');
  assert.equal(plainFace.won, false, '對沖注單不得被判定為贏，否則連勝永不歸零');

  const tripleFace = core.settle(exploit, [3, 3, 3], { streakLevel: 2 });
  assert.equal(tripleFace.basePayout, 1200, '圍骰面的毛贏分是 40 × 30');
  assert.equal(tripleFace.streakBonus, 20,
    '加成看本局淨賺 200（floor(200 × 0.1) = 20），不是毛贏分 1200 的 120');
  assert.equal(tripleFace.net, 220, '圍骰面淨賺 200，加上加成 20');
  assert.equal(tripleFace.won, true, '真的賺到錢的局才算贏');
});

// 遊戲經濟的核心不變量：不存在任何「無風險注單」。
// 這條測試存在的理由是一個真實的 BLOCKER —— 連勝加成曾以中獎注的毛贏分為基底，
// 於是把注押在互斥結果上（毛贏分很大、淨損益貼在 0 附近）就能讓 216 面全部 net > 0，
// 連勝永不中斷、加成升到封頂、餘額無上限成長（審查員用真的 Chrome 實跑 40～3,000 局驗證過）。
// 只要有人日後把基底改回毛贏分、或讓加成能跨過「淨賺為正」這條線，這裡就會立刻變紅。
test('不變量：對沖注單在任何連勝級數都至少有一種骰面會賠錢（不存在無風險注單）', () => {
  const hedges = [
    {
      label: '大500 + 小500 + 任意圍骰40',
      bets: [
        { id: 'bs-big', amount: 500 },
        { id: 'bs-small', amount: 500 },
        { id: 'triple-any', amount: 40 }
      ]
    },
    {
      // 這一份從全新存檔（1,000 分）的第一局就付得起，所以不是理論上的漏洞
      label: '大150 + 小150 + 任意圍骰10',
      bets: [
        { id: 'bs-big', amount: 150 },
        { id: 'bs-small', amount: 150 },
        { id: 'triple-any', amount: 10 }
      ]
    },
    {
      label: '大100 + 小100',
      bets: [
        { id: 'bs-big', amount: 100 },
        { id: 'bs-small', amount: 100 }
      ]
    }
  ];

  hedges.forEach(({ label, bets }) => {
    for (let level = 0; level <= 6; level++) {
      let minNet = Infinity;
      let worst = null;
      let losingFaces = 0;
      for (let i = 0; i < ALL_DICE.length; i++) {
        const result = core.settle(bets, ALL_DICE[i], { streakLevel: level });
        if (result.net < 0) losingFaces += 1;
        if (result.net < minNet) {
          minNet = result.net;
          worst = ALL_DICE[i];
        }
        // 順手鎖住「加成不得把輸局／平局推成贏局」：won 必須只看逐注回收與押注的比較
        assert.equal(result.won, result.returned - result.streakBonus > result.stake,
          `${label} 連勝 ${level} 級在 ${ALL_DICE[i].join(',')} 的 won 被連勝加成污染了`);
      }
      assert.ok(minNet < 0,
        `${label} 在連勝 ${level} 級的 216 種骰面裡最差只有 net=${minNet}`
        + `（最差骰面 ${worst && worst.join(',')}）—— 這是一份無風險注單，餘額可無上限刷`);
      assert.ok(losingFaces > 0, `${label} 在連勝 ${level} 級必須存在會賠錢的骰面`);
    }
  });
});

// ---------------------------------------------------------------------------
// C. 開骰與輸入防禦
// ---------------------------------------------------------------------------

test('roll 可注入 rng：假 rng 給出可預期骰面，預設 rng 三顆都在 1–6', () => {
  const queue = [0, 0.5, 0.99];
  const fakeRng = () => queue.shift();
  assert.deepEqual(core.roll(fakeRng), [1, 4, 6], '注入的 rng 序列必須一對一對應骰面');

  // 邊界值：rng 理論上回傳 [0, 1)，但假 rng 或壞掉的實作可能給出 1 或負數。
  // 那會生出 0 / 7 這種不存在的骰面，讓後面所有 counts[] 索引錯位，所以核心必須夾住。
  assert.deepEqual(core.roll(() => 1), [6, 6, 6], 'rng 回傳 1 時必須夾到 6');
  assert.deepEqual(core.roll(() => -0.5), [1, 1, 1], 'rng 回傳負數時必須夾到 1');

  // rng 不是函式時退回預設亂數，呼叫端不必自己補預設值
  [undefined, null, 'random', 42, {}].forEach(bad => {
    const dice = core.roll(bad);
    assert.equal(dice.length, 3, `rng 為 ${String(bad)} 時仍必須擲出三顆`);
    dice.forEach(d => {
      assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `rng 為 ${String(bad)} 時骰面 ${d} 不合法`);
    });
  });

  // 預設亂數跑一批，確認分佈落在合法範圍且六面都出得來
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    core.roll().forEach(d => {
      assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `預設 rng 擲出不合法的骰面 ${d}`);
      seen.add(d);
    });
  }
  assert.equal(seen.size, 6, `600 局 1800 顆骰應該六面都出現過，實際只出現 ${seen.size} 面`);

  // 回傳的陣列必須是新的，呼叫端改它不會污染核心
  const dice = core.roll(() => 0.5);
  dice[0] = 99;
  assert.deepEqual(core.roll(() => 0.5), [4, 4, 4], 'roll 必須每次回傳新陣列');
});

test('analyze 與 settle 對非法輸入一律丟 TypeError', () => {
  [
    undefined, null, 'abc', 123, {}, [], [1, 2], [1, 2, 3, 4],
    [0, 2, 3], [1, 7, 3], [1, 2, 2.5], [1, 2, '3'], [1, 2, NaN]
  ].forEach(bad => {
    assert.throws(() => core.analyze(bad), TypeError,
      `analyze(${JSON.stringify(bad)}) 必須丟 TypeError，否則壞骰面會讓 counts 索引錯位`);
  });

  // 合法輸入不得被誤殺，且 analyze 不會就地改動傳進來的陣列
  const dice = [1, 6, 3];
  const analysis = core.analyze(dice);
  assert.equal(analysis.sum, 10, '1+6+3 應該是 10');
  assert.equal(analysis.bigSmall, 'small', 'sum 10 是小的上界');
  assert.equal(analysis.isTriple, false, '三顆不同點不是圍骰');
  assert.equal(analysis.tripleValue, null, '非圍骰的 tripleValue 必須是 null');
  assert.deepEqual(dice, [1, 6, 3], 'analyze 不得就地改動傳進來的骰面');
  assert.notEqual(analysis.dice, dice, 'analyze 回傳的 dice 必須是副本');
  assert.equal(core.analyze([5, 6, 6]).bigSmall, 'big', 'sum 17 是大');
  assert.equal(core.analyze([1, 1, 2]).bigSmall, 'small', 'sum 4 是小');

  // settle 的注單防禦：未知 id 與非正整數金額都是「餘額會被算錯」的等級，必須拋錯
  assert.throws(() => core.settle([{ id: 'nope', amount: 10 }], [1, 2, 3]), TypeError,
    '未知的注項 id 必須丟 TypeError，不可靜靜當成沒中');
  assert.throws(() => core.settle([{ id: 'constructor', amount: 10 }], [1, 2, 3]), TypeError,
    "id 為 'constructor' 必須丟 TypeError（原型鏈污染）");
  [0, -10, 1.5, '10', null, undefined, NaN, Infinity].forEach(bad => {
    assert.throws(() => core.settle([{ id: 'bs-big', amount: bad }], [1, 2, 3]), TypeError,
      `押注金額 ${String(bad)} 必須丟 TypeError`);
  });
  [null, undefined, 'x', 123, {}].forEach(bad => {
    assert.throws(() => core.settle(bad, [1, 2, 3]), TypeError,
      `注單為 ${String(bad)} 必須丟 TypeError`);
  });
  assert.throws(() => core.settle([null], [1, 2, 3]), TypeError, '注單裡的空項必須丟 TypeError');
  assert.throws(() => core.settle([{ id: 'bs-big', amount: 10 }], [1, 2, 9]), TypeError,
    'settle 也必須擋下壞骰面');
});

// ---------------------------------------------------------------------------
// D. 懸念與差一點
// ---------------------------------------------------------------------------

test('suspense 的判準是「第三顆之前勝負還沒定」，與賠率倍數無關', () => {
  // 高賠率的注一如既往會觸發
  assert.equal(core.suspense([{ id: 'sum-17', amount: 10 }], [6, 6]), true,
    '押 17 點且前兩顆是 6,6：第三顆只有開 5 才中，這才是真的懸念');
  assert.equal(core.suspense([{ id: 'triple-6', amount: 10 }], [6, 6]), true,
    '押圍骰 6 且前兩顆是 6,6：最後一顆決定 180 倍');

  // 舊判準是「桌上有倍數 ≥ 6 的注可能中」，於是下面這四種注 216 面全部 0% 觸發 ——
  // 偏偏它們是新手最常押、也最典型「等最後一顆」的注。新判準必須為它們停頓。
  assert.equal(core.suspense([{ id: 'bs-big', amount: 100 }], [3, 4]), true,
    '押大、前兩顆合計 7：第三顆開 4 以上才過 11 點，勝負完全在最後一顆');
  assert.equal(core.suspense([{ id: 'bs-small', amount: 100 }], [4, 5]), true,
    '押小、前兩顆合計 9：第三顆只有開 1 才留在 10 點以內');
  assert.equal(core.suspense([{ id: 'single-4', amount: 100 }], [1, 2]), true,
    '押單骰 4、前兩顆沒開出 4：中不中就看最後一顆');
  assert.equal(core.suspense([{ id: 'combo-2-5', amount: 100 }], [2, 1]), true,
    '押組合 2-5、只開出 2：第三顆開 5 才中，這是最典型的等最後一顆');

  // 圍骰通殺讓「看起來已定」的局其實還有變數：前兩顆同點時，第三顆補成圍骰就通殺大小
  assert.equal(core.suspense([{ id: 'bs-small', amount: 100 }], [1, 1]), true,
    '前兩顆 1,1 押小：第三顆開 1 會被圍骰通殺，六種結果有五種贏、一種輸，仍未定勝負');

  // 勝負已定的兩端都不算懸念
  assert.equal(core.suspense([{ id: 'bs-small', amount: 100 }], [1, 2]), false,
    '前兩顆 1,2（合計 3、不可能補成圍骰）：第三顆開什麼都在小的範圍，六種全贏');
  assert.equal(core.suspense([{ id: 'bs-small', amount: 100 }], [4, 6]), false,
    '前兩顆合計 10：第三顆一定讓總和過 10，押小已經不可能中');
  assert.equal(core.suspense([{ id: 'sum-17', amount: 10 }], [1, 1]), false,
    '前兩顆 1,1 時 17 點已經不可能，六種結果全不中');
  assert.equal(core.suspense([{ id: 'combo-1-2', amount: 10 }], [1, 2]), false,
    '組合 1-2 的兩顆都已開出，六種結果全中，沒什麼可懸的');
  assert.equal(core.suspense([], [6, 6]), false, '沒有下注就沒有懸念');
  assert.equal(core.suspense([{ id: 'nope', amount: 10 }], [6, 6]), false,
    '注單全是未知 id 時視為沒有下注');

  // 判準看的是「本局淨損益」，所以金額比例會被算進來：
  // 純對沖不管第三顆開什麼都打平，那從一開始就沒有勝負可懸。
  const hedge = [{ id: 'bs-big', amount: 500 }, { id: 'bs-small', amount: 500 }];
  assert.equal(core.suspense(hedge, [6, 5]), false,
    '大小對沖永遠打平，第三顆開什麼都一樣，不該讓玩家等 500ms');
  const hedgePlusTriple = hedge.concat([{ id: 'triple-any', amount: 40 }]);
  assert.equal(core.suspense(hedgePlusTriple, [3, 3]), true,
    '同一份對沖注單加上圍骰注、前兩顆又同點時，第三顆真的在賭那 30 倍');
  assert.equal(core.suspense(hedgePlusTriple, [6, 5]), false,
    '前兩顆不同點時圍骰已不可能，這份注單的勝負（打平減 40）已定');

  // minPayout：呼叫端可以要求「只有賺得夠多才值得停頓」，預設不設限
  assert.equal(core.suspense([{ id: 'bs-big', amount: 100 }], [3, 4], { minPayout: 500 }), false,
    '押大 100 最多淨賺 100，門檻 500 之下不值得停頓');
  assert.equal(core.suspense([{ id: 'sum-10', amount: 100 }], [3, 4], { minPayout: 500 }), true,
    '押點數 10 中了淨賺 600，跨過 500 的門檻');
  [undefined, null, 'x', NaN, -5, 0, {}].forEach(bad => {
    assert.equal(core.suspense([{ id: 'bs-big', amount: 100 }], [3, 4], { minPayout: bad }), true,
      `minPayout 為 ${String(bad)} 時必須回到「不設限」，不可讓低賠付的懸念消音`);
  });
  assert.equal(core.suspense([{ id: 'bs-big', amount: 100 }], [3, 4], { minMultiplier: 6 }), true,
    '倍數門檻已經不是判準，傳入舊的 minMultiplier 也不該讓押大的懸念消失');

  // 金額缺失或不合法時退回 1：UI 可能在金額還沒定案時就問這個問題，不該讓這裡丟 TypeError
  assert.equal(core.suspense([{ id: 'sum-17' }], [6, 6]), true, '沒有 amount 也要能判定懸念');
  [0, -10, 1.5, '100', null, NaN].forEach(bad => {
    assert.equal(core.suspense([{ id: 'sum-17', amount: bad }], [6, 6]), true,
      `金額 ${String(bad)} 不合法時必須退回 1 並照常判定`);
  });

  assert.throws(() => core.suspense([{ id: 'sum-17', amount: 10 }], [6]), TypeError,
    '前兩顆骰子長度不符必須丟 TypeError');
  assert.throws(() => core.suspense([{ id: 'sum-17', amount: 10 }], [6, 9]), TypeError,
    '前兩顆骰子含非法點數必須丟 TypeError');

  // 觸發率健檢（枚舉前兩顆的 36 種組合）。押點數本來就幾乎每局都在等第三顆，那是事實，
  // 靠遊戲層節流；重點是押大小 / 單骰 / 組合從舊判準的 0% 回到「真的有懸念」的水準。
  const triggerRate = (bets, options) => {
    let hit = 0;
    for (let a = 1; a <= 6; a++) {
      for (let b = 1; b <= 6; b++) {
        if (core.suspense(bets, [a, b], options)) hit += 1;
      }
    }
    return hit / 36;
  };
  assert.ok(triggerRate([{ id: 'bs-big', amount: 100 }]) > 0.6,
    `押大的懸念觸發率必須明顯大於 0（舊判準是 0%），實測 ${triggerRate([{ id: 'bs-big', amount: 100 }])}`);
  assert.ok(triggerRate([{ id: 'single-4', amount: 100 }]) > 0.6,
    '押單骰在前兩顆沒開出該點數時都是第三顆決勝負');
  assert.ok(triggerRate([{ id: 'combo-2-5', amount: 100 }]) > 0.4,
    '押組合只開出一半時就是等最後一顆');
  assert.ok(triggerRate([{ id: 'triple-any', amount: 100 }]) < 0.25,
    '押任意圍骰時只有前兩顆同點才有懸念，觸發率必須低');
  assert.equal(triggerRate([{ id: 'bs-big', amount: 100 }], { minPayout: 10000 }), 0,
    '門檻高到不可能達成時不該有任何懸念');
});

test('nearMiss 找出差一點情境，帶 kind 與 rarity，沒有近失時回 null', () => {
  // 點數差 1
  const one = core.nearMiss([{ id: 'sum-12', amount: 10 }], [2, 4, 5]);
  assert.ok(one, '押 12 點開出 11 點必須算差一點');
  assert.equal(one.betId, 'sum-12', 'betId 必須指向那一格');
  assert.match(one.message, /差 1 點/, '訊息必須講「差 1 點」');
  assert.match(one.message, /12/, '訊息必須帶上玩家押的點數');
  assert.match(one.message, /11/, '訊息必須帶上開出的點數');
  // kind 是遊戲層做節流（同一句 N 局內不重複）的依據，核心不記狀態，所以這個欄位必須穩定存在
  assert.equal(one.kind, 'sum-off-by-one', 'kind 必須是穩定的情境代號，供遊戲層節流');
  assert.ok(Number.isInteger(one.rarity) && one.rarity > 0, 'rarity 必須是正整數（越小越稀有）');

  // 舊版就有的另外四種情境
  assert.match(core.nearMiss([{ id: 'triple-4', amount: 10 }], [4, 4, 1]).message,
    /就差一顆！4 點開了兩顆/, '押圍骰 4 而 4 點開兩顆必須提示就差一顆');
  assert.match(core.nearMiss([{ id: 'triple-any', amount: 10 }], [5, 5, 2]).message,
    /就差一顆圍骰/, '押任意圍骰而任一點數開兩顆必須提示就差一顆圍骰');
  assert.match(core.nearMiss([{ id: 'triple-any', amount: 10 }], [5, 5, 2]).message,
    /5 點開了兩顆/, '任意圍骰的近失也要講清楚是哪個點數開了兩顆');
  assert.match(core.nearMiss([{ id: 'combo-2-5', amount: 10 }], [2, 3, 4]).message,
    /差一顆！2 和 5 只開出了其中一個/, '押組合只開出其中一顆必須提示');
  assert.match(core.nearMiss([{ id: 'double-6', amount: 10 }], [6, 1, 2]).message,
    /差一顆！6 點只開了一顆/, '押對子只開一顆必須提示');

  // 新增情境 ①：大小被圍骰通殺（點數本來落在自己那一半）
  const sweep = core.nearMiss([{ id: 'bs-small', amount: 10 }], [2, 2, 2]);
  assert.ok(sweep, '押小開出 2,2,2（6 點本來算小）必須有近失文案');
  assert.equal(sweep.kind, 'bs-sweep', '圍骰通殺是獨立的情境代號');
  assert.match(sweep.message, /圍骰通殺/, '必須明說是被圍骰通殺，否則玩家會以為賠率算錯');
  assert.match(sweep.message, /三顆 2/, '要講清楚開出什麼圍骰');
  assert.match(sweep.message, /6 點/, '要講清楚原本的點數');
  const sweepBig = core.nearMiss([{ id: 'bs-big', amount: 10 }], [5, 5, 5]);
  assert.equal(sweepBig.kind, 'bs-sweep', '押大開出 5,5,5（15 點本來算大）同樣是通殺');
  assert.equal(core.nearMiss([{ id: 'bs-big', amount: 10 }], [1, 1, 1]), null,
    '押大卻開出 3 點的圍骰，點數本來也不在大的範圍，不算差一點');

  // 新增情境 ②：大小只差 1 點（押小開 11、押大開 10）
  const edgeSmall = core.nearMiss([{ id: 'bs-small', amount: 10 }], [6, 4, 1]);
  assert.ok(edgeSmall, '押小開出 11 點必須算差一點（舊版押大小永遠拿不到任何文案）');
  assert.equal(edgeSmall.kind, 'bs-edge', '大小差 1 點是獨立的情境代號');
  assert.match(edgeSmall.message, /11 點/, '訊息要具體講出開了幾點');
  const edgeBig = core.nearMiss([{ id: 'bs-big', amount: 10 }], [6, 3, 1]);
  assert.equal(edgeBig.kind, 'bs-edge', '押大開出 10 點也是差 1 點');
  assert.match(edgeBig.message, /10 點/, '訊息要具體講出開了幾點');
  assert.equal(core.nearMiss([{ id: 'bs-small', amount: 10 }], [6, 6, 4]), null,
    '押小開出 16 點差太遠，不算差一點');

  // 新增情境 ③：單骰沒開出，但對面那一面開了（骰子對面相加為 7，翻半圈就是玩家押的點數）
  const flip = core.nearMiss([{ id: 'single-4', amount: 10 }], [3, 3, 5]);
  assert.ok(flip, '押單骰 4 沒開出 4 但開了兩顆 3（4 的對面）必須有近失文案');
  assert.equal(flip.kind, 'single-flip', '單骰翻面是獨立的情境代號');
  assert.match(flip.message, /沒開出 4/, '要講清楚缺的是哪個點數');
  assert.match(flip.message, /3 點/, '要講清楚對面是哪個點數');
  assert.match(flip.message, /2 顆/, '要講清楚對面開了幾顆');
  assert.equal(core.nearMiss([{ id: 'single-4', amount: 10 }], [1, 2, 6]), null,
    '押單骰 4 而 4 的對面（3 點）一顆也沒開，不算差一點');

  // 依稀有度排序，回傳最稀有的那一個（舊版是固定優先序）
  const rarest = core.nearMiss([
    { id: 'combo-2-5', amount: 10 },
    { id: 'sum-12', amount: 10 }
  ], [2, 3, 6]);
  assert.equal(rarest.betId, 'sum-12',
    '組合只差一顆（122/216）是全表最常見的近失，不該蓋掉點數差 1（48/216）');
  const tripleBeatsDouble = core.nearMiss([
    { id: 'double-6', amount: 10 },
    { id: 'triple-4', amount: 10 }
  ], [4, 4, 6]);
  assert.equal(tripleBeatsDouble.betId, 'triple-4',
    '圍骰差一顆（15/216）比對子差一顆（75/216）罕見');
  const sweepWins = core.nearMiss([
    { id: 'combo-1-2', amount: 10 },
    { id: 'bs-small', amount: 10 }
  ], [2, 2, 2]);
  assert.equal(sweepWins.betId, 'bs-small', '圍骰通殺（3/216）是全表最罕見的一種，優先權最高');
  const flipBeatsCombo = core.nearMiss([
    { id: 'combo-1-3', amount: 10 },
    { id: 'single-4', amount: 10 }
  ], [3, 5, 5]);
  assert.equal(flipBeatsCombo.betId, 'single-4', '單骰翻面（61/216）比組合只差一顆（122/216）罕見');

  // 舊版的優先序在新規則下仍成立的那一條：點數差 1 壓過對子差一顆
  const priority = core.nearMiss([
    { id: 'double-6', amount: 10 },
    { id: 'sum-12', amount: 10 }
  ], [6, 4, 1]);
  assert.equal(priority.betId, 'sum-12', '點數差 1（48/216）比對子差一顆（75/216）罕見');

  // 同稀有度時保留玩家下注順序的第一筆，結果才穩定可預期
  const tieA = core.nearMiss([
    { id: 'combo-1-3', amount: 10 },
    { id: 'combo-2-5', amount: 10 }
  ], [1, 2, 4]);
  assert.equal(tieA.betId, 'combo-1-3', '同稀有度時取下注順序較前的那一筆');
  const tieB = core.nearMiss([
    { id: 'combo-2-5', amount: 10 },
    { id: 'combo-1-3', amount: 10 }
  ], [1, 2, 4]);
  assert.equal(tieB.betId, 'combo-2-5', '調換下注順序時跟著換人，證明排序是穩定的');

  // 沒有任何近失情境時回 null，UI 就不顯示副訊息。
  // 這條路必須留著：每個輸局都硬掏一句安慰話，就是另一種洗版。
  assert.equal(core.nearMiss([{ id: 'bs-small', amount: 10 }], [6, 6, 5]), null,
    '押小開出 17 點差太遠，必須回 null');
  assert.equal(core.nearMiss([{ id: 'sum-4', amount: 10 }], [6, 6, 5]), null,
    '押 4 點開出 17 點差太遠，不算差一點');
  assert.equal(core.nearMiss([], [1, 2, 3]), null, '沒有下注就沒有差一點');
  assert.equal(core.nearMiss([{ id: 'nope', amount: 10 }], [1, 2, 3]), null,
    '未知 id 靜靜跳過，差一點只是安慰文案，不值得為它拋錯');
  assert.throws(() => core.nearMiss([{ id: 'sum-12', amount: 10 }], [1, 2]), TypeError,
    'nearMiss 也必須擋下壞骰面');
});

// rarity 不是憑感覺填的數字：它就是「216 種骰面裡有多少面會對同一注觸發這個情境」。
// 這條測試用枚舉把每個常數釘死，順便鎖住兩件事：
// (a) 近失只能出現在輸掉的注上（安慰中獎的人很荒謬）；
// (b) 六個注群全部都要有近失情境 —— 舊版的大小與單骰一次都拿不到文案，那正是缺陷 2 的另一半。
test('nearMiss 的 rarity 與 216 面實測觸發次數逐格相符，且六個注群都有近失情境', () => {
  const byBet = {};

  core.BETS.forEach(bet => {
    const kinds = {};
    ALL_DICE.forEach(dice => {
      const miss = core.nearMiss([{ id: bet.id, amount: 10 }], dice);
      if (!miss) return;

      assert.equal(miss.betId, bet.id, `${bet.id} 的近失 betId 指錯格`);
      assert.equal(typeof miss.kind, 'string', `${bet.id} 的 kind 必須是字串`);
      assert.ok(miss.kind.length > 0, `${bet.id} 的 kind 不可是空字串`);
      assert.equal(typeof miss.message, 'string', `${bet.id} 的 message 必須是字串`);
      assert.ok(miss.message.length > 0, `${bet.id} 的 message 不可是空字串`);
      assert.ok(Number.isInteger(miss.rarity) && miss.rarity > 0 && miss.rarity < TOTAL_OUTCOMES,
        `${bet.id} 的 rarity（${miss.rarity}）必須是 1–215 的整數`);

      const line = core.settle([{ id: bet.id, amount: 10 }], dice).lines[0];
      assert.equal(line.won, false,
        `${bet.id} 在 ${dice.join(',')} 其實中獎了，卻回報近失「${miss.kind}」`);

      if (!kinds[miss.kind]) kinds[miss.kind] = { faces: 0, rarity: miss.rarity };
      assert.equal(kinds[miss.kind].rarity, miss.rarity,
        `${bet.id} 的 ${miss.kind} 在不同骰面上報出不同的 rarity`);
      kinds[miss.kind].faces += 1;
    });
    byBet[bet.id] = kinds;
  });

  core.BETS.forEach(bet => {
    Object.keys(byBet[bet.id]).forEach(kind => {
      const entry = byBet[bet.id][kind];
      assert.equal(entry.faces, entry.rarity,
        `${bet.id} 的 ${kind}：rarity 標 ${entry.rarity}，但 216 面實測有 ${entry.faces} 面觸發`);
    });
  });

  // 逐項核對關鍵常數（數字直接對應註解裡的組合數學）
  assert.equal(byBet['bs-small']['bs-sweep'].faces, 3, '押小被圍骰通殺只有 1,1,1 / 2,2,2 / 3,3,3 三面');
  assert.equal(byBet['bs-big']['bs-sweep'].faces, 3, '押大被圍骰通殺只有 4,4,4 / 5,5,5 / 6,6,6 三面');
  assert.equal(byBet['bs-small']['bs-edge'].faces, 27, '押小而開出 11 點有 27 面');
  assert.equal(byBet['bs-big']['bs-edge'].faces, 27, '押大而開出 10 點有 27 面');
  assert.equal(byBet['triple-3']['triple-one-pair'].faces, 15, '押圍骰 3 而 3 點開兩顆有 15 面');
  assert.equal(byBet['triple-any']['triple-any-pair'].faces, 90, '任一點數開兩顆有 90 面');
  assert.equal(byBet['combo-2-5']['combo-half'].faces, 122, '組合只開出一半有 122 面（全表最常見）');
  assert.equal(byBet['double-6']['double-one'].faces, 75, '押對子而該點數只開一顆有 75 面');
  assert.equal(byBet['single-4']['single-flip'].faces, 61, '押單骰 4 而只開出對面的 3 點有 61 面');
  assert.equal(byBet['sum-4']['sum-off-by-one'].faces, 7, '押 4 點差 1 點只有 7 面（3 點 1 面 + 5 點 6 面）');
  assert.equal(byBet['sum-10']['sum-off-by-one'].faces, 52, '押 10 點差 1 點有 52 面（9 點 25 + 11 點 27）');

  // 六個注群都必須有近失情境
  const groupFaces = {};
  core.BETS.forEach(bet => {
    const total = Object.keys(byBet[bet.id]).reduce((n, kind) => n + byBet[bet.id][kind].faces, 0);
    groupFaces[bet.group] = (groupFaces[bet.group] || 0) + total;
  });
  ['bs', 'sum', 'combo', 'double', 'triple', 'single'].forEach(group => {
    assert.ok(groupFaces[group] > 0,
      `${group} 這一組完全沒有近失情境（舊版的大小與單骰就是這樣，一次都拿不到安慰句）`);
  });

  // 排序方向：組合只差一顆必須比「點數差 1」與「圍骰差一顆」都不稀有（數字更大）
  const comboRarity = byBet['combo-2-5']['combo-half'].rarity;
  assert.ok(comboRarity > byBet['triple-3']['triple-one-pair'].rarity,
    '組合只差一顆的稀有度必須低於圍骰差一顆');
  assert.ok(comboRarity > byBet['triple-any']['triple-any-pair'].rarity,
    '組合只差一顆的稀有度必須低於任意圍骰差一顆');
  for (let sum = 4; sum <= 17; sum++) {
    assert.ok(comboRarity > byBet['sum-' + sum]['sum-off-by-one'].rarity,
      `組合只差一顆的稀有度必須低於「押 ${sum} 點差 1 點」`);
  }
});

// ---------------------------------------------------------------------------
// E. 翻倍挑戰與里程碑
// ---------------------------------------------------------------------------

test('gambleResult：1–3 為小、4–6 為大，六個骰面兩種押法逐一驗證', () => {
  for (let die = 1; die <= 6; die++) {
    const isSmall = die <= 3;
    const small = core.gambleResult('small', die);
    const big = core.gambleResult('big', die);

    assert.equal(small.win, isSmall, `骰面 ${die} 押小的勝負不符（1–3 才是小）`);
    assert.equal(big.win, !isSmall, `骰面 ${die} 押大的勝負不符（4–6 才是大）`);
    assert.equal(small.die, die, `回傳必須帶上骰面 ${die}`);
    assert.equal(small.pick, 'small', '回傳必須帶上玩家的押法');
    assert.equal(big.pick, 'big', '回傳必須帶上玩家的押法');
    // 單顆骰沒有圍骰問題，小與大剛好各半，是公平的 50/50
    assert.notEqual(small.win, big.win, `骰面 ${die} 的小與大必須恰好一邊贏`);
  }

  ['small', 'big'].forEach(pick => {
    [0, 7, 1.5, '3', null, undefined, NaN].forEach(bad => {
      assert.throws(() => core.gambleResult(pick, bad), TypeError,
        `翻倍骰面 ${String(bad)} 必須丟 TypeError`);
    });
  });
  ['SMALL', 'Big', 'high', '', null, undefined, 1].forEach(bad => {
    assert.throws(() => core.gambleResult(bad, 3), TypeError,
      `押法 ${String(bad)} 必須丟 TypeError`);
  });

  // gambleRoll 同樣吃注入的 rng，才能重播同一次翻倍
  assert.equal(core.gambleRoll(() => 0), 1, 'rng 0 必須擲出 1');
  assert.equal(core.gambleRoll(() => 0.99), 6, 'rng 0.99 必須擲出 6');
  for (let i = 0; i < 200; i++) {
    const die = core.gambleRoll();
    assert.ok(Number.isInteger(die) && die >= 1 && die <= 6, `預設 rng 擲出不合法的翻倍骰面 ${die}`);
  }
});

test('checkMilestones 不改動入參，已達成的不重複回傳', () => {
  // 里程碑清單同時是存檔內容（已達成的 id 會寫進 milestones），所以整張表釘死
  assert.deepEqual(core.MILESTONES.map(m => [m.id, m.type, m.value, m.label]), [
    ['balance-2000', 'balance', 2000, '餘額破 2,000'],
    ['balance-5000', 'balance', 5000, '餘額破 5,000'],
    ['balance-10000', 'balance', 10000, '餘額破 10,000'],
    ['balance-50000', 'balance', 50000, '餘額破 50,000'],
    ['win-500', 'bigWin', 500, '單局淨賺 500'],
    ['win-2000', 'bigWin', 2000, '單局淨賺 2,000'],
    ['streak-3', 'streak', 3, '三連勝'],
    ['streak-5', 'streak', 5, '五連勝'],
    ['streak-8', 'streak', 8, '八連勝'],
    ['triple-1', 'triples', 1, '開出圍骰'],
    ['rounds-50', 'rounds', 50, '玩滿 50 局'],
    ['rounds-200', 'rounds', 200, '玩滿 200 局']
  ], '里程碑清單（id / 類型 / 門檻 / 文案）必須與契約一致');

  const stats = {
    rounds: 50, wins: 10, biggestWin: 600, peakBalance: 2500,
    triples: 1, bestStreak: 3, totalStake: 5000, totalReturned: 5200,
    gambleWins: 1, gambleLosses: 2
  };
  const statsSnapshot = JSON.parse(JSON.stringify(stats));
  const hitIds = [];

  const first = core.checkMilestones(stats, hitIds);
  assert.deepEqual(first.map(m => m.id),
    ['balance-2000', 'win-500', 'streak-3', 'triple-1', 'rounds-50'],
    '達標的五項必須依 MILESTONES 的順序回傳（UI 會照順序逐一 toast）');

  assert.deepEqual(stats, statsSnapshot, 'checkMilestones 不得改動傳進來的 stats');
  assert.deepEqual(hitIds, [], 'checkMilestones 不得改動傳進來的 hitIds');

  // 重複達成不重複回傳：這是「同一個里程碑每局都跳 toast」的防線
  assert.deepEqual(core.checkMilestones(stats, first.map(m => m.id)), [],
    '已達成的里程碑不得再次回傳');
  assert.deepEqual(core.checkMilestones(stats, new Set(first.map(m => m.id))), [],
    'hitIds 傳 Set 也必須生效');

  // 餘額類看 peakBalance：達成過就是達成過，之後輸回去不該被撤銷
  const crashed = Object.assign({}, stats, { peakBalance: 12000 });
  assert.deepEqual(core.checkMilestones(crashed, ['balance-2000']).map(m => m.id),
    ['balance-5000', 'balance-10000', 'win-500', 'streak-3', 'triple-1', 'rounds-50'],
    '最高餘額破 12,000 應一次補回 5,000 與 10,000 兩個里程碑');

  // 壞 stats 一律當成全新戰績，不得拋錯（里程碑只是獎勵，不值得讓結算炸掉）
  [null, undefined, 'x', 42, []].forEach(bad => {
    assert.deepEqual(core.checkMilestones(bad, []), [], `stats 為 ${String(bad)} 時不該有任何達成`);
  });
  assert.deepEqual(core.checkMilestones(stats, null).map(m => m.id),
    ['balance-2000', 'win-500', 'streak-3', 'triple-1', 'rounds-50'],
    'hitIds 為 null 時視為還沒有任何達成');
  assert.deepEqual(core.checkMilestones({}, ['not-a-milestone']), [],
    '全新戰績不該有任何達成，未知的已達成 id 也不該造成影響');
});

// ---------------------------------------------------------------------------
// F. 存檔、偏好與格式化
// ---------------------------------------------------------------------------

test('normalizeSave 對任何壞資料都回傳合法存檔且絕不 throw', () => {
  const fresh = core.emptySave();
  assert.equal(fresh.v, 1, '新存檔的版本必須是 1');
  assert.equal(fresh.balance, 1000, '新存檔的餘額必須是 1000');
  assert.equal(fresh.streak, 0, '新存檔的連勝必須是 0');
  assert.deepEqual(fresh.lastBets, [], '新存檔沒有上局注單');
  assert.deepEqual(fresh.history, [], '新存檔沒有歷史');
  assert.deepEqual(fresh.milestones, [], '新存檔沒有里程碑');
  assert.deepEqual(fresh.stats, {
    rounds: 0, wins: 0, biggestWin: 0, peakBalance: 1000,
    triples: 0, bestStreak: 0, totalStake: 0, totalReturned: 0,
    gambleWins: 0, gambleLosses: 0
  }, '新存檔的 stats 欄位必須與契約一致');
  assert.notEqual(core.emptySave(), fresh, 'emptySave 必須每次回傳新物件');

  // 壞輸入全部要回到合法形狀。壞存檔是真的會發生的：改過的 localStorage、
  // 舊版格式、被別的分頁寫壞的 JSON —— 任何一種都不該讓遊戲開不起來。
  const junk = [
    undefined, null, 'x', '', 0, 42, true, [], [1, 2, 3], {},
    { v: 99 }, { v: '1' }, { balance: 'lots' }, { stats: 'none' },
    { history: 'none' }, { lastBets: {} }, { milestones: 'all' }
  ];
  junk.forEach(raw => {
    const label = JSON.stringify(raw) === undefined ? String(raw) : JSON.stringify(raw);
    let save = null;
    assert.doesNotThrow(() => { save = core.normalizeSave(raw); },
      `normalizeSave(${label}) 不得 throw`);
    assert.equal(save.v, 1, `normalizeSave(${label}) 的版本必須回到 1`);
    assert.equal(typeof save.balance, 'number', `normalizeSave(${label}) 的餘額必須是數字`);
    assert.ok(Number.isInteger(save.balance), `normalizeSave(${label}) 的餘額必須是整數`);
    assert.ok(Array.isArray(save.lastBets), `normalizeSave(${label}) 的 lastBets 必須是陣列`);
    assert.ok(Array.isArray(save.history), `normalizeSave(${label}) 的 history 必須是陣列`);
    assert.ok(Array.isArray(save.milestones), `normalizeSave(${label}) 的 milestones 必須是陣列`);
    assert.equal(typeof save.stats, 'object', `normalizeSave(${label}) 的 stats 必須是物件`);
    assert.equal(typeof save.stats.rounds, 'number', `normalizeSave(${label}) 的 stats 欄位必須補齊`);
  });

  // 含未知 bet id 的 lastBets：未知的丟掉，合法的留下
  const bets = core.normalizeSave({
    lastBets: [
      { id: 'sum-12', amount: 50 },
      { id: 'nope', amount: 50 },
      { id: 'bs-big', amount: 0 },        // 金額非正整數 → 丟掉
      { id: 'bs-small', amount: 1.5 },    // 非整數 → 丟掉
      { id: 'sum-12', amount: 10 },       // 重複 id → 只留第一筆，否則 rebet 會扣兩份餘額
      'not-an-object',
      { id: 'single-3', amount: 10 }
    ]
  }).lastBets;
  assert.deepEqual(bets, [{ id: 'sum-12', amount: 50 }, { id: 'single-3', amount: 10 }],
    'lastBets 必須只留下合法且不重複的注項');

  // 51 筆 history 截到 50 筆，且 sum 一律由骰面重算
  const raw51 = [];
  for (let i = 0; i < 51; i++) raw51.push({ dice: [1, 2, 3], sum: 999, net: i, streak: 0 });
  // 變數不取名 history：全站禁止頂層 let/const history（會遮蔽 window.history），
  // 這裡即使在函式內也避開這個名字，免得有人複製到遊戲層去。
  const trimmed = core.normalizeSave({ history: raw51 }).history;
  assert.equal(trimmed.length, 50, `history 必須截到 50 筆，實際 ${trimmed.length} 筆`);
  assert.equal(trimmed[0].net, 0, '最新在前，所以超量時砍掉的是尾端（最舊的那些）');
  assert.equal(trimmed[49].net, 49, '第 50 筆應該是原本的第 50 筆');
  assert.equal(trimmed[0].sum, 6, 'sum 必須由骰面重算，不可信存檔裡寫的 999');

  const dirtyHistory = core.normalizeSave({
    history: [
      { dice: [1, 2, 3], net: 10, streak: 1 },
      { dice: [1, 2], net: 10 },            // 骰面長度不符 → 整筆丟掉
      { dice: [1, 2, 7], net: 10 },         // 骰面超範圍 → 整筆丟掉
      { dice: 'abc', net: 10 },
      null,
      { dice: [6, 6, 6], net: 'lots', streak: -5 }
    ]
  }).history;
  assert.deepEqual(dirtyHistory, [
    { dice: [1, 2, 3], sum: 6, net: 10, streak: 1 },
    { dice: [6, 6, 6], sum: 18, net: 0, streak: 0 }
  ], '壞骰面的紀錄整筆丟掉，壞 net / streak 回退 0');

  // 數值夾到合法區間
  assert.equal(core.normalizeSave({ balance: -500 }).balance, 0, '負數餘額必須夾到 0');
  assert.equal(core.normalizeSave({ balance: 1e300 }).balance, 100000000,
    '餘額必須夾到 1 億，否則被改過的存檔會把畫面撐爆');
  assert.equal(core.normalizeSave({ balance: 1234.9 }).balance, 1234, '餘額必須是整數');
  assert.equal(core.normalizeSave({ balance: NaN }).balance, 1000, 'NaN 餘額必須回退預設值');
  assert.equal(core.normalizeSave({ streak: -1 }).streak, 0, '負數連勝必須夾到 0');
  assert.equal(core.normalizeSave({ stats: { rounds: -5, peakBalance: 'x' } }).stats.rounds, 0,
    '負數局數必須夾到 0');
  assert.equal(core.normalizeSave({ stats: { peakBalance: 'x' } }).stats.peakBalance, 1000,
    '壞 peakBalance 必須回退起始餘額');
  assert.deepEqual(core.normalizeSave({ milestones: ['streak-3', 'streak-3', 'nope', 42] }).milestones,
    ['streak-3'], '里程碑 id 必須去重並丟掉未知值');

  // 合法存檔原樣保留：正規化不得把玩家的進度洗掉
  const good = {
    v: 1,
    balance: 2500,
    streak: 3,
    lastBets: [{ id: 'sum-12', amount: 50 }],
    history: [{ dice: [2, 4, 6], sum: 12, net: 350, streak: 2 }],
    stats: {
      rounds: 12, wins: 5, biggestWin: 350, peakBalance: 2500,
      triples: 1, bestStreak: 3, totalStake: 600, totalReturned: 950,
      gambleWins: 1, gambleLosses: 0
    },
    milestones: ['balance-2000', 'streak-3']
  };
  assert.deepEqual(core.normalizeSave(good), good, '合法存檔必須原樣回傳');

  // 帶會拋錯 getter 的怪物件：存取屬性本身就會炸，仍必須安全回到全新存檔
  const booby = {};
  Object.defineProperty(booby, 'balance', { get() { throw new Error('boom'); }, enumerable: true });
  let recovered = null;
  assert.doesNotThrow(() => { recovered = core.normalizeSave(booby); },
    '屬性 getter 拋錯時 normalizeSave 仍不得 throw');
  assert.equal(recovered.balance, 1000, 'getter 拋錯時必須回到全新存檔');
});

test('normalizePrefs 回退非法 chip 並忽略未知欄位', () => {
  assert.deepEqual(core.emptyPrefs(), { sound: true, keepBets: true, chip: 10 },
    '預設偏好必須是開音效、保留注單、10 分籌碼');

  assert.equal(core.normalizePrefs({ chip: 37 }).chip, 10,
    '37 不是籌碼面額之一，必須回退 10，否則籌碼列會沒有任何一顆是選中狀態');
  assert.equal(core.normalizePrefs({ chip: '100' }).chip, 10, '字串化的面額必須回退 10');
  assert.equal(core.normalizePrefs({ chip: 0 }).chip, 10, '0 不是籌碼面額');
  core.CHIPS.forEach(chip => {
    assert.equal(core.normalizePrefs({ chip: chip }).chip, chip, `${chip} 是合法面額，必須保留`);
  });

  assert.equal(core.normalizePrefs({ sound: false }).sound, false, '關音效必須保留');
  assert.equal(core.normalizePrefs({ sound: 'off' }).sound, true, '非布林的 sound 必須回退 true');
  assert.equal(core.normalizePrefs({ keepBets: false }).keepBets, false, '關閉保留注單必須保留');
  assert.equal(core.normalizePrefs({ keepBets: 'yes' }).keepBets, true, '非布林的 keepBets 必須回退 true');

  // 未知欄位不影響其他欄位，也不得被帶進回傳值（避免壞資料一路寫回 localStorage）
  const extra = core.normalizePrefs({ chip: 500, sound: false, theme: 'dark', nope: 1 });
  assert.deepEqual(extra, { sound: false, keepBets: true, chip: 500 },
    '未知欄位必須被丟掉，主題由 BoboTheme 自己管，不該混進骰寶的偏好');

  [undefined, null, 'x', 42, [], true].forEach(bad => {
    let prefs = null;
    assert.doesNotThrow(() => { prefs = core.normalizePrefs(bad); },
      `normalizePrefs(${String(bad)}) 不得 throw`);
    assert.deepEqual(prefs, { sound: true, keepBets: true, chip: 10 },
      `normalizePrefs(${String(bad)}) 必須回到預設偏好`);
  });
});

test('formatNumber 千分位：0 / 1234 / -1234 / 1000000', () => {
  assert.equal(core.formatNumber(0), '0', '0 不加逗號');
  assert.equal(core.formatNumber(1234), '1,234', '四位數要有千分位');
  assert.equal(core.formatNumber(-1234), '-1,234', '負數保留負號');
  assert.equal(core.formatNumber(1000000), '1,000,000', '七位數要有兩個逗號');
  assert.equal(core.formatNumber(100), '100', '三位數不加逗號');
  assert.equal(core.formatNumber(999), '999', '三位數上界不加逗號');
  assert.equal(core.formatNumber(1000), '1,000', '四位數下界要加逗號');
  // 不用 toLocaleString：不同環境的 locale 會給出不同分隔符號（甚至全形），畫面與測試會對不起來
  assert.doesNotMatch(core.formatNumber(1234567), /[^\d,]/, '千分位符號只能是半角逗號');
  assert.equal(core.formatNumber(NaN), '0', 'NaN 一律當 0，畫面上永遠不該出現 NaN');
  assert.equal(core.formatNumber(Infinity), '0', 'Infinity 一律當 0');
  assert.equal(core.formatNumber('1234'), '1,234', '字串化的數字也要能格式化');
});

// ---------------------------------------------------------------------------
// G. 靜態契約掃描（正則掃原始碼，鎖住無法用單元測試表達的規則）
// ---------------------------------------------------------------------------

test('sic-bo-core.js 完全不碰 document / window / localStorage', () => {
  const src = needFile(CORE_PATH);

  // 核心必須同時被瀏覽器 <script> 與 Node require 吃下，所以連註解裡都不該出現這些名字，
  // 免得日後有人「照著註解」在核心裡加一行 DOM 存取。
  ['document', 'window', 'localStorage'].forEach(name => {
    assert.doesNotMatch(src, new RegExp(name),
      `sic-bo-core.js 不得出現 ${name}（核心是純邏輯，要能在 Node 裡載入）`);
  });

  // 亂數只能有一處，其餘全靠注入的 rng，測試才能重播同一局
  const randomHits = src.match(/Math\.random/g) || [];
  assert.equal(randomHits.length, 1,
    `Math.random 只能出現在預設 rng 那一處，實際 ${randomHits.length} 處`);

  // 模組樣式：IIFE + 尾端 module.exports 守衛（ESM 語法會讓 games.test.js 的 new Function 編譯失敗）
  assert.match(src, /const SicBoCore = \(\(\) => \{/, '必須是 const SicBoCore = (() => { … })() 的 IIFE');
  assert.match(src, /'use strict';/, 'IIFE 第一行必須是 use strict');
  assert.match(src, /if \(typeof module !== 'undefined' && module\.exports\) \{/,
    '檔尾必須有 module.exports 守衛，Node 測試才 require 得到');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m, '核心是 classic script，不得使用 ESM 語法');
  assert.doesNotThrow(() => new Function(src), 'sic-bo-core.js 必須能通過 new Function 編譯');
});

// AGENTS.md 第 4 條「防禦性錯誤處理」的自動化守門。
// 注意：不可退回成 assert.match(js, /try\s*\{/) 這種寫法 —— 檔案裡另有多處
// 與 localStorage 無關的 try（音效、vibrate、prefersReducedMotion…），
// 只要有任何一處存在就會通過，等於完全沒測。
test('sic-bo.js 每一處 localStorage 讀寫刪都在 try...catch 內，且無 alert 與頂層 history', () => {
  const js = needFile(JS_PATH);
  const code = blankLiterals(js);

  // 掃描器自我檢查：塗白後整份檔案的大括號必須配平，
  // 否則（例如出現含大括號的正規表示式字面值）下面的判斷都不可信，寧可紅燈。
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') depth -= 1;
  }
  assert.equal(depth, 0, '塗白後大括號不配平，靜態掃描結果不可信');

  // 只採計「後面真的接著 catch (」的 try 區塊，try…finally 不算有處理錯誤
  const guarded = tryBlockRanges(code).filter(
    ([, end]) => /^\s*catch\s*\(/.test(code.slice(end + 1, end + 40))
  );
  assert.ok(guarded.length > 0, 'sic-bo.js 必須至少有一個 try...catch');

  // localStorage.getItem / setItem / removeItem / clear 以及 localStorage[...] 全部要抓
  const accessRe = /localStorage\s*(?:\.\s*\w+|\[)/g;
  const accesses = [];
  let hit = accessRe.exec(code);
  while (hit) {
    accesses.push(hit.index);
    hit = accessRe.exec(code);
  }
  // 空洞性防護：掃不到任何存取時，下面的「全都包在 try 裡」會假性通過。
  // 只要求 2 處（一讀一寫）—— sic-bo.js 刻意把所有存取集中在
  // _sicboReadJson / _sicboWriteJson 兩支 helper 裡，這比分散四處更難漏包 try。
  // 真正要防的「存檔或偏好其中一個沒被持久化」改由下面兩條 key 斷言把關。
  assert.ok(accesses.length >= 2,
    `應至少掃到 2 處 localStorage 存取（一讀一寫），實際 ${accesses.length} 處`);

  // 兩個 key 都必須真的被讀也被寫，否則等於少了一半的持久化
  [['SAVE_KEY', '存檔'], ['PREF_KEY', '偏好']].forEach(([key, label]) => {
    assert.match(js, new RegExp('_sicboReadJson\\s*\\(\\s*_sicboCore\\.' + key),
      `${label}（${key}）沒有被讀回來`);
    assert.match(js, new RegExp('_sicboWriteJson\\s*\\(\\s*_sicboCore\\.' + key),
      `${label}（${key}）沒有被寫出去`);
  });

  const naked = accesses
    .filter(idx => !guarded.some(([start, end]) => idx > start && idx < end))
    .map(idx => lineOf(js, idx));
  assert.deepEqual(naked, [],
    `sic-bo.js 第 ${naked.join(' / ')} 行的 localStorage 存取沒有被 try...catch 包住`);

  // alert 會卡住 headless Chrome 的 JS 執行緒（smoke 測試會逾時），一律改用 toast
  assert.doesNotMatch(js, /\balert\s*\(/, '不得使用 alert，餘額不足之類的提示一律走 toast');

  // 頂層 let/const history 會遮蔽 window.history，這是舊版既有 bug
  assert.doesNotMatch(js, /^\s*(let|const)\s+history\b/m,
    '不得宣告頂層 let/const history（會遮蔽 window.history），狀態請放在類別實例裡');

  // 核心必須真的被用到：邏輯留在 sic-bo.js 裡等於核心測試白測。
  // 允許 _sicboCore 這個別名 —— 共用模組是頂層 const，只能用 typeof 守衛取得，
  // sic-bo.js 因此在檔頭做一次 const _sicboCore = (typeof SicBoCore !== 'undefined') ? … : null
  // 再全檔沿用。強迫每個呼叫點都寫裸的 SicBoCore. 反而會繞過那道守衛。
  assert.match(js, /typeof\s+SicBoCore\s*!==\s*'undefined'/,
    'sic-bo.js 必須用 typeof 守衛取得 SicBoCore（它是 const，不掛在 window 上）');
  assert.match(js, /(?:SicBoCore|_sicboCore)\.settle\s*\(/, '結算必須走核心的 settle');
  assert.match(js, /(?:SicBoCore|_sicboCore)\.normalizeSave\s*\(/, '讀檔必須經過核心的 normalizeSave');

  // 反向把關：賠付數學不得在遊戲層重寫一份。押注乘倍率這種算式只能出現在核心。
  assert.doesNotMatch(js, /\bmultiplier\s*\*/, '賠付算式不得出現在遊戲層，請留在 sic-bo-core.js');

  // 共用模組是 const，不掛在 window 上，只能用 typeof 守衛
  ['BoboAudio', 'BoboTheme', 'BoboConfetti', 'Stats'].forEach(name => {
    assert.doesNotMatch(js, new RegExp('window\\.' + name + '\\b'),
      `不得用 window.${name} 偵測共用模組（它是 const，不會掛在 window 上）`);
  });

  assert.doesNotThrow(() => new Function(js), 'sic-bo.js 必須能通過 new Function 編譯');
});

test('index.html 具備防閃爍 snippet、四支共用模組、Stats 記錄與 50 格注格，且無 inline onclick', () => {
  const html = needFile(HTML_PATH);
  const js = needFile(JS_PATH);

  // 全部事件委派，不用 inline handler
  assert.doesNotMatch(html, /onclick\s*=/i, '不得使用 inline onclick，事件一律委派');

  // 防閃爍：外部 script 在 body 末尾，若不先內嵌一段同步讀偏好，深色使用者會先看到白底閃一下
  assert.match(html, /bobo-home-preferences-v2/,
    '防閃爍 snippet 必須讀首頁的 bobo-home-preferences-v2 偏好');
  assert.match(html, /dataset\.theme/, '防閃爍 snippet 必須在 documentElement 上寫入 dataset.theme');

  assert.match(html, /viewport-fit=cover/, 'viewport 必須含 viewport-fit=cover，安全區域才算得準');
  assert.match(html, /<meta\s+name="theme-color"/, '必須有 theme-color meta');
  assert.match(html, /data-theme-color-dark="#101410"/, 'theme-color 必須帶深色主題的值');
  assert.match(html, /data-theme-color-light="#f4f1ea"/, 'theme-color 必須帶淺色主題的值');

  // 四支共用模組一律用 ../../assets/js/ 相對路徑（集中式 assets/ 路徑已移除）
  const SHARED_PREFIX = '../../assets/js/';
  ['bobo-theme.js', 'bobo-audio.js', 'bobo-confetti.js', 'stats.js'].forEach(name => {
    assert.ok(html.includes('src="' + SHARED_PREFIX + name + '"'),
      `index.html 必須以 ${SHARED_PREFIX}${name} 引用共用模組`);
  });
  assert.doesNotMatch(html, /["'(]assets\/(css|js|images|favicons)\//,
    'index.html 不得出現「引號或左括號緊接 assets/」的舊集中式路徑');

  // 核心必須在遊戲層之前載入（classic script，沒有模組相依解析幫忙）
  const coreIndex = html.indexOf('src="sic-bo-core.js"');
  const mainIndex = html.indexOf('src="sic-bo.js"');
  assert.ok(coreIndex !== -1, 'index.html 未載入 sic-bo-core.js');
  assert.ok(mainIndex !== -1, 'index.html 未載入 sic-bo.js');
  assert.ok(coreIndex < mainIndex, 'sic-bo-core.js 必須在 sic-bo.js 之前載入');

  // 遊玩次數只能記一次：html 與 js 兩邊都寫就會每局都重複計數
  const hits = (html + js).match(/Stats\.recordGamePlay\(\s*['"]sic-bo['"]\s*\)/g) || [];
  assert.equal(hits.length, 1, `Stats.recordGamePlay('sic-bo') 應只出現 1 次，實際 ${hits.length} 次`);
  assert.match(html, /href="\.\.\/\.\.\/index\.html"/, '必須有回首頁連結');
  assert.match(html, /rel="icon"[^>]*href="\.\.\/\.\.\/assets\/favicons\/favicon\.svg"/,
    'favicon 必須指向 ../../assets/favicons/favicon.svg');

  // 每顆 button 都要有 type="button"：預設的 submit 在某些瀏覽器會觸發表單送出／頁面重載
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.ok(buttons.length >= 50, `注格與控制鍵加起來應有 50 顆以上 button，實際 ${buttons.length} 顆`);
  const untyped = buttons.filter(tag => !/\btype="button"/.test(tag));
  assert.deepEqual(untyped, [], `這些 button 缺少 type="button"：${untyped.join(' / ')}`);

  // DOM 與核心目錄的交叉檢查：少一格就等於有一種注永遠押不到
  const missing = core.BETS.filter(bet => !html.includes('data-bet="' + bet.id + '"')).map(bet => bet.id);
  assert.deepEqual(missing, [], `index.html 缺少這些注格：${missing.join(', ')}`);

  // 契約釘死的 id 一個都不能少（遊戲層全靠這些 id 接線）
  [
    'confetti-canvas', 'toast-container', 'theme-btn', 'sound-btn', 'stats-btn', 'help-btn',
    'dice-tray', 'result-msg', 'result-sub', 'streak-meter', 'streak-fill', 'streak-label',
    'balance', 'total-bet', 'bet-table', 'chip-rail', 'roll-btn', 'rebet-btn', 'clear-btn',
    'gamble-panel', 'gamble-die', 'gamble-amount', 'gamble-small', 'gamble-big', 'gamble-take',
    'history-list', 'history-empty', 'stats-modal', 'help-modal', 'broke-modal',
    'stats-body', 'broke-body', 'restart-btn'
  ].forEach(id => {
    assert.ok(html.includes('id="' + id + '"'), `缺少 id="${id}" 的元素`);
  });
});

test('sic-bo.css 具備深色覆寫、reduced-motion、sticky 版面與 dvh，且寬度不得用 vw', () => {
  const css = needFile(CSS_PATH);

  assert.match(css, /:root\[data-theme="dark"\]/, '深色主題必須用 :root[data-theme="dark"] 覆寫');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    '檔尾必須有 prefers-reduced-motion 區塊，關掉動畫後仍要能玩完一局');
  // 手機版面的核心：.stage 吸頂 + .control-dock 固定在底部，下注時骰子與 PLAY 永遠同屏
  assert.match(css, /position:\s*sticky/, '.stage 必須吸頂（舊版最大的問題是下注區與 PLAY 不同屏）');
  assert.match(css, /position:\s*fixed/, '.control-dock 在手機版面必須固定在底部');
  assert.match(css, /env\(safe-area-inset-bottom\)/, '底部 dock 必須讓開 iOS 的安全區域');
  assert.match(css, /100dvh/, '高度必須補一行 100dvh（行動瀏覽器的網址列會吃掉 vh）');

  // 寬度用 vw 會把捲軸寬度算進去，造成整頁橫向捲動
  assert.doesNotMatch(css, /width:\s*[^;]*\bvw\b/,
    '寬度一律 width: 100% + max-width，不得使用 vw 單位');

  // 舊版的 max-height 斷點與寬度斷點打架（既有 bug #6.4），矮螢幕靠 sticky + fixed 版面自然解決
  assert.doesNotMatch(css, /@media[^{]*max-height/,
    '不得使用 max-height 斷點，它會與寬度斷點打架');

  ['.bet-cell', '.bet-grid', '.control-dock', '.chip-rail', '.die__cube', '.die__face', '.float-gain']
    .forEach(selector => {
      assert.ok(css.includes(selector), `sic-bo.css 缺少 ${selector} 樣式`);
    });
});
