// 骰寶純邏輯核心：注項目錄、開骰、逐注結算、連勝加成、懸念判定與存檔驗證。
// 這個檔案不得碰 DOM、瀏覽器儲存或任何頁面全域，才能同時被瀏覽器與 Node 測試載入。
// 唯一的亂數來源集中在 defaultRng 一處，所有對外函式都接受注入的 rng，測試才能重播同一局。
const SicBoCore = (() => {
  'use strict';

  // --- 常數 ---
  const SAVE_KEY = 'sicbo_save_v1';
  const PREF_KEY = 'sicbo_pref_v1';
  const SAVE_VERSION = 1;
  const START_BALANCE = 1000;
  const CHIPS = Object.freeze([10, 50, 100, 500]);
  const HISTORY_LIMIT = 50;
  const STREAK_STEP = 0.1;        // 每連勝一局 +10%
  const STREAK_MAX = 0.5;         // 上限 +50%
  const STREAK_MIN_LEVEL = 2;     // 連勝達 2 才開始有加成
  const GAMBLE_MAX_ROUNDS = 3;    // 翻倍挑戰最多連續 3 次

  const DICE_COUNT = 3;
  const DIE_FACES = 6;
  const TOTAL_OUTCOMES = 216;     // 6³。所有賠率與莊家優勢都以這個分母驗算
  const MAX_AMOUNT = 100000000;   // 存檔金額上限（1 億）：被改過的存檔灌進 1e308 時不該讓畫面爆版
  const MAX_STREAK = 9999;        // 連勝的荒謬上限，純粹防存檔被亂改

  // 連勝加成在內部用「十分之幾」的整數運算。0.1 在二進位是無限循環小數，
  // 直接寫 (level - 1) * 0.1 會得到 0.30000000000000004，畫面上印成「+30.000000000000004%」很醜，
  // 而且逐次相乘的誤差有機會讓玩家少拿 1 分。整數乘完最後才除 10，結果永遠是乾淨的 0.1～0.5。
  const STREAK_STEP_TENTHS = Math.round(STREAK_STEP * 10);
  const STREAK_MAX_TENTHS = Math.round(STREAK_MAX * 10);

  // --- 注項型別 ---
  const BET_TYPES = Object.freeze({
    BIG_SMALL: 'bs',              // value: 'big' | 'small'
    TRIPLE_ANY: 'triple_any',     // value: 'any'
    TRIPLE_ONE: 'triple_one',     // value: 1..6（特定圍骰）
    SUM: 'sum',                   // value: 4..17
    COMBO: 'combo',               // value: 'a-b' 字串，a < b
    DOUBLE: 'double',             // value: 1..6
    SINGLE: 'single'              // value: 1..6
  });

  // 點數賠率表（釘死）。左右對稱，且已用 216 種骰面驗算過莊家優勢全部落在 2.78%–16.67%。
  // 舊版有兩個離群值在這裡被校正掉：sum 5/16 的 20:1（RTP 只有 58%，全表最差）改成 30:1，
  // sum 9/12 的 6:1（RTP 81%）改成 7:1。其餘沿用舊版，行為不回退。
  const SUM_MULTIPLIERS = Object.freeze({
    4: 60, 5: 30, 6: 18, 7: 12, 8: 8, 9: 7, 10: 6,
    11: 6, 12: 7, 13: 8, 14: 12, 15: 18, 16: 30, 17: 60
  });

  const MILESTONES = Object.freeze([
    { id: 'balance-2000', type: 'balance', value: 2000, label: '餘額破 2,000' },
    { id: 'balance-5000', type: 'balance', value: 5000, label: '餘額破 5,000' },
    { id: 'balance-10000', type: 'balance', value: 10000, label: '餘額破 10,000' },
    { id: 'balance-50000', type: 'balance', value: 50000, label: '餘額破 50,000' },
    { id: 'win-500', type: 'bigWin', value: 500, label: '單局淨賺 500' },
    { id: 'win-2000', type: 'bigWin', value: 2000, label: '單局淨賺 2,000' },
    { id: 'streak-3', type: 'streak', value: 3, label: '三連勝' },
    { id: 'streak-5', type: 'streak', value: 5, label: '五連勝' },
    { id: 'streak-8', type: 'streak', value: 8, label: '八連勝' },
    { id: 'triple-1', type: 'triples', value: 1, label: '開出圍骰' },
    { id: 'rounds-50', type: 'rounds', value: 50, label: '玩滿 50 局' },
    { id: 'rounds-200', type: 'rounds', value: 200, label: '玩滿 200 局' }
  ].map(item => Object.freeze(item)));

  // 存檔的 stats 欄位與各自的預設值。集中成一張表，emptySave 與 normalizeSave 共用，
  // 以免「新增一個統計欄位卻忘了在驗證函式補上」造成舊存檔讀回來是 undefined。
  const STATS_FIELDS = Object.freeze({
    rounds: 0,
    wins: 0,
    biggestWin: 0,
    peakBalance: START_BALANCE,
    triples: 0,
    bestStreak: 0,
    totalStake: 0,
    totalReturned: 0,
    gambleWins: 0,
    gambleLosses: 0
  });

  // --- 基礎工具 ---

  function isFace(value) {
    return Number.isInteger(value) && value >= 1 && value <= DIE_FACES;
  }

  // 陣列刻意排除：`[]` 或 `[1,2]` 被當成物件塞進存檔時，欄位一律回退預設值而不是硬套。
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // combo 的 value 是 'a-b' 字串（a < b）。解析集中在這裡，
  // 讓「畫面上的兩顆點數圖」與「結算用的兩個點數」共用同一份真相。
  function parseCombo(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split('-');
    if (parts.length !== 2) return null;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!isFace(a) || !isFace(b) || a >= b) return null;
    return [a, b];
  }

  // --- 注項目錄 ---

  function makeBet(id, type, value, multiplier, group, label, pips) {
    return Object.freeze({
      id: id,
      type: type,
      value: value,
      multiplier: multiplier,
      group: group,
      label: label,
      pips: pips ? Object.freeze(pips) : null
    });
  }

  // 50 格全部用迴圈生成：手打 50 個物件字面值等於把賠率表抄兩遍，
  // 漏改一格不會有任何人發現（舊版就是 29 顆按鈕把注型與賠率散在 HTML 屬性裡）。
  function buildBets() {
    const list = [];

    // 大小列：任意圍骰刻意夾在「小」與「大」中間，維持賭桌排法，
    // 順便在視覺上提醒玩家「圍骰會通殺大小」這條規則。
    list.push(makeBet('bs-small', BET_TYPES.BIG_SMALL, 'small', 1, 'bs', '小', null));
    list.push(makeBet('triple-any', BET_TYPES.TRIPLE_ANY, 'any', 30, 'bs', '任意圍骰', null));
    list.push(makeBet('bs-big', BET_TYPES.BIG_SMALL, 'big', 1, 'bs', '大', null));

    // 點數只到 4–17：3 與 18 必然是圍骰，那兩種盤面由圍骰注項吃掉。
    for (let sum = 4; sum <= 17; sum++) {
      list.push(makeBet('sum-' + sum, BET_TYPES.SUM, sum, SUM_MULTIPLIERS[sum], 'sum', String(sum), null));
    }

    // 兩骰組合 15 組。外圈 a、內圈 b 的巡訪順序就是畫面順序（1-2 1-3 … 5-6）。
    for (let a = 1; a < DIE_FACES; a++) {
      for (let b = a + 1; b <= DIE_FACES; b++) {
        const value = a + '-' + b;
        list.push(makeBet('combo-' + value, BET_TYPES.COMBO, value, 5, 'combo', a + '+' + b, parseCombo(value)));
      }
    }

    for (let v = 1; v <= DIE_FACES; v++) {
      list.push(makeBet('double-' + v, BET_TYPES.DOUBLE, v, 11, 'double', '對子 ' + v, [v, v]));
    }
    for (let v = 1; v <= DIE_FACES; v++) {
      list.push(makeBet('triple-' + v, BET_TYPES.TRIPLE_ONE, v, 180, 'triple', '圍骰 ' + v, [v, v, v]));
    }
    // 單骰的 multiplier 寫 1 只是「中 1 顆賠 1 倍」的門面值，
    // 真正的賠付看命中顆數（見 settleLine）。舊版第 11 號問題就是這個欄位看起來像死欄位，
    // 一旦「順手」改成吃 multiplier，中 2、3 顆的加成就會靜靜消失。
    for (let v = 1; v <= DIE_FACES; v++) {
      list.push(makeBet('single-' + v, BET_TYPES.SINGLE, v, 1, 'single', '單骰 ' + v, [v]));
    }

    return Object.freeze(list);
  }

  const BETS = buildBets();

  const BETS_BY_ID = Object.freeze(BETS.reduce((map, bet) => {
    map[bet.id] = bet;
    return map;
  }, {}));

  // 一律走 hasOwnProperty：直接寫 BETS_BY_ID[id] 的話，getBet('constructor') 會從原型鏈
  // 撈到一個函式並被後續流程當成合法注項（存檔被亂改時真的會走到這條路）。
  function getBet(id) {
    if (typeof id !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(BETS_BY_ID, id)) return null;
    return BETS_BY_ID[id];
  }

  // --- 骰子與盤面分析 ---

  function defaultRng() {
    return Math.random();
  }

  // rng 不是函式（undefined、null、被誤傳的物件）時退回預設亂數，
  // 呼叫端就不必每次都自己補一句預設值。
  function resolveRng(rng) {
    return typeof rng === 'function' ? rng : defaultRng;
  }

  function rollDie(rng) {
    const value = Math.floor(resolveRng(rng)() * DIE_FACES) + 1;
    // 夾住上下界：注入的假 rng 回傳剛好 1（或負數）時會生出 7 或 0 這種不存在的骰面，
    // 那會讓後面所有 counts[] 索引都錯位。
    if (value < 1) return 1;
    if (value > DIE_FACES) return DIE_FACES;
    return value;
  }

  function assertDice(dice, label) {
    const name = label || '骰子';
    if (!Array.isArray(dice) || dice.length !== DICE_COUNT) {
      throw new TypeError(name + '必須是長度 ' + DICE_COUNT + ' 的陣列');
    }
    for (let i = 0; i < dice.length; i++) {
      if (!isFace(dice[i])) {
        throw new TypeError(name + '第 ' + (i + 1) + ' 顆必須是 1 到 6 的整數，收到 ' + String(dice[i]));
      }
    }
  }

  function roll(rng) {
    const source = resolveRng(rng);
    const dice = [];
    for (let i = 0; i < DICE_COUNT; i++) dice.push(rollDie(source));
    return dice;
  }

  function analyze(dice) {
    assertDice(dice, '骰子');

    // counts 長度 7，索引 0 空著不用，這樣 counts[點數] 就能直接讀，不必到處寫 -1。
    const counts = new Array(DIE_FACES + 1).fill(0);
    let sum = 0;
    for (let i = 0; i < dice.length; i++) {
      counts[dice[i]] += 1;
      sum += dice[i];
    }

    let tripleValue = null;
    for (let v = 1; v <= DIE_FACES; v++) {
      if (counts[v] === DICE_COUNT) tripleValue = v;
    }
    const isTriple = tripleValue !== null;

    // 圍骰時 bigSmall 是 'triple' 而不是 'small'/'big'：圍骰通殺大小兩邊，
    // 這裡就把「第三種結果」明確表達出來，結算與歷史紀錄才不會各寫一份大小判定
    // （舊版第 12 號問題：同一個謂詞有兩份實作）。
    const bigSmall = isTriple ? 'triple' : (sum <= 10 ? 'small' : 'big');

    return {
      dice: dice.slice(),
      sum: sum,
      counts: counts,
      isTriple: isTriple,
      tripleValue: tripleValue,
      bigSmall: bigSmall
    };
  }

  // --- 結算 ---

  // 逐注判定。回傳 { won, payout }，payout 是純贏分（不含本金）。
  // won 與 payout 分開回傳是刻意的：舊版用 `winAmount > 0` 當「有沒有中」的守門，
  // 未來只要出現一個賠率 0 的和局注，本金就會被靜靜沒收。
  function settleLine(bet, amount, analysis) {
    const counts = analysis.counts;

    switch (bet.type) {
      case BET_TYPES.BIG_SMALL:
        // 共用 analyze 的 bigSmall，圍骰時它是 'triple'，兩邊自然都不中（通殺）。
        if (analysis.bigSmall !== bet.value) return { won: false, payout: 0 };
        return { won: true, payout: amount * bet.multiplier };

      case BET_TYPES.TRIPLE_ANY:
        if (!analysis.isTriple) return { won: false, payout: 0 };
        return { won: true, payout: amount * bet.multiplier };

      case BET_TYPES.TRIPLE_ONE:
        if (!analysis.isTriple || analysis.tripleValue !== bet.value) return { won: false, payout: 0 };
        return { won: true, payout: amount * bet.multiplier };

      case BET_TYPES.SUM:
        if (analysis.sum !== bet.value) return { won: false, payout: 0 };
        return { won: true, payout: amount * bet.multiplier };

      case BET_TYPES.COMBO: {
        const pair = parseCombo(bet.value);
        if (!pair) return { won: false, payout: 0 };
        if (counts[pair[0]] < 1 || counts[pair[1]] < 1) return { won: false, payout: 0 };
        return { won: true, payout: amount * bet.multiplier };
      }

      case BET_TYPES.DOUBLE:
        // 圍骰（3 顆同點）也算中對子，沿用舊版行為。
        if (counts[bet.value] < 2) return { won: false, payout: 0 };
        return { won: true, payout: amount * bet.multiplier };

      case BET_TYPES.SINGLE:
        // 唯一不看 multiplier 的注型：命中 1/2/3 顆就賠 1/2/3 倍。
        if (counts[bet.value] < 1) return { won: false, payout: 0 };
        return { won: true, payout: amount * counts[bet.value] };

      default:
        // 未知注型當成沒中而不是拋錯：目錄是凍結的，走到這裡只可能是日後新增型別忘了補 case。
        return { won: false, payout: 0 };
    }
  }

  function assertBetList(bets) {
    if (!Array.isArray(bets)) throw new TypeError('下注清單必須是陣列');

    const entries = [];
    for (let i = 0; i < bets.length; i++) {
      const raw = bets[i];
      if (!isPlainObject(raw)) {
        throw new TypeError('第 ' + (i + 1) + ' 筆下注必須是 { id, amount } 物件');
      }
      const bet = getBet(raw.id);
      if (!bet) throw new TypeError('未知的注項 id：' + String(raw.id));
      if (!Number.isInteger(raw.amount) || raw.amount <= 0) {
        throw new TypeError('注項 ' + bet.id + ' 的押注金額必須是正整數，收到 ' + String(raw.amount));
      }
      entries.push({ bet: bet, amount: raw.amount });
    }
    return entries;
  }

  // streakLevel 來自 UI 的計數器，壞值（NaN、字串、負數）一律當成 0 而不是拋錯：
  // 連勝只是加成，弄丟加成頂多少賺，讓整局結算炸掉才是災難。
  function toStreakLevel(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_STREAK, Math.floor(value));
  }

  // 連勝 2 → +10%，3 → +20%，…，6 以上封頂 +50%。回傳的是「十分之幾」的整數。
  function streakTenthsFor(level) {
    if (level < STREAK_MIN_LEVEL) return 0;
    return Math.min(STREAK_MAX_TENTHS, (level - STREAK_MIN_LEVEL + 1) * STREAK_STEP_TENTHS);
  }

  function settle(bets, dice, options) {
    const analysis = analyze(dice);
    const entries = assertBetList(bets);
    const opts = isPlainObject(options) ? options : {};
    const streakLevel = toStreakLevel(opts.streakLevel);
    const streakTenths = streakTenthsFor(streakLevel);

    const lines = [];
    let stake = 0;
    let basePayout = 0;
    let returnedFromLines = 0;

    for (let i = 0; i < entries.length; i++) {
      const bet = entries[i].bet;
      const amount = entries[i].amount;
      const outcome = settleLine(bet, amount, analysis);
      const payout = outcome.won ? outcome.payout : 0;
      // 輸的注本金不退：本金在下注瞬間就從餘額扣掉了，這裡不補就等於沒收。
      const returned = outcome.won ? amount + payout : 0;

      stake += amount;
      basePayout += payout;
      returnedFromLines += returned;

      lines.push({
        id: bet.id,
        type: bet.type,
        value: bet.value,
        amount: amount,
        multiplier: bet.multiplier,
        won: outcome.won,
        payout: payout,
        returned: returned
      });
    }

    // 加成只在整局合計後取一次整。逐注四捨五入會讓 ×1 的注在 +10%～+40% 完全吃不到加成
    // （floor(10 × 0.1) 之類的小數被吃掉），到 +50% 又忽然跳成 ×2，玩家會覺得加成是假的。
    //
    // 【缺陷 1（BLOCKER）修復】加成的基底是「本局真正賺到的錢」，不是中獎注的毛贏分。
    // 舊版寫 Math.floor(basePayout * streakRate)，而 basePayout 只看中獎注、完全不管本局
    // 到底有沒有賺錢，於是開出一個無限刷分漏洞：把注押在互斥結果上（例如 大 500 + 小 500
    // + 任意圍骰 40，總押注 1,040），毛贏分永遠很大而淨損益貼在 0 附近 ——
    // 非圍骰時 basePayout 500 → 加成 50 → net +10，圍骰時 basePayout 1,200 → 加成 120 → net +320，
    // 216 種骰面全部 net > 0。won 恆真 → 連勝永不歸零 → 加成升到 +50% 封頂 → 餘額無上限成長
    // （審查員用真的 Chrome 實跑 40～3,000 局，零敗局、財富單調成長）。
    // 改用淨賺當基底後，純對沖（returnedFromLines === stake）拿不到任何加成，
    // 上面那份注單在非圍骰時就回到 net = -40，風險機制才回得來。
    // 另一個副作用是 won（net > 0）從此等價於 returnedFromLines > stake：加成不再能把平局或
    // 輸局推成「贏」，連勝計數也就不會被對沖注單騙。
    const streakBase = returnedFromLines > stake ? returnedFromLines - stake : 0;
    const streakRate = streakTenths / 10;
    // 乘的是整數「十分之幾」再除 10，而不是乘 streakRate：與上面 streakTenths 同源，
    // 不必去推敲 0.3 這類二進位近似值落在 floor 邊界時會往哪邊倒。
    const streakBonus = Math.floor(streakBase * streakTenths / 10);
    const returned = returnedFromLines + streakBonus;
    const net = returned - stake;

    return {
      dice: analysis.dice,
      sum: analysis.sum,
      isTriple: analysis.isTriple,
      bigSmall: analysis.bigSmall,
      stake: stake,
      lines: lines,
      basePayout: basePayout,
      streakLevel: streakLevel,
      streakRate: streakRate,
      streakBonus: streakBonus,
      returned: returned,
      net: net,
      won: net > 0
    };
  }

  // --- 懸念判定 ---

  // 第三顆骰子落下前，判斷「這一注單是不是真的還沒定勝負」。
  //
  // 【缺陷 3 修復】舊判準是「桌上有沒有倍數 ≥ minMultiplier（預設 6）的注可能中」，
  // 那既停錯地方又漏掉真正的懸念：216 面枚舉實測，只押「點數 10」時 75.0% 的局都會停頓
  // （每一局 +500ms，那已經不是懸念而是常態延遲），而「大」「小」「單骰 4」「組合 2-5」
  // 全部 0.0% —— 偏偏這四種是新手最常押、也最典型「等最後一顆」的注（押大小時前兩顆和
  // 落在 5–9 就是第三顆決勝負，機率 66.7%）。倍數大小跟「勝負定了沒」根本是兩件事。
  //
  // 新判準直接問本局的勝負：枚舉第三顆的 6 種可能，用 settle 算出每種情況的 net，
  // 「至少一種會贏、但不是全部都贏」才是有懸念。全 6 種都贏或全 6 種都輸 = 勝負已定。
  // 連勝級數不必傳進來：加成只在淨賺為正時加分（見 settle），不會把輸局翻成贏局，
  // 勝負的分界線不受連勝影響。
  //
  // 「連續觸發兩局後跳過一局」這類節流是遊戲層的事，核心刻意不記任何狀態。
  function suspense(bets, firstTwo, options) {
    if (!Array.isArray(bets) || bets.length === 0) return false;
    if (!Array.isArray(firstTwo) || firstTwo.length !== 2 || !isFace(firstTwo[0]) || !isFace(firstTwo[1])) {
      throw new TypeError('前兩顆骰子必須是長度 2 且值為 1 到 6 的陣列');
    }

    const opts = isPlainObject(options) ? options : {};
    // minPayout 預設 0（不設限）：任何會讓本局淨賺的結果都算「還有懸念」。
    // 呼叫端想要「只為大錢停頓」時才傳；門檻比對的是本局淨賺，所以只有在同時傳進
    // 真實押注金額時才有意義。
    const minPayout = (typeof opts.minPayout === 'number' && Number.isFinite(opts.minPayout) && opts.minPayout > 0)
      ? opts.minPayout
      : 0;

    // 帶著真實金額進 settle：「贏」是本局淨損益為正，而那件事取決於各注的金額比例
    // （大 500 + 小 500 不管第三顆開什麼都打平，一點懸念也沒有）。
    // 金額缺失或不合法時退回 1，讓 UI 在金額還沒定案時也能問這個問題，而不是在這裡丟 TypeError。
    const entries = [];
    for (let i = 0; i < bets.length; i++) {
      const raw = bets[i];
      const bet = isPlainObject(raw) ? getBet(raw.id) : null;
      if (!bet) continue;   // 未知 id 靜靜跳過：懸念只是演出節奏，不值得為它拋錯
      const amount = (Number.isInteger(raw.amount) && raw.amount > 0) ? raw.amount : 1;
      entries.push({ id: bet.id, amount: amount });
    }
    if (entries.length === 0) return false;

    let wins = 0;
    for (let third = 1; third <= DIE_FACES; third++) {
      const result = settle(entries, [firstTwo[0], firstTwo[1], third], null);
      if (result.net > 0 && result.net >= minPayout) wins += 1;
    }
    return wins > 0 && wins < DIE_FACES;
  }

  // --- 差一點 ---

  // 每種近失情境的稀有度 = 216 種骰面裡有多少面會對「同一注」觸發它（數字越小越稀有）。
  //
  // 【缺陷 2 修復】舊版用固定優先序（點數 → 特定圍骰 → 任意圍骰 → 組合 → 對子），
  // 結果只押 combo-2-5 的人 65.6% 的輸局都被同一句「2 和 5 只開出了其中一個」洗版
  // （那是全表最常見的情境，122/216），而押大小或單骰的人一次都看不到近失文案
  // （舊規則根本沒涵蓋這兩型）。安慰句一旦每兩三局就重複一次，就退化成背景雜訊。
  // 改成依稀有度排序、回傳最稀有的那一個：罕見的近失（圍骰通殺、點數差 1）才不會
  // 被常見的（組合只差一顆）蓋掉。
  //
  // 下面每個數字都是三顆骰的組合數學結果，測試會用 216 枚舉逐一驗證，不是憑感覺填的。
  const NEAR_MISS_RARITY = Object.freeze({
    // 押小卻被圍骰通殺（1,1,1 / 2,2,2 / 3,3,3；押大是 4,4,4 / 5,5,5 / 6,6,6）→ 3 面
    BS_SWEEP: 3,
    // 押特定圍骰而該點數剛好開兩顆：3（哪一顆是雜魚）× 5（雜魚是什麼）= 15 面
    TRIPLE_ONE: 15,
    // 押小卻開出 11 點 / 押大卻開出 10 點：該點數的面數 = 27 面
    BS_EDGE: 27,
    // 押單骰 V 沒開出 V，但 V 的對面（7−V）開了：125（無 V）− 64（無 V 也無 7−V）= 61 面
    SINGLE_FLIP: 61,
    // 押對子而該點數只開一顆：3（哪一顆）× 25（另外兩顆都不是它）= 75 面
    DOUBLE_ONE: 75,
    // 押任意圍骰而任一點數開兩顆：6（哪個點數）× 15 = 90 面
    TRIPLE_ANY: 90,
    // 押組合而兩個點數只開出一個：2 ×（125 − 64）= 122 面，全表最常見
    COMBO_HALF: 122
  });

  // 三顆骰的點數分佈（分母 216），索引即點數，3–18 之外一律 0。
  // 「點數差 1」的稀有度必須逐格算：押 4 點只有 7 面（3 點的 1 面 + 5 點的 6 面），
  // 押 10 點卻有 52 面（9 點 25 + 11 點 27），同一種情境在兩端的罕見程度差 7 倍，
  // 共用一個常數會讓「押 4 點只差 1 點」這種真正罕見的事被組合注的常見近失壓下去。
  const SUM_OUTCOME_COUNTS = Object.freeze([
    0, 0, 0, 1, 3, 6, 10, 15, 21, 25, 27, 27, 25, 21, 15, 10, 6, 3, 1
  ]);

  function sumOutcomeCount(sum) {
    if (!Number.isInteger(sum) || sum < 0 || sum >= SUM_OUTCOME_COUNTS.length) return 0;
    return SUM_OUTCOME_COUNTS[sum];
  }

  // 只在本局淨損為負時由 UI 呼叫，回傳 null 或 { betId, kind, rarity, message }。
  // - `kind` 是穩定的情境代號，遊戲層靠它做節流（同一句 N 局內不重複）。核心刻意不記狀態。
  // - `rarity` 越小越稀有；同稀有度時保留「玩家下注順序」的第一筆，結果才穩定可預期。
  // 找不到任何近失情境時回 null（UI 就不顯示副訊息）—— 這條路必須留著，
  // 否則每一個輸局都硬掏一句安慰話，那又變成另一種洗版。
  function nearMiss(bets, dice) {
    const analysis = analyze(dice);
    if (!Array.isArray(bets) || bets.length === 0) return null;

    const counts = analysis.counts;
    const candidates = [];
    const add = (bet, kind, rarity, message) => {
      candidates.push({ betId: bet.id, kind: kind, rarity: rarity, message: message });
    };

    for (let i = 0; i < bets.length; i++) {
      const entry = bets[i];
      const bet = isPlainObject(entry) ? getBet(entry.id) : null;
      if (!bet) continue;   // 未知 id 靜靜跳過：差一點只是安慰文案，不值得為它拋錯

      switch (bet.type) {
        case BET_TYPES.BIG_SMALL: {
          // 新增情境 ①：圍骰通殺。點數明明落在自己押的那一半，卻被圍骰整局吃掉，
          // 是全表最罕見（3/216）也最需要解釋的一種輸法 —— 不講清楚，玩家會以為賠率算錯。
          if (analysis.isTriple) {
            const wouldBe = analysis.sum <= 10 ? 'small' : 'big';
            if (wouldBe === bet.value) {
              add(bet, 'bs-sweep', NEAR_MISS_RARITY.BS_SWEEP,
                '圍骰通殺！開出三顆 ' + analysis.tripleValue + '，'
                + analysis.sum + ' 點本來算' + bet.label);
            }
            break;
          }
          // 新增情境 ②：只差 1 點就落在自己那一半（押小開 11 點、押大開 10 點）。
          // 大小是最入門的注，卻是舊版唯一一次近失文案都拿不到的注型。
          if (bet.value === 'small' && analysis.sum === 11) {
            add(bet, 'bs-edge', NEAR_MISS_RARITY.BS_EDGE, '就差 1 點！開出 11 點算大，10 點以內才是小');
          } else if (bet.value === 'big' && analysis.sum === 10) {
            add(bet, 'bs-edge', NEAR_MISS_RARITY.BS_EDGE, '就差 1 點！開出 10 點算小，11 點起才是大');
          }
          break;
        }

        case BET_TYPES.SUM: {
          if (Math.abs(analysis.sum - bet.value) !== 1) break;
          const rarity = sumOutcomeCount(bet.value - 1) + sumOutcomeCount(bet.value + 1);
          add(bet, 'sum-off-by-one', rarity,
            '差 1 點！你押 ' + bet.value + ' 點，開出 ' + analysis.sum + ' 點');
          break;
        }

        case BET_TYPES.TRIPLE_ONE: {
          if (counts[bet.value] !== 2) break;
          add(bet, 'triple-one-pair', NEAR_MISS_RARITY.TRIPLE_ONE,
            '就差一顆！' + bet.value + ' 點開了兩顆');
          break;
        }

        case BET_TYPES.TRIPLE_ANY: {
          let paired = 0;
          for (let v = 1; v <= DIE_FACES; v++) {
            if (counts[v] === 2) paired = v;
          }
          if (!paired) break;
          add(bet, 'triple-any-pair', NEAR_MISS_RARITY.TRIPLE_ANY,
            '就差一顆圍骰！' + paired + ' 點開了兩顆');
          break;
        }

        case BET_TYPES.COMBO: {
          const pair = parseCombo(bet.value);
          if (!pair) break;
          // 兩個都開出就中了，不會走到這裡；兩個都沒開出則差得太遠，不算近失。
          if ((counts[pair[0]] >= 1) === (counts[pair[1]] >= 1)) break;
          add(bet, 'combo-half', NEAR_MISS_RARITY.COMBO_HALF,
            '差一顆！' + pair[0] + ' 和 ' + pair[1] + ' 只開出了其中一個');
          break;
        }

        case BET_TYPES.DOUBLE: {
          if (counts[bet.value] !== 1) break;
          add(bet, 'double-one', NEAR_MISS_RARITY.DOUBLE_ONE,
            '差一顆！' + bet.value + ' 點只開了一顆');
          break;
        }

        case BET_TYPES.SINGLE: {
          // 新增情境 ③：單骰完全沒開出，但「對面」那一面開了。
          // 骰子對面相加為 7（§5.4 的貼圖表釘死這件事），所以這句在物理上是真的：
          // 那顆骰再翻半圈就是玩家押的點數。單骰是另一個舊版拿不到任何反饋的注型。
          if (counts[bet.value] !== 0) break;
          const opposite = 7 - bet.value;
          if (counts[opposite] < 1) break;
          add(bet, 'single-flip', NEAR_MISS_RARITY.SINGLE_FLIP,
            '就差翻一面！沒開出 ' + bet.value + '，對面的 ' + opposite
            + ' 點卻開了 ' + counts[opposite] + ' 顆');
          break;
        }

        default:
          break;   // 未知注型沒有近失規則，靜靜跳過
      }
    }

    if (candidates.length === 0) return null;

    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      // 嚴格小於才換人：同稀有度時留住玩家下注順序較前的那一筆。
      if (candidates[i].rarity < best.rarity) best = candidates[i];
    }
    return best;
  }

  // --- 翻倍挑戰 ---

  function gambleRoll(rng) {
    return rollDie(rng);
  }

  function gambleResult(pick, die) {
    if (pick !== 'small' && pick !== 'big') {
      throw new TypeError("翻倍挑戰只能押 'small' 或 'big'，收到 " + String(pick));
    }
    if (!isFace(die)) {
      throw new TypeError('翻倍挑戰的骰面必須是 1 到 6 的整數，收到 ' + String(die));
    }
    // 單顆骰沒有圍骰問題，1–3 為小、4–6 為大，剛好各半，是公平的 50/50。
    const side = die <= 3 ? 'small' : 'big';
    return { win: side === pick, die: die, pick: pick };
  }

  // --- 里程碑 ---

  // 餘額類看 peakBalance 而不是當下餘額：達成過就是達成過，之後輸回去不該被撤銷。
  function isMilestoneReached(milestone, stats) {
    switch (milestone.type) {
      case 'balance': return stats.peakBalance >= milestone.value;
      case 'bigWin': return stats.biggestWin >= milestone.value;
      case 'streak': return stats.bestStreak >= milestone.value;
      case 'triples': return stats.triples >= milestone.value;
      case 'rounds': return stats.rounds >= milestone.value;
      default: return false;
    }
  }

  function toIdSet(ids) {
    const set = new Set();
    if (!ids) return set;
    if (ids instanceof Set) {
      ids.forEach(id => { if (typeof id === 'string') set.add(id); });
      return set;
    }
    if (Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i++) {
        if (typeof ids[i] === 'string') set.add(ids[i]);
      }
    }
    return set;
  }

  // 只回傳「這次新達成」的項目，且完全不改動入參（hitIds 由呼叫端自己併進存檔）。
  function checkMilestones(stats, hitIds) {
    const safeStats = normalizeStats(stats);
    const hit = toIdSet(hitIds);
    return MILESTONES.filter(milestone => !hit.has(milestone.id) && isMilestoneReached(milestone, safeStats));
  }

  // --- 存檔 schema 與驗證 ---

  // 型別不符（字串化的數字也算）一律回退預設值；數值超界則夾到邊界。
  function clampInt(value, min, max, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const int = Math.trunc(value);
    if (int < min) return min;
    if (int > max) return max;
    return int;
  }

  function emptyStats() {
    const stats = {};
    Object.keys(STATS_FIELDS).forEach(key => { stats[key] = STATS_FIELDS[key]; });
    return stats;
  }

  function normalizeStats(raw) {
    const stats = emptyStats();
    if (!isPlainObject(raw)) return stats;
    Object.keys(STATS_FIELDS).forEach(key => {
      stats[key] = clampInt(raw[key], 0, MAX_AMOUNT, STATS_FIELDS[key]);
    });
    return stats;
  }

  // lastBets 同一格只留第一筆：重複 id 會讓 rebet 把同一格押兩次，
  // 餘額扣兩份而畫面只看到一顆籌碼徽章。
  function normalizeBetList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length && out.length < BETS.length; i++) {
      const entry = raw[i];
      if (!isPlainObject(entry)) continue;
      const bet = getBet(entry.id);
      if (!bet || seen.has(bet.id)) continue;
      if (!Number.isInteger(entry.amount) || entry.amount <= 0 || entry.amount > MAX_AMOUNT) continue;
      seen.add(bet.id);
      out.push({ id: bet.id, amount: entry.amount });
    }
    return out;
  }

  function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length && out.length < HISTORY_LIMIT; i++) {
      const item = raw[i];
      if (!isPlainObject(item)) continue;
      const dice = item.dice;
      // 骰面是一筆紀錄的身分，壞了整筆丟掉；sum 可以從骰面推回來，所以一律重算，
      // 存檔被手動改過也不會出現「[1,1,1] 卻寫 sum: 17」這種自相矛盾的列。
      if (!Array.isArray(dice) || dice.length !== DICE_COUNT || !dice.every(isFace)) continue;
      out.push({
        dice: [dice[0], dice[1], dice[2]],
        sum: dice[0] + dice[1] + dice[2],
        net: clampInt(item.net, -MAX_AMOUNT, MAX_AMOUNT, 0),
        streak: clampInt(item.streak, 0, MAX_STREAK, 0)
      });
    }
    return out;   // 最新在前，所以超量時砍的是尾端（最舊的那些）
  }

  function normalizeMilestoneIds(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i++) {
      const id = raw[i];
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!MILESTONES.some(milestone => milestone.id === id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function emptySave() {
    return {
      v: SAVE_VERSION,
      balance: START_BALANCE,
      streak: 0,
      lastBets: [],
      history: [],
      stats: emptyStats(),
      milestones: []
    };
  }

  function normalizeSaveShape(raw) {
    const save = emptySave();
    if (!isPlainObject(raw)) return save;   // null / undefined / 字串 / 陣列 / 數字 全走這條

    save.balance = clampInt(raw.balance, 0, MAX_AMOUNT, START_BALANCE);
    save.streak = clampInt(raw.streak, 0, MAX_STREAK, 0);
    save.lastBets = normalizeBetList(raw.lastBets);
    save.history = normalizeHistory(raw.history);
    save.stats = normalizeStats(raw.stats);
    save.milestones = normalizeMilestoneIds(raw.milestones);
    // v 不管原本寫什麼，一律標成當前版本：每個欄位都已經獨立驗證過，
    // 版本號對不上也沒有理由讓玩家整份餘額與戰績歸零。
    save.v = SAVE_VERSION;
    return save;
  }

  // 對外保證「絕不 throw」。除了逐欄回退，外面再包一層 try：
  // 傳進來的可能是帶 getter 的怪物件（存取屬性本身就會拋錯），那種也必須安全回到全新存檔。
  function normalizeSave(raw) {
    try {
      return normalizeSaveShape(raw);
    } catch (_) {
      return emptySave();
    }
  }

  function emptyPrefs() {
    return { sound: true, keepBets: true, chip: CHIPS[0] };
  }

  function normalizePrefs(raw) {
    const prefs = emptyPrefs();
    try {
      if (!isPlainObject(raw)) return prefs;
      if (typeof raw.sound === 'boolean') prefs.sound = raw.sound;
      if (typeof raw.keepBets === 'boolean') prefs.keepBets = raw.keepBets;
      // chip 必須是 CHIPS 之一：籌碼面額是畫面上實際存在的按鈕，
      // 放行一個 37 這種值會讓籌碼列沒有任何一顆是選中狀態。
      if (CHIPS.indexOf(raw.chip) !== -1) prefs.chip = raw.chip;
      return prefs;
    } catch (_) {
      return emptyPrefs();
    }
  }

  // --- 其他工具 ---

  function formatNumber(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '0';   // NaN / Infinity 一律當 0，畫面上永遠不該出現 'NaN'
    const rounded = Math.round(value);
    const sign = rounded < 0 ? '-' : '';
    // 不用 toLocaleString：不同執行環境的 locale 會給出不同分隔符號（甚至全形），
    // 那會讓測試與畫面對不起來。這裡固定千分位逗號。
    return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 莊家優勢 = 1 − RTP，用 216 種等機率骰面即時枚舉，不查表。
  // 賠率表改動時這裡會立刻反映，測試才擋得住「手改賠率卻忘了驗算」。
  function houseEdge(betId) {
    const bet = getBet(betId);
    if (!bet) throw new TypeError('未知的注項 id：' + String(betId));

    // 押 1 元，累加「中獎時回到手上的錢」（本金 + 純贏分）。
    // 全程整數相加、最後才除 216，避免 216 次浮點累加的誤差。
    let returnedTotal = 0;
    for (let d1 = 1; d1 <= DIE_FACES; d1++) {
      for (let d2 = 1; d2 <= DIE_FACES; d2++) {
        for (let d3 = 1; d3 <= DIE_FACES; d3++) {
          const outcome = settleLine(bet, 1, analyze([d1, d2, d3]));
          if (outcome.won) returnedTotal += 1 + outcome.payout;
        }
      }
    }
    return (TOTAL_OUTCOMES - returnedTotal) / TOTAL_OUTCOMES;
  }

  return {
    SAVE_KEY,
    PREF_KEY,
    SAVE_VERSION,
    START_BALANCE,
    CHIPS,
    HISTORY_LIMIT,
    STREAK_STEP,
    STREAK_MAX,
    STREAK_MIN_LEVEL,
    GAMBLE_MAX_ROUNDS,
    MILESTONES,
    BET_TYPES,
    BETS,
    BETS_BY_ID,
    getBet,
    roll,
    analyze,
    settle,
    suspense,
    nearMiss,
    gambleRoll,
    gambleResult,
    checkMilestones,
    emptySave,
    normalizeSave,
    emptyPrefs,
    normalizePrefs,
    formatNumber,
    houseEdge
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SicBoCore;
}
