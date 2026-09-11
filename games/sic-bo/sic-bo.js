// ============================================================================
// 骰寶（sic-bo）遊戲層：DOM、演出、音效、持久化。
// ----------------------------------------------------------------------------
// 這一層只做「把核心算出來的結果演出來」，所有賠付數學都在 sic-bo-core.js。
// 三條貫穿全檔的原則，每一條都對應舊版的一個真實故障：
//
// 1. 狀態只有一份，而且都掛在實例上（this.phase / this.bets / this.balance …）。
//    舊版在頂層寫了 let history = []，那會遮蔽 window.history，讓本檔之後載入的
//    任何 classic script 寫 history.back() 都拿到陣列並 TypeError。本檔不宣告任何
//    頂層可變狀態，連區域變數都避開 history 這個名字。
//
// 2. this.bets 是 Map<betId, amount>，絕不持有 DOM 參考。舊版的下注物件帶著
//    element，於是快照不可序列化（JSON.stringify 一個 HTMLElement 得到 {}），
//    一加上存檔功能就炸。DOM 一律由 betId 反查 this.cellById。
//
// 3. 結算段包 try / finally，phase 一定會離開 rolling。舊版的 isRolling 沒有
//    finally，結算途中一拋錯就永久 true、PLAY 永久 disabled，只能重新整理。
//
// 另外：結果在按下 PLAY 的當下就算完，演出只是把已知結果演出來。所以「跳過」
// 能立刻給出同一個結果，而演出長度不影響公平性。
// ============================================================================

'use strict';

// ----------------------------------------------------------------------------
// 1. 時序常數（契約 §6.1）
//    這裡是 CSS 時序的唯一真相：init() 會把它們寫進 documentElement.style，
//    sic-bo.css 裡的 --shake-ms / --land-ms / --count-ms / --pulse-ms 只是
//    JS 還沒接手時的 fallback。兩邊各寫一份數字，遲早會出現「骰子還在轉、
//    結算已經跑完」這種對不上的畫面。
// ----------------------------------------------------------------------------
const SHAKE_MS = 520;         // 搖盅（三顆骰一起翻滾）
const DIE_GAP_MS = 320;       // 每顆骰落定之間的間隔
const LAND_MS = 420;          // 落桌彈跳
const SUSPENSE_MS = 500;      // 懸念停頓，只在 SicBoCore.suspense 為 true 時插入
const SETTLE_DELAY_MS = 150;  // 第三顆落定（含彈跳）到結算之間的呼吸
const COUNT_MS = 400;         // 餘額補間
const PULSE_MS = 620;         // 中獎注格高亮 / 餘額漲跌著色
const FLOAT_MS = 1000;        // 浮動贏分節點的存活上限（animationend 缺席時的兜底）
const TOAST_MS = 2400;        // Toast 停留
const TOAST_FADE_MS = 300;    // Toast 淡出
const MODAL_FADE_MS = 250;    // 彈窗離場淡出，必須與 CSS 的 --dur-modal 對齊
const REDUCED_TOTAL_MS = 180; // 減少動態偏好下，整段演出壓縮成這麼長

// 缺陷 H：Toast 既沒去重也沒上限。實測一局同時解鎖 5 個里程碑會噴 5 條蓋住剛中獎
// 的格子；餘額不足時連點 8 個注格會疊 8 條一模一樣的訊息，在 390px 寬的手機上
// 整個 sticky 舞台（骰子、結果、餘額）都被蓋掉。同時最多這麼多條，超出先移除最舊的。
const TOAST_MAX = 3;

// 缺陷 J：近失文案洗版。實測固定注單「大10 + 組合1-2 10 + 單骰6 10」跑 30 局，
// 9 次輸局有 9 次都是逐字相同的那句安慰 —— 安慰變成背景雜訊。
// 同一「種類」的近失文案在這麼多局內不重複顯示。
const NEAR_MISS_COOLDOWN_ROUNDS = 4;

// 缺陷 K：懸念停頓變成常態延遲。核心改用「第三顆是否仍未定勝負」判斷後觸發率更高，
// 遊戲層再加節流：連續這麼多局都觸發後強制跳過一局，讓停頓回到「偶爾出現才叫懸念」。
const SUSPENSE_MAX_RUN = 2;

// 缺陷 C：多筆贏分的排版參數（見 spawnFloatGain 的註解）。
const FLOAT_COL_STEP = 64;    // 相鄰兩筆贏分的水平間距（px，寬度夠時的理想值）
const FLOAT_MIN_COL = 48;     // 擠不下時允許縮到這麼窄（一張「+1,200」約 60px，標籤本身不會疊）
const FLOAT_ROW_STEP = 20;    // 換行時的垂直錯開（px），往上疊而不是往下疊
const FLOAT_EDGE_PAD = 34;    // 左右各留這麼多 px，讓 translate(-50%) 之後的文字不會出界
const FLOAT_RISE_PX = 44;     // CSS 的 floatGain 最多往上飄 40px，這裡多留一點餘裕

// 一局總長：無懸念 520 + 320 + 320 + 420 + 150 = 1.73s；有懸念再多 0.5s。

// 把某個點數轉到正面所需的角度（契約 §5.4 釘死的表，CSS 的貼面順序靠它）。
// 對面相加為 7，所以 1/6 與 3/4 只差 180°、2/5 只差 ±90°。
const DIE_ANGLES = Object.freeze({
  1: { rx: 0, ry: 0 },
  2: { rx: -90, ry: 0 },
  3: { rx: 0, ry: -90 },
  4: { rx: 0, ry: 90 },
  5: { rx: 90, ry: 0 },
  6: { rx: 0, ry: 180 }
});

// 首屏骰面刻意不是 1,1,1。舊版初始三顆都是 ⚀，也就是一個「圍骰」盤面 ——
// 還沒開始玩就先給玩家一個會通殺大小的結果，語意完全誤導。
const INITIAL_DICE = Object.freeze([2, 4, 6]);

// 大贏的門檻：淨賺達到本局押注的這個倍數就放彩帶 + 大獎音。
const BIG_WIN_RATIO = 5;

// 核心與共用模組都用 typeof 取，因為它們是頂層 const，不掛在 window 上。
// 核心缺席時遊戲沒有任何賠付邏輯可用，init() 會直接停住並提示；
// 主題 / 音效 / 彩帶缺席時遊戲照常可玩，只是少了那一項。
const _sicboCore = (typeof SicBoCore !== 'undefined' && SicBoCore) ? SicBoCore : null;

// ----------------------------------------------------------------------------
// 2. 小工具：全部對「缺少某個瀏覽器 API」做守衛。
//    tests/games.test.js 用 new Function(source) 編譯本檔，那個環境什麼都沒有。
// ----------------------------------------------------------------------------

function _sicboById(id) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
  return document.getElementById(id);
}

function _sicboQuery(selector, scope) {
  const root = scope || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.querySelector !== 'function') return null;
  return root.querySelector(selector);
}

function _sicboSetAttr(el, name, value) {
  if (!el || typeof el.setAttribute !== 'function') return;
  el.setAttribute(name, value);
}

function _sicboSetText(el, text) {
  if (!el) return;
  el.textContent = text;
}

function _sicboToggleClass(el, name, on) {
  if (!el || !el.classList) return;
  el.classList.toggle(name, !!on);
}

// 所有 localStorage 存取都在 try 內（契約 §1.6）：無痕模式、封鎖第三方儲存、
// 配額爆掉都會讓 getItem / setItem 直接拋錯，而存檔失敗絕不該讓遊戲玩不下去。
function _sicboReadJson(key) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;   // 讀不到 / 壞 JSON / 被封鎖，一律當成沒存過
  }
}

function _sicboWriteJson(key, value) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false;
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

function _sicboNextFrame(fn) {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => fn());
    return;
  }
  if (typeof setTimeout === 'function') {
    setTimeout(fn, 16);
    return;
  }
  fn();
}

function _sicboNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function _sicboVibrate(pattern) {
  try {
    if (typeof navigator === 'undefined' || !navigator) return;
    if (typeof navigator.vibrate !== 'function') return;
    // Chrome 對「使用者還沒真的碰過這個 frame」的 vibrate 會擋下來，並在 console
    // 記一筆 intervention 等級 error。它不會 throw（所以 catch 接不到），但
    // .claude/skills/run-mini-games 的冒煙測試把本站的 console error 當成失敗，
    // 而冒煙測試是 pre-push hook —— 等於偶爾會無故擋住推送。
    // 先問 userActivation 再呼叫；拿不到這個 API 的瀏覽器維持原本行為。
    const activation = navigator.userActivation;
    if (activation && typeof activation.hasBeenActive === 'boolean' && !activation.hasBeenActive) return;
    navigator.vibrate(pattern);
  } catch (_) {
    // 有些瀏覽器在非使用者手勢裡呼叫 vibrate 會拋錯，震動失敗無所謂
  }
}

// 演出或結算拋錯時留一條線索。phase 會在 finally 復位，所以遊戲不會鎖死，
// 但問題本身必須看得見，不然就變成另一個「靜靜壞掉」的舊版 bug。
function _sicboWarn(err) {
  try {
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('[骰寶] 演出或結算發生例外，已復位：', err);
    }
  } catch (_) {}
}

// 連勝加成的百分比。用「十分之幾」的整數算再乘 10，避免 (level - 1) * 0.1
// 得到 0.30000000000000004 而在畫面上印成「+30.000000000000004%」。
// 核心 settle() 內部也是同一招，兩邊必須用同一個公式，否則預告的加成與實付不符。
function _sicboStreakPercent(level) {
  if (!_sicboCore) return 0;
  const min = _sicboCore.STREAK_MIN_LEVEL;
  if (!(level >= min)) return 0;
  const step = Math.round(_sicboCore.STREAK_STEP * 10);
  const max = Math.round(_sicboCore.STREAK_MAX * 10);
  return Math.min(max, (level - min + 1) * step) * 10;
}

// ----------------------------------------------------------------------------
// 3. 音效（契約 §6.7）
//    只保留骰寶自己的「音色」；AudioContext 建立／解鎖、背景暫停、節點回收、
//    開關持久化這些瀏覽器樣板全部交給共用模組 ../../assets/js/bobo-audio.js。
//    模組缺席時 this.kit 是 null，所有 play* 安靜退場，遊戲照常能玩。
//    形狀照抄 games/2048/2048.js 的 _appSoundManager。
// ----------------------------------------------------------------------------
class SicBoAudio {
  constructor() {
    // 開關存在 sicbo_pref_v1 的 sound 欄位；模組會「讀回整包再只改這個欄位」，
    // 不會清掉同一個 key 裡的 keepBets / chip。
    this.kit = (typeof BoboAudio !== 'undefined' && BoboAudio)
      ? BoboAudio.create({
        storageKey: _sicboCore ? _sicboCore.PREF_KEY : 'sicbo_pref_v1',
        storageField: 'sound'
      })
      : null;
    // 模組缺席時仍要有一個可讀寫的開關，讓 UI 圖示與偏好存檔照常運作
    this.fallbackEnabled = true;
  }

  // 有 kit 就一律以 kit 的即時值為準：kit.enabled 的 setter 會寫 localStorage，
  // 自己再快取一份布林一定會有兩邊不同步的那一天。
  get enabled() {
    return this.kit ? this.kit.enabled : this.fallbackEnabled;
  }

  set enabled(on) {
    if (this.kit) this.kit.enabled = !!on;
    else this.fallbackEnabled = !!on;
  }

  // 使用者手勢時呼叫：iOS 唯一能建立／解鎖 AudioContext 的時機
  unlock() {
    if (this.kit) this.kit.unlock();
  }

  toggle() {
    if (this.kit) return this.kit.toggle();
    this.fallbackEnabled = !this.fallbackEnabled;
    return this.fallbackEnabled;
  }

  // 下注：極短的籌碼脆響，連點十次也不吵
  playChip() {
    if (this.kit) this.kit.tone({ freq: 880, type: 'triangle', duration: 0.04, gain: 0.08 });
  }

  // 清除下注：往下滑的收回感
  playClear() {
    if (this.kit) this.kit.sweep({ from: 620, to: 300, type: 'triangle', duration: 0.12, gain: 0.07 });
  }

  // 搖盅：帶通濾波的白噪由高掃到低，像骰子在盅裡撞。
  // 濾波參數全部在 filter 物件裡 —— 寫成頂層 filterType / Q 會被靜靜忽略。
  playShake() {
    if (!this.kit) return;
    this.kit.noise({
      duration: 0.5,
      gain: 0.085,
      release: 0.3,
      filter: { type: 'bandpass', frequency: 1400, to: 700, Q: 1.2 }
    });
  }

  // 落桌：方波撞擊 + 一小撮低通噪音當木頭質感。三顆各差 22Hz，聽得出是第幾顆。
  playDie(index) {
    if (!this.kit) return;
    const i = Number.isFinite(index) ? index : 0;
    this.kit.tone({ freq: 150 + i * 22, type: 'square', duration: 0.05, gain: 0.10 });
    this.kit.noise({ duration: 0.06, gain: 0.06, filter: { type: 'lowpass', frequency: 900 } });
  }

  // 小贏：C 大三和弦琶音
  playWinSmall() {
    if (!this.kit) return;
    this.kit.chord([523.25, 659.25, 783.99], { type: 'sine', duration: 0.2, gain: 0.13, stagger: 0.07 });
  }

  // 大贏：多兩個高音，撐得起彩帶
  playWinBig() {
    if (!this.kit) return;
    this.kit.chord([523.25, 659.25, 783.99, 1046.5, 1318.51], {
      type: 'sine', duration: 0.26, gain: 0.15, stagger: 0.08
    });
  }

  playLose() {
    if (this.kit) this.kit.sweep({ from: 260, to: 170, type: 'triangle', duration: 0.18, gain: 0.1 });
  }

  // 打平：中性的單音，刻意不用小調（打平不是壞事）
  playPush() {
    if (this.kit) this.kit.tone({ freq: 392, type: 'sine', duration: 0.12, gain: 0.08 });
  }

  // 連勝：級數越高音越高，用耳朵就聽得出加成在漲。Math.min 封在 6 是因為
  // 連勝加成本身也在 6 封頂，再往上升音會讓人以為還有加成。
  playStreak(level) {
    if (!this.kit) return;
    const step = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
    this.kit.tone({
      freq: 523.25 * Math.pow(2, Math.min(step, 6) / 12),
      type: 'sine', duration: 0.1, gain: 0.1
    });
  }

  playMilestone() {
    if (!this.kit) return;
    this.kit.chord([659.25, 987.77], { type: 'sine', duration: 0.22, gain: 0.13, stagger: 0.09 });
  }

  playGambleWin() {
    if (this.kit) this.kit.sweep({ from: 523.25, to: 1046.5, type: 'sine', duration: 0.22, gain: 0.14 });
  }

  playGambleLose() {
    if (this.kit) this.kit.sweep({ from: 440, to: 160, type: 'sawtooth', duration: 0.3, gain: 0.11 });
  }

  playBroke() {
    if (!this.kit) return;
    this.kit.chord([392, 329.63, 261.63], { type: 'triangle', duration: 0.26, gain: 0.13, stagger: 0.15 });
  }
}

// ----------------------------------------------------------------------------
// 4. 遊戲本體
// ----------------------------------------------------------------------------
class SicBoGame {
  constructor() {
    // --- 狀態（全部在實例上，沒有任何頂層可變變數）---
    this.phase = 'betting';          // betting | rolling | settling | gamble | broke
    this.balance = _sicboCore ? _sicboCore.START_BALANCE : 1000;
    this.streak = 0;
    this.bets = new Map();           // betId -> amount，絕不放 DOM
    this.lastBets = [];              // [{ id, amount }]，純資料，可直接序列化
    this.rounds = [];                // 歷史紀錄（最新在前），與存檔的 history 欄位同形
    this.stats = _sicboCore ? _sicboCore.emptySave().stats : {};
    this.milestoneIds = [];          // 已達成的里程碑 id
    this.chip = _sicboCore ? _sicboCore.CHIPS[0] : 10;
    this.keepBets = true;            // 結算後自動重下上局注單

    // --- 演出用 ---
    this.timers = [];                // 演出計時器：跳過與 destroy 時全部 clear
    this.cleanupTimers = [];         // 只負責移除 class / 節點的收尾計時器
    this.pending = null;             // 已算好、還沒演完的本局結果
    this.dieSpins = [0, 0, 0];       // 每顆骰累積轉了幾圈（單調遞增，見 setCubeFace）
    this.gambleSpin = 0;
    this.roundToken = 0;             // 局序號，讓遲到的收尾計時器認得出自己過期了
    this.balanceRaf = null;
    this.balanceFrom = 0;
    this.confettiStop = null;
    this.suspenseRun = 0;            // 連續幾局插了懸念停頓（缺陷 K 的節流計數）
    this.missShownAt = new Map();    // 近失種類 -> 上次顯示的局序號（缺陷 J 的節流）

    // --- 翻倍挑戰 ---
    this.gambleAmount = 0;
    this.gambleRounds = 0;
    this.gambleStaked = false;       // 賭本是否已經從餘額扣下來
    this.gambleBusy = false;         // 單顆骰正在翻滾
    this.gambleBase = 0;             // 這次挑戰的起始彩池（= 本局淨賺），用來寫訊息
    this.gambleEntry = null;         // 本局的歷史紀錄物件（翻倍結束後要改寫它的淨額）
    this.gambleItem = null;          // 上面那筆紀錄對應的 DOM 列

    // --- 彈窗 ---
    this.modals = [];

    // --- Toast（缺陷 H：去重 + 上限，狀態必須留著才有辦法比對與淘汰）---
    this.toasts = [];

    // --- sticky 舞台高度（缺陷 D）---
    this.stageObserver = null;
    this.onStageResize = null;

    this.el = {};
    this.cellById = new Map();       // betId -> .bet-cell，DOM 的唯一反查表
    this.onKeyDown = (event) => this.handleKeyDown(event);

    // 音效在建構時就建立：BoboAudio 內部對 document / window 都有 typeof 守衛，
    // 而且一個遊戲只能 create 一次（autoUnlock 會綁一組 document listener）。
    this.audio = new SicBoAudio();
  }

  // ==========================================================================
  // 4.1 初始化
  // ==========================================================================
  init() {
    if (typeof document === 'undefined') return;
    this.cacheElements();

    // 核心是硬依賴：沒有它連賠率表都不存在，這時候唯一誠實的做法是講出來。
    if (!_sicboCore) {
      _sicboSetText(this.el.resultMsg, '核心模組載入失敗，請重新整理頁面。');
      this.showToast('核心模組載入失敗，請重新整理');
      return;
    }

    this.syncMotionTokens();
    this.indexCells();
    this.loadPrefs();
    this.loadGame();

    this.setupTheme();
    this.setupSoundButton();
    this.bindEvents();
    this.observeStageHeight();

    // 首屏一律從狀態重畫一次。舊版把初始數字同時寫在 HTML 與 JS 兩處，
    // 改了 JS 常數卻沒改 HTML，畫面就會顯示過期數字直到第一次互動。
    this.showDice(INITIAL_DICE, { spin: false, land: false, sound: false });
    this.updateDiceLabel(INITIAL_DICE, false);
    this.renderBalance();
    this.updateTotalBet();
    this.renderChips();
    this.renderStreak();
    this.renderHistoryList();
    this.setPhase(this.isBroke() ? 'broke' : 'betting');
    if (this.phase === 'broke') this.openBrokeModal();
  }

  cacheElements() {
    this.el = {
      confettiCanvas: _sicboById('confetti-canvas'),
      toastContainer: _sicboById('toast-container'),
      themeBtn: _sicboById('theme-btn'),
      soundBtn: _sicboById('sound-btn'),
      statsBtn: _sicboById('stats-btn'),
      helpBtn: _sicboById('help-btn'),
      stage: _sicboQuery('.stage'),
      diceTray: _sicboById('dice-tray'),
      resultMsg: _sicboById('result-msg'),
      resultSub: _sicboById('result-sub'),
      streakMeter: _sicboById('streak-meter'),
      streakFill: _sicboById('streak-fill'),
      streakLabel: _sicboById('streak-label'),
      balance: _sicboById('balance'),
      totalBet: _sicboById('total-bet'),
      betTable: _sicboById('bet-table'),
      chipRail: _sicboById('chip-rail'),
      rollBtn: _sicboById('roll-btn'),
      rebetBtn: _sicboById('rebet-btn'),
      clearBtn: _sicboById('clear-btn'),
      gamblePanel: _sicboById('gamble-panel'),
      gambleDie: _sicboById('gamble-die'),
      gambleAmount: _sicboById('gamble-amount'),
      gambleSmall: _sicboById('gamble-small'),
      gambleBig: _sicboById('gamble-big'),
      gambleTake: _sicboById('gamble-take'),
      historyList: _sicboById('history-list'),
      historyEmpty: _sicboById('history-empty'),
      statsModal: _sicboById('stats-modal'),
      helpModal: _sicboById('help-modal'),
      brokeModal: _sicboById('broke-modal'),
      statsBody: _sicboById('stats-body'),
      brokeBody: _sicboById('broke-body'),
      restartBtn: _sicboById('restart-btn')
    };

    // 三顆骰的外層與內層分開快取：外層 .die 只做位移與縮放（落桌彈跳），
    // 內層 .die__cube 只做旋轉。transform 所有權切兩層是 2048 學到的鐵律 ——
    // 同一個元素上的兩個 transform 動畫一定會互相覆蓋。
    const tray = this.el.diceTray;
    const dice = (tray && typeof tray.querySelectorAll === 'function')
      ? Array.prototype.slice.call(tray.querySelectorAll('.die'))
      : [];
    this.el.dice = dice;
    this.el.cubes = dice.map(die => _sicboQuery('.die__cube', die));
    this.el.gambleCube = _sicboQuery('.die__cube', this.el.gambleDie);

    this.modals = [this.el.statsModal, this.el.helpModal, this.el.brokeModal].filter(Boolean);
  }

  // 注格只在這裡掃一次：之後一律用 betId 反查，不在資料裡放 DOM 參考。
  indexCells() {
    this.cellById.clear();
    const table = this.el.betTable;
    if (!table || typeof table.querySelectorAll !== 'function') return;
    const cells = table.querySelectorAll('[data-bet]');
    if (!cells || !cells.forEach) return;
    cells.forEach((cell) => {
      const id = cell.getAttribute ? cell.getAttribute('data-bet') : null;
      if (!id) return;
      // 目錄裡沒有的 id 直接忽略：HTML 手改錯字時不該讓後面的流程拿到 undefined 注項
      if (!_sicboCore.getBet(id)) return;
      this.cellById.set(id, cell);
    });
  }

  // 把 JS 的時序常數推進 CSS 變數，確保兩邊永遠同一組數字。
  syncMotionTokens() {
    const root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--shake-ms', SHAKE_MS + 'ms');
    root.style.setProperty('--die-gap-ms', DIE_GAP_MS + 'ms');
    root.style.setProperty('--land-ms', LAND_MS + 'ms');
    root.style.setProperty('--suspense-ms', SUSPENSE_MS + 'ms');
    root.style.setProperty('--settle-delay-ms', SETTLE_DELAY_MS + 'ms');
    root.style.setProperty('--count-ms', COUNT_MS + 'ms');
    root.style.setProperty('--pulse-ms', PULSE_MS + 'ms');
    root.style.setProperty('--float-ms', FLOAT_MS + 'ms');
  }

  // 缺陷 D：手機版面的 .stage 是 sticky top，CSS 原本寫死 scroll-padding-top: 200px，
  // 但舞台實高會隨連勝條、訊息行數與斷點在 208–258px 之間變動。實測（390×844，
  // 連勝條出現時舞台 258px）從頁尾往回 Shift+Tab，combo-2-3 ~ combo-3-4 那幾格的
  // rect 是 top=199 / bottom=253，整格連同 focus ring 都藏在舞台底下。
  // 這裡把量到的實際高度寫進 documentElement 的 --stage-h，CSS 端用
  // scroll-padding-top: calc(var(--stage-h, 240px) + 8px) 消費它（介面已釘死）。
  // ResizeObserver 會在 observe() 當下就送第一次回呼，所以不必自己先量一次。
  // 同一支觀察器也量 .control-dock 的高度寫成 --dock-h。
  // 手機版面的 dock 是 fixed 貼底，.page-container 必須留出等高的底部內距，
  // 否則歷史紀錄最後一列會被蓋住。那個內距原本是寫死的 --dock-reserve，
  // 但 dock 高度會隨階段變（翻倍面板掀開、籌碼列在 settling 回來），
  // 任何固定值都只能對某一種組合 —— 820×1180 就是這樣漏掉一列的。
  // 量出來寫成變數，CSS 端 --dock-reserve 直接吃它，就不必再維護第二份真相。
  observeStageHeight() {
    const stage = this.el.stage;
    const dock = this.el.dock || _sicboQuery('.control-dock');
    if (!stage && !dock) return;
    const measure = (el) => Math.round(el && el.getBoundingClientRect
      ? el.getBoundingClientRect().height
      : ((el && el.offsetHeight) || 0));
    const write = () => {
      const root = document.documentElement;
      if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
      if (stage) {
        const h = measure(stage);
        if (h > 0) root.style.setProperty('--stage-h', h + 'px');
      }
      if (dock) {
        const h = measure(dock);
        if (h > 0) root.style.setProperty('--dock-h', h + 'px');
      }
    };
    if (typeof ResizeObserver === 'function') {
      try {
        this.stageObserver = new ResizeObserver(write);
        if (stage) this.stageObserver.observe(stage);
        if (dock) this.stageObserver.observe(dock);
        return;
      } catch (_) {
        this.stageObserver = null;   // 建構失敗就走下面的退路
      }
    }
    // ResizeObserver 缺席（或建構失敗）：init 與每次 resize 各量一次。
    // 抓不到連勝條出現造成的高度變化，但至少斷點切換時是對的。
    write();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onStageResize = write;
      window.addEventListener('resize', this.onStageResize);
    }
  }

  reducedMotion() {
    try {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  }

  // ==========================================================================
  // 4.2 事件（全部委派，沒有任何 inline onclick）
  // ==========================================================================
  bindEvents() {
    const betTable = this.el.betTable;
    if (betTable) {
      betTable.addEventListener('click', (event) => {
        const cell = this.closestFrom(event.target, '.bet-cell');
        if (!cell) return;
        const id = cell.getAttribute ? cell.getAttribute('data-bet') : null;
        if (!id) return;
        this.audio.unlock();
        this.placeBet(id, this.chip);
      });
    }

    const chipRail = this.el.chipRail;
    if (chipRail) {
      chipRail.addEventListener('click', (event) => {
        const chip = this.closestFrom(event.target, '.chip');
        if (!chip) return;
        const value = Number(chip.getAttribute ? chip.getAttribute('data-chip') : NaN);
        this.audio.unlock();
        this.selectChip(value);
      });
    }

    if (this.el.rollBtn) this.el.rollBtn.addEventListener('click', () => this.onPrimaryAction());
    if (this.el.rebetBtn) this.el.rebetBtn.addEventListener('click', () => this.rebet());
    if (this.el.clearBtn) this.el.clearBtn.addEventListener('click', () => this.clearBets());

    if (this.el.gambleSmall) this.el.gambleSmall.addEventListener('click', () => this.startGamble('small'));
    if (this.el.gambleBig) this.el.gambleBig.addEventListener('click', () => this.startGamble('big'));
    if (this.el.gambleTake) this.el.gambleTake.addEventListener('click', () => this.takeGamble());

    if (this.el.statsBtn) {
      this.el.statsBtn.addEventListener('click', () => {
        this.renderStatsBody();
        this.openModal(this.el.statsModal);
      });
    }
    if (this.el.helpBtn) this.el.helpBtn.addEventListener('click', () => this.openModal(this.el.helpModal));
    if (this.el.restartBtn) this.el.restartBtn.addEventListener('click', () => this.restart());

    // 彈窗三條關閉路徑：點遮罩本身、任何 data-close 按鈕、Escape（在鍵盤處理裡）
    this.modals.forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          this.closeModal(modal);
          return;
        }
        const closer = this.closestFrom(event.target, '[data-close]');
        if (closer && typeof modal.contains === 'function' && modal.contains(closer)) {
          this.closeModal(modal);
        }
      });
    });

    document.addEventListener('keydown', this.onKeyDown);
  }

  closestFrom(target, selector) {
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest(selector);
  }

  // ==========================================================================
  // 4.3 狀態機（契約 §6.2）
  //     this.phase 是唯一狀態，同時寫進 body[data-phase] 給 CSS 用。
  //     所有使用者輸入一律先問 phase，不再有散落各處的 isRolling 布林。
  // ==========================================================================
  setPhase(phase) {
    this.phase = phase;
    if (document.body && document.body.dataset) document.body.dataset.phase = phase;
    else _sicboSetAttr(document.body, 'data-phase', phase);

    // 缺陷 B：settling 期間整桌鎖死。實測押「小 500」中獎後，籌碼列 display:none、
    // 同上局與清除 hidden、#bet-table pointer-events:none，桌上卻已經被 keepBets
    // 自動重押了 500 —— 玩家唯一能按的金色大鈕就是「用同一筆錢再賭一局」，
    // 餘額低的時候等於被迫 all-in。契約 §6.5 第 12 步已更新：settling 期間下注桌、
    // 籌碼列、清除、同上局都要維持可用，玩家要能在按下一局之前改注。
    // 真正該鎖住下注桌的只有 rolling（結果已定、再收注就是作弊）與 gamble
    //（贏分已經押進翻倍挑戰）以及 broke（沒錢可押）。
    const canBet = phase === 'betting' || phase === 'settling';
    // 不能下注的階段整個下注桌弱化。舊版只 disable 了 PLAY，點注格時 :active 動畫照跑、
    // 看起來有反應實際什麼都沒發生，玩家會以為自己押到了。
    _sicboToggleClass(this.el.betTable, 'is-disabled', !canBet);
    _sicboSetAttr(this.el.betTable, 'aria-disabled', canBet ? 'false' : 'true');
    if (this.el.rebetBtn) this.el.rebetBtn.disabled = !canBet;
    if (this.el.clearBtn) this.el.clearBtn.disabled = !canBet;
    if (this.el.chipRail) _sicboToggleClass(this.el.chipRail, 'is-disabled', !canBet);

    const offering = phase === 'settling' || phase === 'gamble';
    if (this.el.gamblePanel) this.el.gamblePanel.hidden = !offering;
    this.renderGamble();
    this.updatePrimaryButton();
  }

  updatePrimaryButton() {
    const btn = this.el.rollBtn;
    if (!btn) return;
    let label = 'PLAY';
    let title = '開骰（Space）';
    if (this.phase === 'rolling') {
      label = '跳過';
      title = '跳過演出，立刻看結果（Space）';
    } else if (this.phase === 'settling' || this.phase === 'gamble') {
      // 標籤必須說實話：桌上還有注（keepBets 已重下）才是真的「再來一局」，
      // 否則按下去只會收下贏分並回到空桌，寫「再來一局」會讓人以為骰子要轉了。
      const willRoll = this.bets.size > 0;
      label = willRoll ? '再來一局' : '收下贏分';
      title = willRoll ? '收下贏分並直接開下一局（Space）' : '收下贏分，回到下注（Space）';
    } else if (this.phase === 'broke') {
      label = '重新開始';
      title = '餘額見底，重新開始（Space）';
    }
    _sicboSetText(btn, label);
    _sicboSetAttr(btn, 'title', title);
  }

  // PLAY 鍵與 Space / Enter 共用這一個入口，行為完全由 phase 決定。
  onPrimaryAction() {
    if (this.topModal()) return;   // 有彈窗開著時背景是 inert，這是鍵盤路徑的保險
    switch (this.phase) {
      case 'betting':
        this.roll();
        break;
      case 'rolling':
        this.skipRoll();
        break;
      case 'settling':
      case 'gamble':
        // 按鈕寫的是「再來一局」，就必須真的再來一局 —— 收下贏分之後，
        // 只要桌上還有（keepBets 重下的）注就直接開骰。
        // 少了這一步，贏局要按兩次 PLAY、輸局只要按一次，連打的節奏會一頓一頓；
        // 而且標籤承諾了「一局」，實際只做了「收下」。
        // 翻倍挑戰不會因此被吃掉：押小／押大是 gamble 面板裡另外兩顆按鈕，
        // 按 PLAY 的語意本來就是「不賭了，直接發下一局」。
        if (!this.gambleBusy) {
          this.takeGamble();
          if (this.phase === 'betting' && this.bets.size > 0) this.roll();
        }
        break;
      case 'broke':
        // 破產彈窗被關掉後 phase 還是 broke，這裡讓它可以再叫回來，
        // 不會像舊版那樣變成「只能重新整理整頁」的死局。
        this.openBrokeModal();
        break;
      default:
        break;
    }
  }

  // ==========================================================================
  // 4.4 計時器
  //     演出計時器與收尾計時器分兩個籃子：跳過演出時只該取消還沒演到的步驟，
  //     不該連「620ms 後把高亮 class 移掉」這種收尾一起取消（那會讓 class 永久留著）。
  // ==========================================================================
  schedule(list, ms, fn) {
    if (typeof setTimeout !== 'function') {
      try { fn(); } catch (err) { _sicboWarn(err); }
      return null;
    }
    const handle = setTimeout(() => {
      const idx = list.indexOf(handle);
      if (idx !== -1) list.splice(idx, 1);
      try {
        fn();
      } catch (err) {
        _sicboWarn(err);
      }
    }, ms);
    list.push(handle);
    return handle;
  }

  after(ms, fn) {
    return this.schedule(this.timers, ms, fn);
  }

  cleanupAfter(ms, fn) {
    return this.schedule(this.cleanupTimers, ms, fn);
  }

  clearTimers() {
    if (typeof clearTimeout !== 'function') {
      this.timers.length = 0;
      return;
    }
    this.timers.forEach(handle => clearTimeout(handle));
    this.timers.length = 0;
  }

  clearCleanupTimers() {
    if (typeof clearTimeout === 'function') {
      this.cleanupTimers.forEach(handle => clearTimeout(handle));
    }
    this.cleanupTimers.length = 0;
  }

  // ==========================================================================
  // 4.5 下注（契約 §6.3）
  // ==========================================================================
  betsArray() {
    const list = [];
    this.bets.forEach((amount, id) => list.push({ id: id, amount: amount }));
    return list;
  }

  totalBet() {
    let total = 0;
    this.bets.forEach((amount) => { total += amount; });
    return total;
  }

  selectChip(value) {
    if (!_sicboCore.CHIPS.includes(value)) return;
    this.chip = value;
    this.renderChips();
    this.savePrefs();
    this.audio.playChip();
  }

  renderChips() {
    const rail = this.el.chipRail;
    if (!rail || typeof rail.querySelectorAll !== 'function') return;
    const chips = rail.querySelectorAll('.chip');
    if (!chips || !chips.forEach) return;
    chips.forEach((chip) => {
      const value = Number(chip.getAttribute ? chip.getAttribute('data-chip') : NaN);
      const on = value === this.chip;
      _sicboSetAttr(chip, 'aria-pressed', on ? 'true' : 'false');
      _sicboToggleClass(chip, 'is-active', on);
    });
  }

  // 缺陷 B 的另一半：phase 守門要放行 settling，否則下注桌雖然可以點，
  // placeBet 還是會在第一行就 return，玩家點了完全沒反應（更糟：是靜靜沒反應）。
  canPlaceBets() {
    return this.phase === 'betting' || this.phase === 'settling';
  }

  // 對外的下注入口：所有守門都在這裡，成功後才走 applyBet。
  placeBet(id, amount) {
    if (!this.canPlaceBets()) return false;
    if (!Number.isInteger(amount) || amount <= 0) return false;
    if (!_sicboCore.getBet(id)) return false;
    if (this.balance < amount) {
      // 舊版四個 alert 是原生阻斷式對話框，在 iOS Safari 上體驗尤其糟。
      this.showToast('餘額不足，換小一點的籌碼吧');
      return false;
    }
    this.applyBet(id, amount);
    this.audio.playChip();
    _sicboVibrate(15);
    return true;
  }

  // 真正改狀態的那一段。刻意與 placeBet 分開，因為「結算後自動重下上局注單」
  // 發生在 settling 階段，phase 守門會擋掉 placeBet，但那次扣款是合法的。
  applyBet(id, amount) {
    this.balance -= amount;
    this.bets.set(id, (this.bets.get(id) || 0) + amount);
    this.renderCell(id);
    this.renderBalance();
    this.updateTotalBet();
  }

  clearBets() {
    if (!this.canPlaceBets()) return;
    if (this.bets.size === 0) {
      this.showToast('桌上還沒有下注');
      return;
    }
    this.refundBets();
    this.audio.playClear();
  }

  // 全額退回並清桌。退款與清桌分不開，所以只留這一個函式。
  refundBets() {
    this.bets.forEach((amount) => { this.balance += amount; });
    this.resetTable();
    this.renderBalance();
  }

  // 只清桌面，不退錢。結算後用：那些本金早就在下注時扣掉、也已經由 settle 結算過，
  // 這時再退一次就是白送。
  resetTable() {
    const ids = Array.from(this.bets.keys());
    this.bets.clear();
    ids.forEach(id => this.renderCell(id));
    this.updateTotalBet();
  }

  rebet() {
    if (!this.canPlaceBets()) return;
    if (!this.lastBets.length) {
      this.showToast('還沒有上一局的紀錄');
      return;
    }
    let need = 0;
    this.lastBets.forEach((bet) => { need += bet.amount; });
    // 先算清「退回桌上現有的注之後」夠不夠，再決定要不要動桌面。
    // 舊版是先清光再逐筆下注，餘額不足時玩家排好的注單已經沒了。
    const available = this.balance + this.totalBet();
    if (available < need) {
      this.showToast('餘額不足以重複上一局');
      return;
    }
    const replaced = this.bets.size > 0;
    this.refundBets();
    this.lastBets.forEach((bet) => this.applyBet(bet.id, bet.amount));
    this.audio.playChip();
    // 覆蓋掉玩家手上排的注單是破壞性操作，至少要說一聲（舊版零提示）。
    this.showToast(replaced ? '已換成上一局的注單' : '已重下上一局的注單');
  }

  // 缺陷 L：每格押了多少錢對螢幕報讀者完全不存在。<button> 上的 aria-label 依規範會
  // 整份取代內容，而籌碼徽章 .bet-cell__stack 是 JS 後插的子節點 —— AX 樹實測是
  // {role:"none", ignored:true}，名稱一字未變（「押點數 10，賠率 6 倍」）。
  // 所以下注時必須同步改寫 aria-label：基底文字存進 data-base-label 當唯一真相，
  // 有注時接上「已押 N 分」，歸零時還原（不能就地累加，否則會變成「…已押 10 分已押 20 分」）。
  cellBaseLabel(cell) {
    if (!cell || typeof cell.getAttribute !== 'function') return '';
    let base = cell.getAttribute('data-base-label');
    if (base === null || base === undefined) {
      base = cell.getAttribute('aria-label') || '';
      _sicboSetAttr(cell, 'data-base-label', base);
    }
    return base;
  }

  // 依 betId 反查 DOM 並重畫那一格。籌碼徽章是動態節點，沒下注就不存在，
  // 免得 50 個空徽章在桌上留白框。
  renderCell(id) {
    const cell = this.cellById.get(id);
    if (!cell) return;
    const amount = this.bets.get(id) || 0;
    const base = this.cellBaseLabel(cell);
    let stack = _sicboQuery('.bet-cell__stack', cell);
    if (amount <= 0) {
      if (stack && typeof stack.remove === 'function') stack.remove();
      _sicboToggleClass(cell, 'is-active', false);
      _sicboSetAttr(cell, 'aria-pressed', 'false');
      if (base) _sicboSetAttr(cell, 'aria-label', base);
      return;
    }
    if (!stack) {
      stack = document.createElement('span');
      stack.className = 'bet-cell__stack';
      cell.appendChild(stack);
    }
    _sicboSetText(stack, _sicboCore.formatNumber(amount));
    _sicboToggleClass(cell, 'is-active', true);
    _sicboSetAttr(cell, 'aria-pressed', 'true');
    if (base) _sicboSetAttr(cell, 'aria-label', base + '，已押 ' + _sicboCore.formatNumber(amount) + ' 分');
  }

  updateTotalBet() {
    _sicboSetText(this.el.totalBet, _sicboCore.formatNumber(this.totalBet()));
    // 缺陷 B 的副作用：settling 期間玩家可以清桌或改注，而主動作鍵的標籤
    //（「再來一局」/「收下贏分」）取決於桌上還有沒有注。桌面一變就重算標籤，
    // 否則清了桌還寫「再來一局」，按下去只會收贏分回到空桌 —— 又是一個說謊的按鈕。
    this.updatePrimaryButton();
  }

  // ==========================================================================
  // 4.6 餘額
  // ==========================================================================
  // 不帶參數 = 畫出當前餘額；帶參數只給補間 ticker 用（畫中途的數字）。
  renderBalance(value) {
    const shown = Number.isFinite(value) ? value : this.balance;
    _sicboSetText(this.el.balance, _sicboCore.formatNumber(shown));
  }

  cancelBalanceTween() {
    if (this.balanceRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.balanceRaf);
    }
    this.balanceRaf = null;
  }

  // 補間只跑一個 rAF ticker（每次呼叫先取消上一條）。兩條 ticker 同時寫同一個
  // 節點會讓數字來回跳。終點刻意每幀重新讀 this.balance，因為結算後緊接著的
  // 「自動重下上局注單」會再扣一次錢 —— 固定終點的話補間結束後數字就是錯的。
  animateBalance(from) {
    const el = this.el.balance;
    if (!el) return;
    this.cancelBalanceTween();
    if (this.reducedMotion() || typeof requestAnimationFrame !== 'function' || from === this.balance) {
      this.renderBalance();
      return;
    }
    this.balanceFrom = from;
    const startAt = _sicboNow();
    const tick = (stamp) => {
      const now = (typeof stamp === 'number') ? stamp : _sicboNow();
      const t = Math.min(1, Math.max(0, (now - startAt) / COUNT_MS));
      const eased = 1 - Math.pow(1 - t, 3);
      this.renderBalance(Math.round(this.balanceFrom + (this.balance - this.balanceFrom) * eased));
      if (t < 1) {
        this.balanceRaf = requestAnimationFrame(tick);
      } else {
        this.balanceRaf = null;
        this.renderBalance();
      }
    };
    this.balanceRaf = requestAnimationFrame(tick);
  }

  flashBalance(delta, token) {
    const el = this.el.balance;
    if (!el || !el.classList || delta === 0) return;
    el.classList.remove('is-up', 'is-down');
    el.classList.add(delta > 0 ? 'is-up' : 'is-down');
    this.cleanupAfter(PULSE_MS, () => {
      if (token !== this.roundToken) return;   // 已經是下一局了，別動新的著色
      el.classList.remove('is-up', 'is-down');
    });
  }

  // ==========================================================================
  // 4.7 骰子
  // ==========================================================================
  setCubeFace(cube, value, spins) {
    if (!cube || !cube.style || typeof cube.style.setProperty !== 'function') return;
    const angle = DIE_ANGLES[value] || DIE_ANGLES[1];
    // 角度單調遞增（每次多轉 spins 整圈）：CSS transition 永遠是「往同一個方向
    // 轉幾圈才停」。若只寫 0–360 的絕對角度，新角度小於舊角度時骰子會倒轉回去。
    cube.style.setProperty('--rx', (angle.rx + 360 * spins) + 'deg');
    cube.style.setProperty('--ry', (angle.ry + 360 * spins) + 'deg');
  }

  showDice(dice, options) {
    for (let i = 0; i < 3; i++) this.landDie(i, dice[i], options);
  }

  landDie(index, value, options) {
    const opts = options || {};
    const die = this.el.dice[index];
    const cube = this.el.cubes[index];
    if (!cube) return;
    if (opts.spin !== false) this.dieSpins[index] += 1 + (index % 2);   // k = 1 或 2，每顆不同
    this.setCubeFace(cube, value, this.dieSpins[index]);
    if (cube.classList) cube.classList.remove('is-rolling');
    if (opts.land !== false && die && die.classList) {
      die.classList.add('is-landing');
      this.cleanupAfter(LAND_MS, () => die.classList.remove('is-landing'));
    }
    if (opts.sound !== false) this.audio.playDie(index);
  }

  startTumble() {
    this.el.cubes.forEach((cube) => {
      if (cube && cube.classList) cube.classList.add('is-rolling');
    });
  }

  stopTumble() {
    this.el.cubes.forEach((cube) => {
      if (cube && cube.classList) cube.classList.remove('is-rolling');
    });
  }

  // 三顆骰子本身是 aria-hidden 的裝飾，所以盤面必須由容器的 aria-label 講出來，
  // 否則報讀使用者永遠不知道開了什麼。
  updateDiceLabel(dice, settled) {
    const tray = this.el.diceTray;
    if (!tray) return;
    _sicboSetAttr(tray, 'role', 'img');
    if (!settled) {
      _sicboSetAttr(tray, 'aria-label', '骰盅搖動中');
      return;
    }
    const sum = dice[0] + dice[1] + dice[2];
    _sicboSetAttr(tray, 'aria-label', '開出 ' + dice.join('、') + '，共 ' + sum + ' 點');
  }

  // ==========================================================================
  // 4.8 演出腳本（契約 §6.4）
  //     結果在這裡就算完，後面全部只是把已知結果演出來。
  // ==========================================================================
  roll() {
    if (this.phase !== 'betting') return;
    if (this.bets.size === 0) {
      this.showToast('請先下注');
      return;
    }
    this.audio.unlock();   // 使用者手勢，iOS 唯一能解鎖 AudioContext 的時機

    const betsArray = this.betsArray();
    let result = null;
    try {
      const dice = _sicboCore.roll();
      result = _sicboCore.settle(betsArray, dice, { streakLevel: this.streak });
    } catch (err) {
      // 核心對未知 id / 非正整數金額會丟 TypeError。真的走到這裡代表桌面狀態已經壞掉，
      // 唯一安全的動作是把注退回去、留在 betting，而不是帶著壞資料進演出。
      _sicboWarn(err);
      this.refundBets();
      this.showToast('注單異常，已退回本局下注');
      return;
    }

    this.roundToken += 1;
    this.lastBets = betsArray.map(bet => ({ id: bet.id, amount: bet.amount }));
    this.clearRoundVisuals();
    this.pending = { result: result, betsArray: betsArray };
    this.setPhase('rolling');

    _sicboSetText(this.el.resultMsg, '骰盅搖起來了…');
    _sicboSetText(this.el.resultSub, '');
    this.updateDiceLabel(result.dice, false);

    const dice = result.dice;

    // 減少動態偏好：整段演出壓縮成 REDUCED_TOTAL_MS，不翻滾、不停頓、不放彩帶。
    // 只關動畫不關聲音 —— 前庭敏感與聽覺是兩件事。
    if (this.reducedMotion()) {
      this.audio.playShake();
      this.after(REDUCED_TOTAL_MS, () => {
        this.showDice(dice, { spin: true, land: false, sound: false });
        this.audio.playDie(2);
        this.commitRoll();
      });
      return;
    }

    this.startTumble();
    this.audio.playShake();

    // 懸念在這裡就決定：第三顆還沒落，但結果早就算出來了，所以能直接問核心
    // 「第三顆是否仍未定勝負」。有才多停 500ms，否則每局都拖半秒就只是延遲。
    //
    // 缺陷 K：核心改用「未定勝負」判準之後，押大小／單骰／組合這些最常見的注
    // 觸發率會很高（押大小時前兩顆和落在 5–9 就有 66.7% 的機會觸發），
    // 每局都停半秒的話「懸念」就退化成固定延遲。所以遊戲層加節流：
    // 連續 SUSPENSE_MAX_RUN 局都停過之後強制跳過一局，再重新計數。
    let wants = false;
    try {
      wants = !!_sicboCore.suspense(this.betsArray(), [dice[0], dice[1]]);
    } catch (_) {
      wants = false;
    }
    if (!wants) {
      this.suspenseRun = 0;
    } else if (this.suspenseRun >= SUSPENSE_MAX_RUN) {
      wants = false;
      this.suspenseRun = 0;   // 跳過這一局，下一局重新累積
    } else {
      this.suspenseRun += 1;
    }
    const extra = wants ? SUSPENSE_MS : 0;

    const t1 = SHAKE_MS;
    const t2 = t1 + DIE_GAP_MS;
    const t3 = t2 + DIE_GAP_MS + extra;

    this.after(t1, () => this.landDie(0, dice[0], {}));
    this.after(t2, () => {
      this.landDie(1, dice[1], {});
      if (extra > 0) _sicboToggleClass(this.el.stage, 'is-suspense', true);
    });
    this.after(t3, () => {
      _sicboToggleClass(this.el.stage, 'is-suspense', false);
      this.landDie(2, dice[2], {});
    });
    // 第三顆的落桌彈跳演完才結算：數字在骰子還在跳的時候就變會讓人看不出因果。
    this.after(t3 + LAND_MS + SETTLE_DELAY_MS, () => this.commitRoll());
  }

  // rolling 期間按 PLAY / Space：把三顆直接擺到位並立刻結算。
  // 結果早就算好了，跳過不會改變任何數字。
  skipRoll() {
    if (this.phase !== 'rolling' || !this.pending) return;
    this.clearTimers();
    this.stopTumble();
    _sicboToggleClass(this.el.stage, 'is-suspense', false);
    // 三顆同時播落桌音是噪音，跳過時只留最後一顆那一下。
    this.showDice(this.pending.result.dice, { spin: true, land: false, sound: false });
    this.audio.playDie(2);
    this.commitRoll();
  }

  // 結算的唯一入口。try / finally 是這個檔案最重要的四行：
  // 不管 settleRound 內部發生什麼，phase 一定會離開 rolling。
  commitRoll() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.clearTimers();

    let next = 'betting';
    try {
      next = this.settleRound(pending.result) || 'betting';
    } finally {
      this.setPhase(next);
      if (next === 'broke') this.openBrokeModal();
    }
  }

  // 新局開始前把上一局的高亮、浮動贏分痕跡清掉。
  clearRoundVisuals() {
    this.clearHighlights();
    const stage = this.el.stage;
    if (stage && typeof stage.querySelectorAll === 'function') {
      const floats = stage.querySelectorAll('.float-gain');
      if (floats && floats.forEach) {
        floats.forEach((node) => { if (typeof node.remove === 'function') node.remove(); });
      }
    }
  }

  clearHighlights() {
    this.cellById.forEach((cell) => {
      if (cell && cell.classList) cell.classList.remove('is-win', 'is-lose');
    });
    if (this.el.resultMsg && this.el.resultMsg.classList) {
      this.el.resultMsg.classList.remove('is-win', 'is-lose');
    }
    if (this.el.balance && this.el.balance.classList) {
      this.el.balance.classList.remove('is-up', 'is-down');
    }
  }

  // ==========================================================================
  // 4.9 結算（契約 §6.5）。回傳下一個 phase。
  // ==========================================================================
  settleRound(result) {
    const token = this.roundToken;
    const before = this.balance;
    this.balance += result.returned;

    // 1. 餘額補間
    this.flashBalance(result.net, token);
    this.animateBalance(before);

    // 2 + 3. 注格高亮與浮動贏分
    const winners = result.lines.filter(line => line.won);
    result.lines.forEach((line) => {
      const cell = this.cellById.get(line.id);
      if (!cell || !cell.classList) return;
      cell.classList.add(line.won ? 'is-win' : 'is-lose');
    });
    const floatSpots = this.floatGainLayout(winners.length);
    winners.forEach((line, index) => {
      this.spawnFloatGain('+' + _sicboCore.formatNumber(line.payout), floatSpots[index]);
    });
    this.cleanupAfter(PULSE_MS, () => {
      if (token !== this.roundToken) return;
      this.clearHighlights();
    });

    // 4. 連勝
    if (result.won) this.streak += 1;
    else this.streak = 0;
    this.renderStreak();
    if (result.won && this.streak >= _sicboCore.STREAK_MIN_LEVEL) this.audio.playStreak(this.streak);

    // 5. 主訊息
    this.updateDiceLabel(result.dice, true);
    // 缺陷 M：整頁只有 #result-msg 與 toast 是 live region，骰面卻只寫在 #dice-tray 的
    // aria-label 上（那不是 live region，改了不會被播報）。實測押 triple-any 開出
    // 6-6-6 的一整局，報讀者只聽得到「中獎！贏了 300 分」，完全不知道開了什麼。
    // 把骰面併進主訊息的句子，一次播報就同時交代「開什麼」與「贏輸多少」。
    const faceText = '開出 ' + result.dice.join('、') + '，共 ' + result.sum + ' 點';
    // 缺陷 E：舊版主訊息只看淨損益。實測押「大 500 + 小 100」開 1,2,3：小格金色高亮、
    // 骰盤上飄著 +100，主訊息卻寫「沒中，輸了 400 分」—— 對沖注單有 51.4% 的局會
    // 出現這個矛盾，而「沒中」在字面上就是錯的。所以「有沒有注中」與「淨損益」
    // 分成兩件事講，完全沒中才寫「沒中」。
    let hitPayout = 0;
    winners.forEach((line) => { hitPayout += line.payout; });
    const hitText = '中了 ' + winners.length + ' 注 +' + _sicboCore.formatNumber(hitPayout);
    let verdict = '打平，不輸不贏';
    let tone = '';
    if (result.net > 0) {
      verdict = '中獎！贏了 ' + _sicboCore.formatNumber(result.net) + ' 分';
      tone = 'is-win';
    } else if (result.net < 0) {
      verdict = winners.length > 0
        ? hitText + '，本局淨輸 ' + _sicboCore.formatNumber(Math.abs(result.net)) + ' 分'
        : '沒中，輸了 ' + _sicboCore.formatNumber(Math.abs(result.net)) + ' 分';
      tone = 'is-lose';
    } else if (winners.length > 0) {
      verdict = hitText + '，本局打平';
    }
    _sicboSetText(this.el.resultMsg, faceText + ' —— ' + verdict);
    if (this.el.resultMsg && this.el.resultMsg.classList && tone) this.el.resultMsg.classList.add(tone);

    // 6. 副訊息（連勝口徑與近失節流見 buildSubMessage）
    _sicboSetText(this.el.resultSub, this.buildSubMessage(result));

    // 7. 音效、彩帶、震動
    const bigWin = result.net > 0 && result.net >= result.stake * BIG_WIN_RATIO;
    if (bigWin) {
      this.audio.playWinBig();
      this.fireConfetti();
      _sicboVibrate([60, 40, 120]);
    } else if (result.net > 0) {
      this.audio.playWinSmall();
      _sicboVibrate(40);
    } else if (result.net < 0) {
      this.audio.playLose();
    } else {
      this.audio.playPush();
    }

    // 8. 歷史：單筆 prepend + 移除尾端，不整包重畫。
    //    entry 與它的 DOM 列都留著參考：翻倍挑戰結束後要回頭改寫這一列的淨額
    //    （缺陷 F），否則畫面上會永遠留著「+500」而餘額對不上。
    const entry = {
      dice: [result.dice[0], result.dice[1], result.dice[2]],
      sum: result.sum,
      net: result.net,
      streak: this.streak
    };
    const entryItem = this.pushHistory(entry);

    // 9. 統計與里程碑
    this.bumpStats(result);
    this.awardMilestones();

    // 10. 先把已結算的注從桌上收掉（不退錢：本金在下注時就扣了、也已經由 settle 結算），
    //     再存檔。順序不能顛倒 —— saveGame() 會把「桌上還沒開的注」算回餘額，
    //     而這些注已經開過了，留在桌上存檔等於把同一筆本金記兩次。
    this.resetTable();
    this.saveGame();   // 每局只寫一次；placeBet / clearBets 刻意不寫，減少寫入次數

    // 11. keepBets：注單留在桌上方便連押，但本金要重新從餘額扣一次
    if (this.keepBets && this.lastBets.length) {
      let need = 0;
      this.lastBets.forEach((bet) => { need += bet.amount; });
      if (need <= this.balance) {
        this.lastBets.forEach(bet => this.applyBet(bet.id, bet.amount));
      } else {
        this.showToast('餘額不足，注單已清空');
      }
    }

    // 12 + 13. 下一個狀態
    if (result.net > 0) {
      this.beginGambleOffer(result.net, entry, entryItem);
      return 'settling';
    }
    if (this.isBroke()) {
      this.audio.playBroke();
      return 'broke';
    }
    return 'betting';
  }

  // 缺陷 I：副訊息寫「連勝 ×2　賠付 +10%」，正下方 12px 的連勝條卻寫「3 連勝　+20%」——
  // 兩個連勝數、兩個百分比，畫面上沒有任何字說明「副訊息講本局套用的級數、
  // 連勝條講結算後的新級數」。而且在一款所有 ×N 都代表賠率的遊戲裡（×60 / ×180 / ×11），
  // 「連勝 ×2」很容易被讀成「賠付 2 倍」。
  // 修法：兩處都不再用「×」，並各自把時態講白 ——
  //   副訊息 →「本局套用第 2 連勝加成 +10%，多拿 10 分」
  //   連勝條 →「3 連勝　下一局加成 +20%」（見 renderStreak）
  // 另外淨損為負的局不把加成當主要副訊息（實測會出現「輸了 88 分」配「賠付 +20%」、
  // 同一刻連勝條卻消失的三重矛盾），改成先講「連勝中斷」。
  buildSubMessage(result) {
    if (result.net < 0) {
      const parts = [];
      if (result.streakLevel >= 1) parts.push('連勝中斷（原本 ' + result.streakLevel + ' 連勝）');
      const miss = this.nearMissMessage(result);
      if (miss) parts.push(miss);
      return parts.join('　');
    }
    if (result.streakBonus > 0) {
      return '本局套用第 ' + result.streakLevel + ' 連勝加成 +'
        + Math.round(result.streakRate * 100) + '%，多拿 '
        + _sicboCore.formatNumber(result.streakBonus) + ' 分';
    }
    return '';
  }

  // 缺陷 J：近失文案洗版。實測固定注單跑 30 局，9 次輸局全部是逐字相同的那一句，
  // 安慰於是變成背景雜訊。這裡按「情境種類」節流：同一種 NEAR_MISS_COOLDOWN_ROUNDS
  // 局內只出現一次。roundToken 每開一局 +1，正好可以當局序號用。
  nearMissMessage(result) {
    let miss = null;
    try {
      miss = _sicboCore.nearMiss(this.betsArray(), result.dice);
    } catch (_) {
      miss = null;   // 安慰文案不值得為它中斷結算
    }
    if (!miss || !miss.message) return '';
    // 核心會提供 kind（近失情境種類）。還沒有這個欄位的版本退回用注型當種類，
    // 兩種都能達到「同一種安慰句不連續洗版」的目的。
    let kind = (typeof miss.kind === 'string' && miss.kind) ? miss.kind : '';
    if (!kind) {
      const bet = miss.betId ? _sicboCore.getBet(miss.betId) : null;
      kind = bet ? bet.type : 'misc';
    }
    const last = this.missShownAt.get(kind);
    if (Number.isFinite(last) && (this.roundToken - last) < NEAR_MISS_COOLDOWN_ROUNDS) return '';
    this.missShownAt.set(kind, this.roundToken);
    return miss.message;
  }

  // 缺陷 C：多注同時中獎時，三個 .float-gain 的 getBoundingClientRect 完全相同
  // （實測 {x:303, y:77} ×3），畫面上只看得到一個「+100」。根因是 JS 寫 --i / --n
  // 而 CSS 讀的是 top: var(--gy) / left: var(--gx)。介面已釘死由 JS 寫 --gx / --gy，
  // 所以換算的責任在這裡：把同一局的多筆贏分排成幾欄（必要時換行），
  // 並夾在舞台範圍內，免得飄出舞台或（sticky 釘在頂端時）飄出視窗上緣。
  floatGainLayout(total) {
    const spots = [];
    const count = Math.max(1, total | 0);
    const stage = this.el.stage;
    const rect = (stage && typeof stage.getBoundingClientRect === 'function')
      ? stage.getBoundingClientRect()
      : null;
    const width = rect && rect.width > 0 ? rect.width : 320;
    const height = rect && rect.height > 0 ? rect.height : 240;

    // 一列最多放幾筆：兩側各留 FLOAT_EDGE_PAD（文字有 translate(-50%)，
    // 所以真正的可用寬度要先扣掉半個字寬的餘裕）。
    const usable = Math.max(FLOAT_MIN_COL, width - FLOAT_EDGE_PAD * 2);
    const perRow = Math.max(1, Math.min(count, Math.floor(usable / FLOAT_MIN_COL)));
    const step = Math.min(FLOAT_COL_STEP, usable / perRow);
    // 起點刻意不是舞台頂端：CSS 的 floatGain 會往上飄 40px，從 top: 6px 起飄會
    // 直接穿出 sticky 舞台的上緣（在手機上就是飄出視窗）。取舞台中段偏上，
    // 並保證「起點 - 飄升距離」還在舞台裡。
    const baseY = Math.max(FLOAT_RISE_PX, Math.min(height * 0.42, height - FLOAT_RISE_PX));

    for (let i = 0; i < count; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const offset = (col - (perRow - 1) / 2) * step;
      const x = Math.min(width - FLOAT_EDGE_PAD, Math.max(FLOAT_EDGE_PAD, width / 2 + offset));
      // 第二列以後往「上」疊（疊到骰盤上方），不往下疊：舞台下半部是結果訊息與
      // 餘額，往下疊會直接壓在那些字上面（390px 的手機實測會蓋住主訊息那一行）。
      const y = Math.min(height - 18, Math.max(FLOAT_RISE_PX, baseY - row * FLOAT_ROW_STEP));
      spots.push({ x: Math.round(x), y: Math.round(y) });
    }
    return spots;
  }

  spawnFloatGain(text, spot) {
    const stage = this.el.stage;
    if (!stage || typeof document.createElement !== 'function') return;
    const node = document.createElement('span');
    node.className = 'float-gain';
    node.textContent = text;
    // CSS 端的位置 hook 是 top: var(--gy, 6px) / left: var(--gx, 50%)（介面釘死），
    // 由這裡寫入換算好的實際值 —— 絕不再寫 --i / --n，那兩個變數沒有人讀。
    if (node.style && typeof node.style.setProperty === 'function' && spot) {
      node.style.setProperty('--gx', spot.x + 'px');
      node.style.setProperty('--gy', spot.y + 'px');
    }
    stage.appendChild(node);
    // 動畫結束就移除節點：animationend 為主、計時器兜底
    //（reduced-motion 下 CSS 可能整段關掉動畫，那時永遠不會有事件）。
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      if (typeof node.remove === 'function') node.remove();
    };
    if (typeof node.addEventListener === 'function') {
      node.addEventListener('animationend', remove, { once: true });
    }
    this.cleanupAfter(FLOAT_MS, remove);
  }

  fireConfetti() {
    const canvas = this.el.confettiCanvas;
    if (!canvas) return;
    const kit = (typeof BoboConfetti !== 'undefined' && BoboConfetti) ? BoboConfetti : null;
    if (!kit) return;
    if (this.reducedMotion()) return;   // 模組自己也會擋，這裡先擋省掉準備工作
    try {
      // burst 的簽章是 burst(canvas, options)：第一個參數必須是真正的 canvas 元素。
      // 傳 { canvas } 物件會被模組的守衛擋掉而靜靜不播（2048 就是這樣沒播過）。
      this.confettiStop = kit.burst(canvas, {
        colors: ['#b8860b', '#e2b74a', '#1f6b47', '#2e8f60', '#f7ecd0'],
        pieces: 70,
        origin: 'center',
        spread: 16,
        gravity: 0.12,
        fade: 0.018
      });
    } catch (_) {}
  }

  // ==========================================================================
  // 4.10 連勝計量條
  // ==========================================================================
  renderStreak() {
    const meter = this.el.streakMeter;
    if (!meter) return;
    if (this.streak < 1) {
      meter.hidden = true;   // 沒有連勝時整塊收掉，不留一條空進度條
      _sicboSetText(this.el.streakLabel, '');
      return;
    }
    meter.hidden = false;
    const percent = _sicboStreakPercent(this.streak);
    const max = Math.round(_sicboCore.STREAK_MAX * 100);
    const fill = this.el.streakFill;
    if (fill && fill.style && typeof fill.style.setProperty === 'function') {
      // JS 只寫 --pct（帶 % 單位），寬度由 CSS 的 width: var(--pct) 決定
      const pct = max > 0 ? Math.min(100, Math.round(percent / max * 100)) : 0;
      fill.style.setProperty('--pct', pct + '%');
    }
    // 缺陷 I：這條條講的是「結算後的連勝數」，也就是它顯示的加成要到下一局才會套用。
    // 舊文案寫「3 連勝　賠付 +20%」，與副訊息講的本局加成（+10%）在畫面上並列，
    // 看起來像同一件事的兩個矛盾數字。加上「下一局」兩個字就把時態講清楚了。
    _sicboSetText(
      this.el.streakLabel,
      percent > 0
        ? this.streak + ' 連勝　下一局加成 +' + percent + '%'
        : this.streak + ' 連勝　再贏一局開始加成'
    );
  }

  // ==========================================================================
  // 4.11 歷史紀錄
  //      單筆 prepend + 超量砍尾端。舊版每局用 innerHTML 重建 50 個節點，
  //      既浪費也是 XSS 溫床（這裡全程 createElement + textContent）。
  // ==========================================================================
  // 回傳剛插入的 DOM 列：翻倍挑戰結束後要用它就地改寫那一列（缺陷 F）。
  pushHistory(entry) {
    this.rounds.unshift(entry);
    while (this.rounds.length > _sicboCore.HISTORY_LIMIT) this.rounds.pop();

    const list = this.el.historyList;
    if (!list) return null;
    const item = this.buildHistoryItem(entry);
    if (list.firstChild) list.insertBefore(item, list.firstChild);
    else list.appendChild(item);
    while (list.children && list.children.length > _sicboCore.HISTORY_LIMIT) {
      const last = list.lastChild;
      if (!last) break;
      list.removeChild(last);
    }
    this.syncHistoryEmpty();
    return item;
  }

  // 就地換掉某一列（entry 的 net / note 改過之後）。找不到舊節點就靜靜跳過：
  // 那代表這一列已經被後續的局擠出 50 筆上限，本來就不該再出現在畫面上。
  replaceHistoryItem(entry, item) {
    if (!entry || !item) return null;
    const list = this.el.historyList;
    if (!list || typeof list.replaceChild !== 'function') return null;
    if (item.parentNode !== list) return null;
    const fresh = this.buildHistoryItem(entry);
    list.replaceChild(fresh, item);
    return fresh;
  }

  buildHistoryItem(entry) {
    const item = document.createElement('div');
    // net === 0 走獨立的 is-push。舊版把 >= 0 都算成 win，於是「打平」的訊息是中性灰、
    // 同一局的歷史列卻是紅色 +0，同一件事兩種顏色語意。
    const state = entry.net > 0 ? 'is-win' : (entry.net < 0 ? 'is-lose' : 'is-push');
    item.className = 'history-item ' + state;

    const dice = document.createElement('span');
    dice.className = 'history-dice';
    let text = entry.dice.join(' ') + '　' + entry.sum + ' 點';
    if (entry.streak >= _sicboCore.STREAK_MIN_LEVEL) text += '　🔥' + entry.streak;
    // 翻倍挑戰的結果（缺陷 F）。note 只是畫面註記，核心的 normalizeHistory 只留
    // dice / sum / net / streak，所以重新整理後註記會消失、但淨額是改過的正確值。
    if (entry.note) text += '　' + entry.note;
    dice.textContent = text;

    const net = document.createElement('span');
    net.className = 'history-net';
    net.textContent = entry.net > 0
      ? '+' + _sicboCore.formatNumber(entry.net)
      : (entry.net < 0 ? _sicboCore.formatNumber(entry.net) : '±0');

    item.appendChild(dice);
    item.appendChild(net);
    return item;
  }

  // 讀檔後的一次性建表（之後都是單筆 prepend）
  renderHistoryList() {
    const list = this.el.historyList;
    if (list) {
      list.textContent = '';
      this.rounds.forEach((entry) => list.appendChild(this.buildHistoryItem(entry)));
    }
    this.syncHistoryEmpty();
  }

  syncHistoryEmpty() {
    if (this.el.historyEmpty) this.el.historyEmpty.hidden = this.rounds.length > 0;
  }

  // ==========================================================================
  // 4.12 統計與里程碑
  // ==========================================================================
  bumpStats(result) {
    const stats = this.stats;
    stats.rounds += 1;
    if (result.won) stats.wins += 1;
    if (result.net > stats.biggestWin) stats.biggestWin = result.net;
    if (this.balance > stats.peakBalance) stats.peakBalance = this.balance;
    if (result.isTriple) stats.triples += 1;
    if (this.streak > stats.bestStreak) stats.bestStreak = this.streak;
    stats.totalStake += result.stake;
    stats.totalReturned += result.returned;
  }

  awardMilestones() {
    let gained = [];
    try {
      gained = _sicboCore.checkMilestones(this.stats, this.milestoneIds);
    } catch (_) {
      gained = [];
    }
    if (!gained.length) return;
    gained.forEach((milestone) => { this.milestoneIds.push(milestone.id); });
    // 缺陷 H 的另一半：實測押 500 中「點數 4」（×60，淨賺 30,000）那一局同時解鎖
    // 5 個里程碑，5 條 toast 一起出現 2.4 秒，在 1280 寬的畫面上正好蓋住剛中獎的
    // 金色格子 —— 全場最大的一次中獎被自己的慶祝訊息擋住。
    // 同局多解鎖時合併成一條，細節留在戰績彈窗的徽章牆。
    if (gained.length === 1) {
      this.showToast('🏅 ' + gained[0].label);
    } else {
      this.showToast('🏅 一次達成 ' + gained.length + ' 個里程碑（📊 戰績可看明細）');
    }
    // 同一局同時解鎖兩三個里程碑時只播一次：三段琶音疊在一起只會變成噪音。
    this.audio.playMilestone();
  }

  winRateText() {
    const stats = this.stats;
    if (!stats.rounds) return '—';
    return Math.round(stats.wins / stats.rounds * 100) + '%';
  }

  // 統計格全部用 createElement 組，不拼 HTML 字串。
  buildStatGrid(items) {
    const grid = document.createElement('div');
    grid.className = 'stats-grid';
    items.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'stat-item';
      const label = document.createElement('div');
      label.className = 'stat-label';
      label.textContent = entry[0];
      const value = document.createElement('div');
      value.className = 'stat-val';
      value.textContent = entry[1];
      item.appendChild(label);
      item.appendChild(value);
      grid.appendChild(item);
    });
    return grid;
  }

  renderStatsBody() {
    const body = this.el.statsBody;
    if (!body) return;
    const stats = this.stats;
    body.textContent = '';

    body.appendChild(this.buildStatGrid([
      ['總局數', _sicboCore.formatNumber(stats.rounds)],
      ['勝率', this.winRateText()],
      ['最大單局贏分', _sicboCore.formatNumber(stats.biggestWin)],
      ['最高餘額', _sicboCore.formatNumber(stats.peakBalance)],
      ['最長連勝', _sicboCore.formatNumber(stats.bestStreak)],
      ['開出圍骰', _sicboCore.formatNumber(stats.triples) + ' 次'],
      ['翻倍戰績', stats.gambleWins + ' 勝 ' + stats.gambleLosses + ' 敗'],
      ['目前連勝', _sicboCore.formatNumber(this.streak)]
    ]));

    const note = document.createElement('p');
    note.className = 'stats-note';
    note.textContent = '累計押注 ' + _sicboCore.formatNumber(stats.totalStake)
      + '，累計回收 ' + _sicboCore.formatNumber(stats.totalReturned)
      + '（回收率 ' + (stats.totalStake > 0 ? Math.round(stats.totalReturned / stats.totalStake * 100) + '%' : '—') + '）';
    body.appendChild(note);

    // 里程碑徽章牆：達成的亮起，沒達成的留灰，讓玩家看得到下一個目標。
    const wallTitle = document.createElement('h3');
    wallTitle.textContent = '里程碑';
    body.appendChild(wallTitle);

    const wall = document.createElement('div');
    wall.className = 'milestone-wall';
    const hit = new Set(this.milestoneIds);
    _sicboCore.MILESTONES.forEach((milestone) => {
      const badge = document.createElement('span');
      const done = hit.has(milestone.id);
      badge.className = 'milestone-badge' + (done ? ' is-hit' : '');
      badge.textContent = (done ? '🏅 ' : '🔒 ') + milestone.label;
      _sicboSetAttr(badge, 'title', done ? '已達成：' + milestone.label : '尚未達成：' + milestone.label);
      wall.appendChild(badge);
    });
    body.appendChild(wall);
  }

  renderBrokeBody() {
    const body = this.el.brokeBody;
    if (!body) return;
    const stats = this.stats;
    body.textContent = '';

    const intro = document.createElement('p');
    intro.textContent = '餘額不足最小籌碼（' + _sicboCore.formatNumber(_sicboCore.CHIPS[0]) + '），這一輪先到這裡。';
    body.appendChild(intro);

    body.appendChild(this.buildStatGrid([
      ['總局數', _sicboCore.formatNumber(stats.rounds)],
      ['勝率', this.winRateText()],
      ['最大單局贏分', _sicboCore.formatNumber(stats.biggestWin)],
      ['最高餘額', _sicboCore.formatNumber(stats.peakBalance)]
    ]));

    const note = document.createElement('p');
    note.className = 'stats-note';
    note.textContent = '重新開始只會把餘額補回 '
      + _sicboCore.formatNumber(_sicboCore.START_BALANCE)
      + ' 並把連勝歸零，戰績與里程碑都會留著。';
    body.appendChild(note);
  }

  // ==========================================================================
  // 4.13 翻倍挑戰（契約 §6.6）
  //      賭本在玩家真的按下押小／押大時才從餘額扣（而不是一進 settling 就扣）：
  //      這樣「按 PLAY 直接進下一局」不需要任何退款路徑。
  //
  //      缺陷 G：賭本被扣走之後，存檔必須把「待決的彩池」算回去。saveGame() 寫的是
  //      this.balance + 桌上押注，而 startGamble 已經把彩池從 balance 扣掉，
  //      直接存會把整個彩池記成輸掉（實測：翻倍兩次後重新整理，6,000 的彩池歸零）。
  //      所以 saveGame() 多加一項 gambleStaked ? gambleAmount : 0，語意是
  //      「重新整理等於自動收下當下的彩池」—— 身家一分不差，也不會重複入帳。
  //      有了這條不變量之後，每一次彩池變動（下賭本、翻倍成功、失敗、收下）都要存檔。
  // ==========================================================================
  beginGambleOffer(amount, entry, entryItem) {
    this.gambleAmount = amount;
    this.gambleBase = amount;       // 失敗時要說「剛才的 N 分飛了」
    this.gambleRounds = 0;
    this.gambleStaked = false;
    this.gambleBusy = false;
    this.gambleEntry = entry || null;
    this.gambleItem = entryItem || null;
    this.renderGamble();
  }

  // 缺陷 F：翻倍結束後，舞台主訊息與歷史那一列仍停在「中獎！贏了 N 分 / +N」，
  // 唯一提過失敗的是那句 2.4 秒就消失的 toast。實測翻倍失敗 3 秒後畫面只剩
  // 「中獎！贏了 500 分」配「餘額 500」，玩家找不到任何解釋。
  // 這裡在翻倍真正落幕時（失敗或收下）改寫兩段訊息，並把歷史那一列的淨額
  // 更新成「含翻倍結果的實際淨額」。
  //
  // 為什麼實際淨額就是 pot：本局下注時已扣 stake、結算時已入帳 returned
  //（淨額 = net），接著 startGamble 又把 net 當賭本扣走，最後收下 pot。
  // 三筆相加 = net - net + pot = pot。翻倍失敗 pot = 0，也就是這一局白忙。
  finishGambleRound(pot, kind) {
    const base = this.gambleBase;
    const entry = this.gambleEntry;
    if (entry) {
      entry.net = pot;
      if (kind === 'lose') entry.note = '翻倍失敗';
      else if (this.gambleRounds > 0) entry.note = '翻倍 ×' + Math.pow(2, this.gambleRounds);
      this.gambleItem = this.replaceHistoryItem(entry, this.gambleItem);
    }

    const msgEl = this.el.resultMsg;
    if (msgEl && msgEl.classList) msgEl.classList.remove('is-win', 'is-lose');
    if (kind === 'lose') {
      _sicboSetText(msgEl, '翻倍失敗，剛才的 ' + _sicboCore.formatNumber(base) + ' 分飛了');
      if (msgEl && msgEl.classList) msgEl.classList.add('is-lose');
      _sicboSetText(this.el.resultSub, '這一局的實際淨額變成 ±0 分，下一局重新開始。');
    } else {
      _sicboSetText(msgEl, '收下 ' + _sicboCore.formatNumber(pot) + ' 分');
      if (msgEl && msgEl.classList) msgEl.classList.add('is-win');
      _sicboSetText(
        this.el.resultSub,
        this.gambleRounds > 0
          ? '翻倍 ' + this.gambleRounds + ' 次，' + _sicboCore.formatNumber(base)
            + ' 分變成 ' + _sicboCore.formatNumber(pot) + ' 分。'
          : ''
      );
    }
    this.gambleEntry = null;
    this.gambleItem = null;
    this.gambleBase = 0;
  }

  // 缺陷 N 的共用件：把焦點從（即將被停用或隱藏的）翻倍面板搬到主動作鍵。
  // 只在焦點真的在面板裡時才動 —— 玩家自己把焦點移到別處時搶焦點更糟。
  moveFocusOutOfGamblePanel() {
    if (typeof document === 'undefined') return;
    const panel = this.el.gamblePanel;
    const active = document.activeElement;
    if (!panel || !active || typeof panel.contains !== 'function') return;
    if (!panel.contains(active)) return;
    const fallback = this.el.rollBtn;
    if (fallback && typeof fallback.focus === 'function') fallback.focus();
    else if (typeof active.blur === 'function') active.blur();
  }

  renderGamble() {
    _sicboSetText(this.el.gambleAmount, _sicboCore ? _sicboCore.formatNumber(this.gambleAmount) : String(this.gambleAmount));
    const canBet = (this.phase === 'settling' || this.phase === 'gamble')
      && this.gambleAmount > 0 && !this.gambleBusy;
    if (this.el.gambleSmall) this.el.gambleSmall.disabled = !canBet;
    if (this.el.gambleBig) this.el.gambleBig.disabled = !canBet;
    if (this.el.gambleTake) this.el.gambleTake.disabled = this.gambleBusy || this.gambleAmount <= 0;
  }

  startGamble(pick) {
    if (this.phase !== 'settling' && this.phase !== 'gamble') return;
    if (this.gambleBusy || this.gambleAmount <= 0) return;
    this.audio.unlock();

    // 缺陷 N：renderGamble 馬上會把押小／押大（連同「收下」）設成 disabled，
    // 而 Chrome 對「正在被停用的 activeElement」的處置是把焦點丟回 <body>；
    // 實測骰子落定、面板收起之後焦點還在 body，鍵盤玩家的 Tab 位置整個被重設。
    // 所以在停用之前先把焦點交給演出期間仍然存在、可聚焦的主動作鍵。
    this.moveFocusOutOfGamblePanel();

    if (!this.gambleStaked) {
      const before = this.balance;
      this.balance -= this.gambleAmount;
      this.gambleStaked = true;
      this.animateBalance(before);
    }
    this.gambleBusy = true;
    this.setPhase('gamble');
    // 賭本已離開餘額：立刻存檔（saveGame 會把待決彩池算回去），
    // 這樣連「骰子還在轉的 520ms 內關掉分頁」都不會讓這筆錢消失。
    this.saveGame();

    let outcome = null;
    try {
      outcome = _sicboCore.gambleResult(pick, _sicboCore.gambleRoll());
    } catch (err) {
      // pick 只會是 'small' / 'big'，真的丟錯代表接線壞了：把賭本還回去收場。
      _sicboWarn(err);
      this.gambleBusy = false;
      this.takeGamble();
      return;
    }

    const cube = this.el.gambleCube;
    if (cube && cube.classList) cube.classList.add('is-rolling');
    this.audio.playShake();
    this.renderGamble();

    const wait = this.reducedMotion() ? REDUCED_TOTAL_MS : SHAKE_MS;
    this.after(wait, () => this.resolveGamble(outcome));
  }

  resolveGamble(outcome) {
    this.gambleBusy = false;
    const cube = this.el.gambleCube;
    if (cube && cube.classList) cube.classList.remove('is-rolling');
    this.gambleSpin += 2;
    this.setCubeFace(cube, outcome.die, this.gambleSpin);
    if (this.el.gambleDie && this.el.gambleDie.classList) {
      this.el.gambleDie.classList.add('is-landing');
      this.cleanupAfter(LAND_MS, () => this.el.gambleDie.classList.remove('is-landing'));
    }
    this.audio.playDie(1);

    if (outcome.win) {
      this.gambleAmount *= 2;
      this.gambleRounds += 1;
      this.stats.gambleWins += 1;
      this.audio.playGambleWin();
      _sicboVibrate(40);
      if (this.gambleRounds >= _sicboCore.GAMBLE_MAX_ROUNDS) {
        this.showToast('開 ' + outcome.die + ' 點，連續翻倍 ' + this.gambleRounds + ' 次，自動收下');
        this.takeGamble();
        return;
      }
      this.showToast('開 ' + outcome.die + ' 點，翻倍成功！目前 ' + _sicboCore.formatNumber(this.gambleAmount) + ' 分');
      // 缺陷 F：贏了還要繼續賭時，舞台訊息也得跟上，不能停在「中獎！贏了 N 分」——
      // 那個數字在彩池翻倍之後已經不是玩家手上的金額。
      _sicboSetText(
        this.el.resultMsg,
        '翻倍成功！開 ' + outcome.die + ' 點，彩池 ' + _sicboCore.formatNumber(this.gambleAmount) + ' 分'
      );
      if (this.el.resultMsg && this.el.resultMsg.classList) {
        this.el.resultMsg.classList.remove('is-lose');
        this.el.resultMsg.classList.add('is-win');
      }
      _sicboSetText(
        this.el.resultSub,
        '已翻倍 ' + this.gambleRounds + ' / ' + _sicboCore.GAMBLE_MAX_ROUNDS
          + ' 次，再猜中一次變 ' + _sicboCore.formatNumber(this.gambleAmount * 2)
          + ' 分，或按「收下」落袋。'
      );
      this.setPhase('gamble');
      this.renderGamble();
      // 缺陷 G：這個分支原本沒有存檔 —— 實測翻倍成功後重新整理，畫面上的 6,000
      // 會掉回存檔裡的 3,000（甚至因為賭本已扣而整個彩池記成輸掉）。
      this.saveGame();
      return;
    }

    this.stats.gambleLosses += 1;
    this.gambleAmount = 0;
    this.gambleStaked = false;
    this.audio.playGambleLose();
    this.showToast('開 ' + outcome.die + ' 點，翻倍失敗，這筆贏分飛了');
    this.finishGambleRound(0, 'lose');
    this.gambleRounds = 0;   // finishGambleRound 要靠它算「翻倍幾次」，所以在它之後才歸零
    this.saveGame();
    this.endGamble();
  }

  // 收下：把賭本（若已扣下）加回餘額。沒扣過就只是關掉面板 ——
  // gambleStaked 這個旗標是「不會重複入帳」的唯一保證。
  takeGamble() {
    const amount = this.gambleAmount;
    if (this.gambleStaked && amount > 0) {
      const before = this.balance;
      this.balance += amount;
      this.flashBalance(amount, this.roundToken);
      this.animateBalance(before);
      if (this.balance > this.stats.peakBalance) this.stats.peakBalance = this.balance;
      this.awardMilestones();
      this.showToast('收下 ' + _sicboCore.formatNumber(amount) + ' 分');
      // 缺陷 F：真的賭過才需要改寫訊息與歷史（沒賭過的話那一局的訊息本來就是對的）
      this.finishGambleRound(amount, 'take');
    } else {
      // 沒賭過就直接收：只要把參考放掉，免得下一局的 finishGambleRound 改到舊列
      this.gambleEntry = null;
      this.gambleItem = null;
      this.gambleBase = 0;
    }
    this.gambleAmount = 0;
    this.gambleStaked = false;
    this.gambleRounds = 0;
    this.gambleBusy = false;
    this.saveGame();
    this.endGamble();
  }

  endGamble() {
    // 缺陷 N：面板即將被 setPhase 設成 hidden。若 activeElement 還在面板裡，
    // 隱藏之後焦點會掉到 <body>（實測「收下」按 Enter 就會這樣），先接走它。
    this.moveFocusOutOfGamblePanel();
    this.renderGamble();
    if (this.isBroke()) {
      this.audio.playBroke();
      this.setPhase('broke');
      this.openBrokeModal();
      return;
    }
    this.setPhase('betting');
  }

  // ==========================================================================
  // 4.14 破產與重新開始
  // ==========================================================================
  isBroke() {
    if (!_sicboCore) return false;
    return this.balance < _sicboCore.CHIPS[0] && this.bets.size === 0;
  }

  openBrokeModal() {
    this.renderBrokeBody();
    this.openModal(this.el.brokeModal, this.el.restartBtn);
  }

  restart() {
    this.balance = _sicboCore.START_BALANCE;
    this.streak = 0;
    this.resetTable();          // 破產時桌上本來就沒注，這裡只是保險
    this.pending = null;
    this.clearTimers();
    this.gambleAmount = 0;
    this.gambleStaked = false;
    this.gambleRounds = 0;
    this.gambleBusy = false;
    this.gambleBase = 0;
    this.gambleEntry = null;    // 放掉上一輪的歷史列參考，免得翻倍訊息改到舊資料
    this.gambleItem = null;
    this.suspenseRun = 0;
    // 戰績與里程碑刻意保留：那是玩家累積的紀錄，補碼不該把它抹掉。
    this.renderBalance();
    this.renderStreak();
    this.updateTotalBet();
    this.clearRoundVisuals();
    _sicboSetText(this.el.resultMsg, '選一顆籌碼，押幾注，按 PLAY 開骰。');
    _sicboSetText(this.el.resultSub, '');
    this.saveGame();
    this.closeModal(this.el.brokeModal);
    this.setPhase('betting');
    this.showToast('重新開始，補上 ' + _sicboCore.formatNumber(_sicboCore.START_BALANCE) + ' 分');
  }

  // ==========================================================================
  // 4.15 彈窗（hidden 管可及性、.open class 管進場動畫，兩軌並行）
  // ==========================================================================
  openModal(modal, focusTarget) {
    if (!modal) return;
    // 取消上一次關閉排定、尚未觸發的隱藏計時器：否則在淡出期間重開同一個彈窗，
    // 舊 timer 會在開啟後才把它設成 hidden，畫面上消失但 .open 還在。
    if (modal._hideTimer !== null && modal._hideTimer !== undefined) {
      if (typeof clearTimeout === 'function') clearTimeout(modal._hideTimer);
      modal._hideTimer = null;
    }

    // 缺陷 O：openModal 原本不檢查是否已有彈窗開著。實測「演出期間點開戰績 → 這局
    // 破產」會同時出現兩層 .modal-overlay.open（兩層遮罩疊在一起），而且
    // this.lastFocused 是單一插槽，第二次開窗把它覆寫成戰績窗裡的按鈕，
    // 關窗後焦點就掉到 <body>。所以：先關掉既有最上層彈窗，再讓每個彈窗
    // 各自記住自己的觸發者（modal._opener），關閉時只還原自己那一份。
    let opener = (typeof document !== 'undefined') ? document.activeElement : null;
    const current = this.topModal();
    if (current && current !== modal) {
      // 既有彈窗裡的按鈕不能當新彈窗的觸發者（它馬上就要消失），
      // 改繼承那個彈窗的觸發者。
      if (opener && current.contains && current.contains(opener)) opener = current._opener || null;
      this.closeModal(current, { restoreFocus: false });
    }
    modal._opener = this.isFocusable(opener) ? opener : null;

    modal.hidden = false;
    _sicboSetAttr(modal, 'aria-hidden', 'false');
    this.setBackgroundInert(true);
    _sicboNextFrame(() => {
      if (modal.classList) modal.classList.add('open');
      const target = focusTarget || _sicboQuery('.modal-close-btn', modal);
      if (target && typeof target.focus === 'function') target.focus();
    });
  }

  // options.restoreFocus = false：被 openModal 用來「換窗」時不要還原焦點，
  // 新彈窗自己會 focus 它的目標，中途跳一次焦點只會讓報讀者聽到一段廢話。
  closeModal(modal, options) {
    if (!modal) return;
    const restoreFocus = !(options && options.restoreFocus === false);
    if (modal.classList) modal.classList.remove('open');
    // aria-hidden 立刻生效，不必等離場動畫（AT 不該還讀得到正在淡出的彈窗）
    _sicboSetAttr(modal, 'aria-hidden', 'true');
    if (modal._hideTimer !== null && modal._hideTimer !== undefined) {
      if (typeof clearTimeout === 'function') clearTimeout(modal._hideTimer);
    }
    if (typeof setTimeout === 'function') {
      modal._hideTimer = setTimeout(() => {
        modal._hideTimer = null;
        if (modal.classList && modal.classList.contains('open')) return;   // 期間又被重開
        modal.hidden = true;
      }, MODAL_FADE_MS);
    } else {
      modal.hidden = true;
    }
    // 沒有其他彈窗還開著才解除背景 inert，而且一定要在 focus() 之前 ——
    // 還原焦點的目標多半在 .page-container 內，inert 狀態下 focus() 會靜默失效。
    if (!this.topModal()) this.setBackgroundInert(false);
    // 缺陷 N：還原焦點要有退路。觸發者可能是 <body>（例如破產彈窗是結算時自動開的，
    // 那一刻沒有任何按鈕有焦點）、可能已經被隱藏或停用（翻倍面板裡的按鈕）。
    // 這時候不能就這樣讓焦點留在 body，退回這個彈窗對應的觸發鍵。
    if (restoreFocus) {
      let target = modal._opener;
      if (!this.isFocusable(target)) target = this.modalFallbackFocus(modal);
      if (target && typeof target.focus === 'function') target.focus();
    }
    modal._opener = null;
  }

  // 可聚焦 = 還在文件裡、有 focus()、不是 <body>、沒被停用、而且真的有排版框
  //（hidden / display:none 的元素 focus() 會靜默失效，那比不還原更糟）。
  isFocusable(el) {
    if (!el || typeof el.focus !== 'function') return false;
    if (typeof document !== 'undefined' && el === document.body) return false;
    if (el.isConnected === false) return false;
    if (el.disabled) return false;
    if (el.hidden) return false;
    if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
    return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  }

  // 每個彈窗的「正常觸發鍵」。破產彈窗是自動開的，沒有真正的觸發鍵，
  // 就退回主動作鍵（那顆在 broke 階段寫著「重新開始」，正好是玩家的下一步）。
  modalFallbackFocus(modal) {
    if (modal === this.el.statsModal && this.isFocusable(this.el.statsBtn)) return this.el.statsBtn;
    if (modal === this.el.helpModal && this.isFocusable(this.el.helpBtn)) return this.el.helpBtn;
    if (this.isFocusable(this.el.rollBtn)) return this.el.rollBtn;
    return null;
  }

  topModal() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const open = document.querySelectorAll('.modal-overlay.open');
    if (!open || !open.length) return null;
    return open[open.length - 1];   // DOM 順序的最後一個就是最上層
  }

  // 彈窗開著時把背景對鍵盤與輔助科技一起關掉，讓 focus trap 不是唯一防線。
  setBackgroundInert(on) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const supported = typeof HTMLElement !== 'undefined'
      && HTMLElement.prototype
      && 'inert' in HTMLElement.prototype;
    const targets = document.querySelectorAll('.page-container');
    if (!targets || !targets.forEach) return;
    targets.forEach((el) => {
      if (!el) return;
      if (supported) el.inert = !!on;
      if (on) _sicboSetAttr(el, 'aria-hidden', 'true');
      else if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-hidden');
    });
  }

  focusableIn(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    const nodes = Array.prototype.slice.call(container.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
    ));
    return nodes.filter((el) => {
      if (!el || el.hidden) return false;
      if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
      return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    });
  }

  // focus trap：只比對 first / last 不夠 —— 點到彈窗內的純文字時焦點會掉到 <body>，
  // 那時 active 既不是 first 也不是 last，兩個分支都不成立就會讓 Tab 溜到背景。
  trapFocus(event, modal) {
    const focusable = this.focusableIn(modal);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = (typeof document !== 'undefined') ? document.activeElement : null;
    const inside = !!(active && typeof modal.contains === 'function' && modal.contains(active));
    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ==========================================================================
  // 4.16 鍵盤（契約 §6.8）
  // ==========================================================================
  handleKeyDown(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    const tag = (target && target.tagName) ? String(target.tagName).toUpperCase() : '';
    // 本頁沒有輸入框，但守衛還是要寫：日後多一個 <input> 就會吃掉玩家打的字。
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && target.isContentEditable) return;

    const key = event.key;
    const isSpace = key === ' ' || key === 'Spacebar' || event.code === 'Space';

    const modal = this.topModal();
    if (modal) {
      if (key === 'Escape') {
        event.preventDefault();
        this.closeModal(modal);
        return;
      }
      if (key === 'Tab') this.trapFocus(event, modal);
      return;   // 有彈窗開著時吃掉所有遊戲鍵
    }
    if (key === 'Escape') return;

    // 缺陷 A（五個面向獨立找到同一個，最高優先）：
    // 舊版對 tag === 'BUTTON' || tag === 'A' 直接 return，理由是「原生 click 會處理」。
    // 這對 PLAY 鍵是對的，但 .bet-cell 本身就是 <button>，而 Chrome / Edge 在滑鼠點
    // <button> 之後會把焦點留在該鈕上 —— 於是玩家點完「大」再按 Space（玩法彈窗與
    // PLAY 的 title 都寫著 Space＝開骰）觸發的是注格的原生 click：
    // 實測餘額 1000→990→980→970，本局押注一路加到 30，phase 全程停在 betting，
    // 骰子從沒轉過，也沒有任何提示說「你又押了一注」。
    //
    // 修法是把兩顆鍵的責任分開：
    //   Space = 主動作鍵（開骰 / 跳過 / 下一局），不管焦點在哪裡都是這個意思。
    //           只有焦點就在主動作鍵（或破產彈窗關掉後的重新開始鍵）上時才讓路，
    //           那兩顆的原生啟動本來就等同 onPrimaryAction，攔下來會執行兩次。
    //   Enter = 啟動目前焦點的元素。鍵盤玩家要靠它在注格上下注，所以焦點在
    //           任何按鈕／連結上時一律交還原生啟動；焦點不在可啟動元素上
    //          （例如剛載入、焦點在 body）才當成主動作鍵。
    // index.html 的玩法彈窗快捷鍵表已同步改成這個說法。
    if (isSpace) {
      if (target === this.el.rollBtn || target === this.el.restartBtn) return;
      event.preventDefault();   // 同時擋掉「Space 捲動頁面」與注格的原生啟動
      this.onPrimaryAction();
      return;
    }
    if (key === 'Enter') {
      if (tag === 'BUTTON' || tag === 'A') return;
      event.preventDefault();
      this.onPrimaryAction();
      return;
    }

    if (key === 'r' || key === 'R') {
      this.rebet();
      return;
    }
    if (key === 'c' || key === 'C') {
      this.clearBets();
      return;
    }
    const chipIndex = ['1', '2', '3', '4'].indexOf(key);
    if (chipIndex !== -1 && chipIndex < _sicboCore.CHIPS.length) {
      this.selectChip(_sicboCore.CHIPS[chipIndex]);
    }
  }

  // ==========================================================================
  // 4.17 Toast
  // ==========================================================================
  // 缺陷 H：舊版每呼叫一次就無條件新增一條，既不去重也沒有上限。
  // 實測（390×844）餘額 0、籌碼選 500 時連點 8 個注格 → 8 條一模一樣的
  // 「餘額不足，換小一點的籌碼吧」同時掛在畫面上，toast 容器底緣壓到 y=404，
  // 與 sticky 舞台重疊 221px，骰子、結果訊息、餘額、本局押注全被蓋掉。
  // 一局同時解鎖 5 個里程碑也會噴 5 條，正好蓋住剛中獎的金色格子。
  // 修法：同文字去重（重置既有那條的計時器 + 加計數徽章），同時最多 TOAST_MAX 條。
  showToast(message) {
    if (!this.el || !this.el.toastContainer || typeof document === 'undefined') return;
    const text = String(message);

    const existing = this.toasts.filter(item => item.text === text)[0];
    if (existing) {
      existing.count += 1;
      this.paintToast(existing);
      this.scheduleToastExit(existing);
      return;
    }

    const node = document.createElement('div');
    node.className = 'toast-msg';
    const item = { node: node, text: text, count: 1, timer: null, fadeTimer: null };
    this.paintToast(item);   // 一律 textContent，不拼 HTML
    this.el.toastContainer.appendChild(node);
    this.toasts.push(item);
    // 超出上限就先請最舊的離場（立刻移除，不再等淡出：那條已經被讀過了）
    while (this.toasts.length > TOAST_MAX) this.removeToast(this.toasts[0], true);
    this.scheduleToastExit(item);
  }

  paintToast(item) {
    // 計數徽章用全角空白 + ×N 直接寫在同一個文字節點裡：不需要任何新的 CSS class，
    // 也就不會出現「JS 畫了一個沒人排版的節點」那種跨檔案漏接。
    _sicboSetText(item.node, item.count > 1 ? item.text + '　×' + item.count : item.text);
  }

  clearToastTimers(item) {
    if (typeof clearTimeout !== 'function') return;
    if (item.timer !== null) clearTimeout(item.timer);
    if (item.fadeTimer !== null) clearTimeout(item.fadeTimer);
    item.timer = null;
    item.fadeTimer = null;
  }

  scheduleToastExit(item) {
    if (typeof setTimeout !== 'function') return;
    this.clearToastTimers(item);   // 去重時重新計時：同一件事又發生了，停留時間就重新算
    item.timer = setTimeout(() => {
      item.timer = null;
      if (item.node.style) {
        item.node.style.opacity = '0';
        item.node.style.transition = 'opacity ' + TOAST_FADE_MS + 'ms ease';
      }
      item.fadeTimer = setTimeout(() => {
        item.fadeTimer = null;
        this.removeToast(item, true);
      }, TOAST_FADE_MS);
    }, TOAST_MS);
  }

  removeToast(item, immediate) {
    if (!item) return;
    const idx = this.toasts.indexOf(item);
    if (idx !== -1) this.toasts.splice(idx, 1);
    this.clearToastTimers(item);
    if (immediate && typeof item.node.remove === 'function') item.node.remove();
  }

  // ==========================================================================
  // 4.18 主題與音效按鈕
  // ==========================================================================
  setupTheme() {
    // 共用模組必須可缺席（測試環境沒有任何全域），但缺席時只套用、不持久化：
    // 主題偏好的唯一寫入者是 BoboTheme（它會 merge 進 bobo-home-preferences-v2，
    // 自己另寫一份會清掉使用者在首頁排的順序與隱藏設定）。
    const kit = (typeof BoboTheme !== 'undefined' && BoboTheme) ? BoboTheme : null;
    let theme = 'light';
    if (kit) {
      theme = kit.init();   // 套用 + 同步 meta theme-color + 監聽系統主題變化
    } else {
      const root = document.documentElement;
      const current = (root && typeof root.getAttribute === 'function') ? root.getAttribute('data-theme') : null;
      theme = current === 'dark' ? 'dark' : 'light';
    }
    this.updateThemeIcon(theme);

    if (!this.el.themeBtn) return;
    this.el.themeBtn.addEventListener('click', () => {
      let next;
      if (kit) {
        next = kit.toggle();
      } else {
        next = this.currentTheme() === 'dark' ? 'light' : 'dark';
        this.applyThemeFallback(next);
      }
      this.updateThemeIcon(next);
    });
  }

  currentTheme() {
    const root = document.documentElement;
    const value = (root && typeof root.getAttribute === 'function') ? root.getAttribute('data-theme') : null;
    return value === 'dark' ? 'dark' : 'light';
  }

  applyThemeFallback(theme) {
    const root = document.documentElement;
    if (!root) return;
    if (root.dataset) root.dataset.theme = theme;
    else _sicboSetAttr(root, 'data-theme', theme);
    const meta = _sicboQuery('meta[name="theme-color"]');
    if (!meta || typeof meta.getAttribute !== 'function') return;
    const color = meta.getAttribute(theme === 'dark' ? 'data-theme-color-dark' : 'data-theme-color-light');
    if (color) _sicboSetAttr(meta, 'content', color);
  }

  // 深色 = 太陽圖示（點了會變淺色）+ aria-pressed="true"，與全站一致。
  updateThemeIcon(theme) {
    const btn = this.el.themeBtn;
    if (!btn) return;
    const dark = theme === 'dark';
    btn.innerHTML = dark
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
    _sicboSetAttr(btn, 'aria-pressed', dark ? 'true' : 'false');
    _sicboSetAttr(btn, 'title', dark ? '切換為淺色模式' : '切換為深色模式');
    _sicboSetAttr(btn, 'aria-label', dark ? '切換為淺色模式' : '切換為深色模式');
  }

  setupSoundButton() {
    this.updateSoundIcon();
    if (!this.el.soundBtn) return;
    this.el.soundBtn.addEventListener('click', () => {
      const on = this.audio.toggle();
      this.updateSoundIcon();
      // 開關本身由 BoboAudio 寫進 sicbo_pref_v1.sound（read-modify-write），
      // 這裡不必也不該再寫一次，否則兩個寫入者會互相蓋掉。
      this.showToast(on ? '🔊 音效已開啟' : '🔇 音效已靜音');
    });
  }

  updateSoundIcon() {
    const btn = this.el.soundBtn;
    if (!btn) return;
    const on = !!(this.audio && this.audio.enabled);
    const icon = _sicboQuery('span', btn);
    if (icon) _sicboSetText(icon, on ? '🔊' : '🔇');
    else _sicboSetText(btn, on ? '🔊' : '🔇');
    _sicboSetAttr(btn, 'aria-pressed', on ? 'true' : 'false');
    _sicboSetAttr(btn, 'title', on ? '關閉音效' : '開啟音效');
    _sicboSetAttr(btn, 'aria-label', on ? '關閉音效' : '開啟音效');
  }

  // ==========================================================================
  // 4.19 持久化（契約 §6.9）
  //      讀檔一律經過核心的 normalizeSave / normalizePrefs：被手改過、
  //      跨版本殘留、含未知 bet id 的存檔都會被靜靜修正成合法值而不是拋錯。
  // ==========================================================================
  loadGame() {
    const save = _sicboCore.normalizeSave(_sicboReadJson(_sicboCore.SAVE_KEY));
    this.balance = save.balance;
    this.streak = save.streak;
    this.lastBets = save.lastBets;
    this.rounds = save.history;
    this.stats = save.stats;
    this.milestoneIds = save.milestones;
    // 桌上的注刻意不還原：saveGame() 已經把桌上的籌碼算回餘額裡（見那邊的註解），
    // 所以重新整理後桌面是空的、錢一分不少，而不是兩邊各記一份而對不起來。
    // lastBets 有存，所以「同上局」在重新整理後照樣能用。
  }

  // 存檔刻意不記「桌上的注」與「待決的翻倍彩池」，所以寫入的餘額一律把兩者都算回去。
  // 這條規則讓「任何時刻存檔都是金額正確的」成為不變量：重新整理後桌面是空的、
  // 沒有進行中的挑戰，錢一分不少。若只寫 this.balance，結算後自動重下的那筆本金
  // 會在重新整理時人間蒸發；而翻倍挑戰的彩池（缺陷 G）更嚴重 ——
  // startGamble 已經把它從 balance 扣走，只寫 this.balance 等於把整個彩池記成輸掉。
  saveGame() {
    const pendingPot = this.gambleStaked ? this.gambleAmount : 0;
    _sicboWriteJson(_sicboCore.SAVE_KEY, {
      v: _sicboCore.SAVE_VERSION,
      balance: this.balance + this.totalBet() + pendingPot,
      streak: this.streak,
      lastBets: this.lastBets,
      history: this.rounds,
      stats: this.stats,
      milestones: this.milestoneIds
    });
  }

  loadPrefs() {
    const prefs = _sicboCore.normalizePrefs(_sicboReadJson(_sicboCore.PREF_KEY));
    this.chip = prefs.chip;
    this.keepBets = prefs.keepBets;
    // prefs.sound 刻意不套用到 this.audio：BoboAudio 自己就是讀同一個 key 的
    // 同一個欄位，這裡再寫一次會觸發它的持久化副作用（setEnabled 值沒變也會寫）。
  }

  // 偏好一律 read-modify-write：整包覆寫會把 BoboAudio 寫在同一個 key 裡的
  // sound 欄位清掉（那是它的單一真相，我們只負責轉送它的即時值）。
  savePrefs() {
    const raw = _sicboReadJson(_sicboCore.PREF_KEY);
    const merged = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    merged.chip = this.chip;
    merged.keepBets = this.keepBets;
    merged.sound = !!(this.audio && this.audio.enabled);
    _sicboWriteJson(_sicboCore.PREF_KEY, merged);
  }

  // ==========================================================================
  // 4.20 收尾
  // ==========================================================================
  destroy() {
    this.clearTimers();
    this.clearCleanupTimers();
    this.cancelBalanceTween();
    this.toasts.slice().forEach(item => this.removeToast(item, true));
    if (this.stageObserver && typeof this.stageObserver.disconnect === 'function') {
      try { this.stageObserver.disconnect(); } catch (_) {}
      this.stageObserver = null;
    }
    if (this.onStageResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', this.onStageResize);
      this.onStageResize = null;
    }
    if (typeof this.confettiStop === 'function') {
      try { this.confettiStop(); } catch (_) {}
      this.confettiStop = null;
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('keydown', this.onKeyDown);
    }
  }
}

// ----------------------------------------------------------------------------
// 5. 啟動。typeof document 守衛是必要的：tests/games.test.js 用 new Function(source)
//    編譯本檔，那個環境沒有 document，不守衛會在編譯後立刻爆。
// ----------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const game = new SicBoGame();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => game.init(), { once: true });
  } else {
    game.init();
  }
}
