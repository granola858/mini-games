/* ==========================================================================
   Loop 電流接接樂 (Loop Circuit) 核心遊戲邏輯
   ========================================================================== */

const STORAGE_KEY = 'loop_game_state';
const STATS_KEY = 'loop_game_stats';

/* 星等規則（純函式，測試直接 require 這支檔案驗證）：
   步數 ≤ 標準最少步數 → 3 星；≤ 1.5 倍 → 2 星；其他 1 星。
   提示會直接幫玩家轉好一格，所以用過提示要扣星：用過 1 次最高 2 星，3 次以上最高 1 星。 */
function evaluateLoopStars(moves, par, hintsUsed = 0) {
  const safePar = Math.max(1, par || 1);
  let stars = 1;
  if (moves <= safePar) stars = 3;
  else if (moves <= Math.ceil(safePar * 1.5)) stars = 2;
  if (hintsUsed >= 3) stars = Math.min(stars, 1);
  else if (hintsUsed >= 1) stars = Math.min(stars, 2);
  return stars;
}

/* 減少動態效果：使用者在系統開啟時，JS 端也不做位移動畫 */
function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {
    return false;
  }
}

/* 導線開口方向：給螢幕閱讀器描述每一格 */
const LOOP_DIR_NAMES = [[1, '上'], [2, '右'], [4, '下'], [8, '左']];
function describeMask(mask) {
  const dirs = LOOP_DIR_NAMES.filter(([bit]) => mask & bit).map(([, name]) => name);
  return dirs.length ? `開口朝${dirs.join('、')}` : '沒有導線';
}

/* 音效：薄薄一層音色定義，底下的 AudioContext 樣板一律交給共用模組 BoboAudio。
   共用模組必須可缺席：載入失敗時遊戲照常玩，只是完全沒有音效。 */
class SoundManager {
  constructor() {
    this.kit = (typeof BoboAudio !== 'undefined' && BoboAudio)
      ? BoboAudio.create({ storageKey: 'loopnet_sound' })
      : null;
  }

  /* 目前是否發聲；模組缺席時恆為 false，UI 會顯示靜音圖示 */
  get enabled() {
    return this.kit ? this.kit.enabled : false;
  }

  /* 切換音效並寫回 loopnet_sound，回傳切換後的狀態 */
  toggleSound() {
    return this.kit ? this.kit.toggle() : false;
  }

  /* 旋轉開關點擊音效 (Relay Switch Click) */
  playRotate() {
    if (!this.kit) return;
    this.kit.sweep({
      from: 520, to: 180, type: 'triangle', duration: 0.04, gain: 0.22, floor: 0.001
    });
  }

  /* 電流導通音效 (Electric Zap / Flow) */
  playFlow() {
    if (!this.kit) return;
    this.kit.chord([587.33, 739.99, 880.00], {
      type: 'sawtooth', duration: 0.12, gain: 0.05, stagger: 0.02, floor: 0.001
    });
  }

  /* 燈泡點亮叮噹音效 (Bulb Light-Up Chime) */
  playBulbLight() {
    if (!this.kit) return;
    this.kit.chord([659.25, 987.77, 1318.51], {
      type: 'sine', duration: 0.25, gain: 0.12, stagger: 0.035, floor: 0.001
    });
  }

  /* 提示音效 (Hint Chime) */
  playHint() {
    if (!this.kit) return;
    this.kit.chord([659.25, 880, 1174.66], {
      type: 'sine', duration: 0.22, gain: 0.12, stagger: 0.05, floor: 0.001
    });
  }

  /* 勝利電力全開和弦 (Power Victory Fanfare) */
  playWin() {
    if (!this.kit) return;
    this.kit.chord([523.25, 659.25, 783.99, 1046.50, 1318.51, 1567.98], {
      type: 'triangle', duration: 0.45, gain: 0.2, stagger: 0.07, floor: 0.001
    });
  }
}

class LoopNetGame {
  constructor() {
    // 4 個方向的二進位 Bitmask: UP=1, RIGHT=2, DOWN=4, LEFT=8
    this.DIR = {
      UP: 1,
      RIGHT: 2,
      DOWN: 4,
      LEFT: 8
    };

    this.gridSize = 5; // 預設 5x5
    this.gameStates = {}; // 各難度尺寸的獨立進度快取 (5, 6, 7, 8)
    this.grid = [];     // 儲存每個格子的狀態
    this.sourcePos = { r: 0, c: 0 };
    this.moves = 0;
    this.parMoves = 0;  // 理論最佳最少旋轉步數
    this.isWon = false;
    this.hintsUsed = 0;
    this.focusIndex = 0; // 鍵盤焦點所在格（roving tabindex）
    this.lastPoweredCount = 0;
    this.lastPoweredBulbCount = 0;
    this.confettiStop = null; // BoboConfetti.burst() 回傳的收尾函式

    // 音效管理器
    this.sound = new SoundManager();

    // 計時器
    this.timerSeconds = 0;
    this.timerInterval = null;

    // DOM 緩存
    this.dom = {
      soundBtn: document.getElementById('sound-btn'),
      themeBtn: document.getElementById('theme-btn'),
      tabs: document.querySelectorAll('.tab-btn'),
      timerText: document.getElementById('timer-text'),
      movesText: document.getElementById('moves-text'),
      progressText: document.getElementById('progress-text'),
      gridBoard: document.getElementById('grid-board'),
      btnRestart: document.getElementById('btn-restart'),
      btnHint: document.getElementById('btn-hint'),
      btnNewGame: document.getElementById('btn-new-game'),
      winDialog: document.getElementById('win-dialog'),
      modalTitle: document.getElementById('modal-title'),
      modalBody: document.getElementById('modal-body'),
      modalCloseBtn: document.getElementById('modal-close-btn'),
      modalViewBtn: document.getElementById('modal-view-btn'),
      rulesBtn: document.getElementById('rules-btn'),
      rulesDialog: document.getElementById('rules-dialog'),
      rulesCloseBtn: document.getElementById('rules-close-btn'),
      hintCount: document.getElementById('hint-count'),
      statusMsg: document.getElementById('status-msg'),
      confettiCanvas: document.getElementById('confetti-canvas')
    };

    this.init();
  }

  init() {
    this.setupTheme();
    this.setupSoundUI();
    this.bindEvents();
    if (!this.loadGameState()) {
      this.startNewGame();
    }
  }

  /* ------------------------------------------------------------------------
     主題與設定 (相容首頁 bobo-home-preferences-v2)
     ------------------------------------------------------------------------ */
  /* 讀取本遊戲自己的舊偏好 key；沒有或值不合法時回 null */
  readLocalTheme() {
    try {
      const stored = localStorage.getItem('loopnet_theme');
      if (stored === 'dark' || stored === 'light') return stored;
    } catch (_) {}
    return null;
  }

  setupTheme() {
    // 共用主題模組必須可缺席：載入失敗時退回 loopnet_theme 與 prefers-color-scheme
    const themeKit = (typeof BoboTheme !== 'undefined') ? BoboTheme : null;
    const localTheme = this.readLocalTheme();
    let savedTheme;

    if (themeKit) {
      if (themeKit.hasExplicitPreference() || !localTheme) {
        // 首頁已存過主題、或本遊戲沒有舊偏好：交給共用模組決定並跟隨系統主題變化
        savedTheme = themeKit.init();
      } else {
        // 只有舊版 loopnet_theme 的使用者：沿用它，不讓系統主題蓋掉
        savedTheme = themeKit.apply(localTheme);
      }
    } else {
      savedTheme = localTheme
        || ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', savedTheme);
    }

    this.updateThemeIcon(savedTheme);

    this.dom.themeBtn.addEventListener('click', () => {
      let next;
      if (themeKit) {
        // toggle() 會套用主題，並且「只改」bobo-home-preferences-v2 的 theme 欄位
        next = themeKit.toggle();
      } else {
        const current = document.documentElement.getAttribute('data-theme');
        next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
      }
      // 保留本遊戲自己的偏好 key
      try {
        localStorage.setItem('loopnet_theme', next);
      } catch (_) {}
      this.updateThemeIcon(next);
    });
  }

  updateThemeIcon(theme) {
    this.dom.themeBtn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    this.dom.themeBtn.innerHTML = theme === 'dark'
      ? '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
  }

  setupSoundUI() {
    this.updateSoundIcon(this.sound.enabled);
    this.dom.soundBtn.addEventListener('click', () => {
      const isEnabled = this.sound.toggleSound();
      this.updateSoundIcon(isEnabled);
    });
  }

  updateSoundIcon(enabled) {
    this.dom.soundBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    this.dom.soundBtn.innerHTML = enabled
      ? '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
      : '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  }

  bindEvents() {
    // Tab 難度切換
    this.dom.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const size = parseInt(tab.dataset.size, 10);
        this.switchGridSize(size);
      });
    });

    this.dom.btnRestart.addEventListener('click', () => this.restartCurrentBoard());
    this.dom.btnHint.addEventListener('click', () => this.applyHint());
    this.dom.btnNewGame.addEventListener('click', () => {
      this.clearGameState(this.gridSize);
      this.startNewGame();
    });
    this.dom.modalCloseBtn.addEventListener('click', () => {
      this.closeDialog(this.dom.winDialog);
      this.clearGameState(this.gridSize);
      this.startNewGame();
      this.focusBoard();
    });
    // 「看盤面」只關掉結果，留在已完成的盤面上欣賞
    this.dom.modalViewBtn.addEventListener('click', () => {
      this.closeDialog(this.dom.winDialog);
      this.dom.btnNewGame.focus();
    });
    this.dom.winDialog.addEventListener('close', () => this.stopConfetti());

    this.dom.rulesBtn.addEventListener('click', () => this.openDialog(this.dom.rulesDialog));
    this.dom.rulesCloseBtn.addEventListener('click', () => this.closeDialog(this.dom.rulesDialog));

    // 點 dialog 外的遮罩也能關閉（點擊目標是 dialog 本身時才算遮罩）
    [this.dom.winDialog, this.dom.rulesDialog].forEach((dialog) => {
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) this.closeDialog(dialog);
      });
    });

    // 棋盤鍵盤操作：方向鍵移動、Enter／空白鍵旋轉
    this.dom.gridBoard.addEventListener('keydown', (e) => this.handleBoardKey(e));

    // 頁面卸載/切換時保存進度
    const persistProgress = () => {
      if (!this.isWon) this.saveGameState(this.gridSize);
    };
    window.addEventListener('beforeunload', persistProgress);
    window.addEventListener('pagehide', persistProgress);
  }

  switchGridSize(size) {
    if (this.gridSize === size) return;

    // 1. 若當前盤面尚未通關，先保存當前尺寸的進度
    if (!this.isWon) {
      this.saveGameState(this.gridSize);
    }
    this.stopTimer();

    // 2. 切換尺寸與 Tab UI
    this.gridSize = size;
    this.syncSizeButtons();

    // 3. 嘗試載入目標尺寸既有的未完成進度
    const restored = this.loadGameStateForSize(size);
    if (!restored) {
      this.startNewGame();
    } else {
      // 確保 storage 中儲存最新 active currentSize
      this.saveGameState(size);
    }
  }

  countBits(mask) {
    let count = 0;
    if (mask & this.DIR.UP) count++;
    if (mask & this.DIR.RIGHT) count++;
    if (mask & this.DIR.DOWN) count++;
    if (mask & this.DIR.LEFT) count++;
    return count;
  }

  /* 計算當前遮罩順時針轉到目標遮罩所需的最少點擊次數 (0~3 次) */
  getMinClicksToSolve(currentMask, targetMask) {
    let temp = currentMask;
    for (let clicks = 0; clicks < 4; clicks++) {
      if (temp === targetMask) return clicks;
      temp = this.rotateMask(temp);
    }
    return 0;
  }

  /* ------------------------------------------------------------------------
     關卡生成演算法 (Randomized Spanning Tree + Cycle Injection 閉合迴路電網)
     ------------------------------------------------------------------------ */
  generateBoard() {
    const R = this.gridSize;
    const C = this.gridSize;

    // 1. 初始化空網格
    const rawGrid = Array.from({ length: R }, () => Array(C).fill(0));
    const visited = Array.from({ length: R }, () => Array(C).fill(false));

    // 2. 隨機 DFS 生成基礎生成樹骨架 (確保全圖必能唯一完全連通無孤島)
    const startR = Math.floor(Math.random() * R);
    const startC = Math.floor(Math.random() * C);
    const stack = [[startR, startC]];
    visited[startR][startC] = true;

    const DIRS = [
      { dr: -1, dc: 0, bit: this.DIR.UP, opp: this.DIR.DOWN },
      { dr: 0, dc: 1, bit: this.DIR.RIGHT, opp: this.DIR.LEFT },
      { dr: 1, dc: 0, bit: this.DIR.DOWN, opp: this.DIR.UP },
      { dr: 0, dc: -1, bit: this.DIR.LEFT, opp: this.DIR.RIGHT }
    ];

    while (stack.length > 0) {
      const [r, c] = stack[stack.length - 1];
      const unvisitedNeighbors = [];

      for (const d of DIRS) {
        const nr = r + d.dr;
        const nc = c + d.dc;
        if (nr >= 0 && nr < R && nc >= 0 && nc < C && !visited[nr][nc]) {
          unvisitedNeighbors.push({ r: nr, c: nc, dir: d });
        }
      }

      if (unvisitedNeighbors.length > 0) {
        const chosen = unvisitedNeighbors[Math.floor(Math.random() * unvisitedNeighbors.length)];
        rawGrid[r][c] |= chosen.dir.bit;
        rawGrid[chosen.r][chosen.c] |= chosen.dir.opp;
        visited[chosen.r][chosen.c] = true;
        stack.push([chosen.r, chosen.c]);
      } else {
        stack.pop();
      }
    }

    // 3. 注入閉合環路（Cycle Injection）：優先在內部骨幹導線之間建立閉合網眼，打破樹狀結構並保留終端燈泡
    const internalEdges = [];
    const otherEdges = [];

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        // 檢查右方相鄰是否未連通
        if (c < C - 1 && !(rawGrid[r][c] & this.DIR.RIGHT)) {
          const edge = { r1: r, c1: c, r2: r, c2: c + 1, bit1: this.DIR.RIGHT, bit2: this.DIR.LEFT };
          if (this.countBits(rawGrid[r][c]) >= 2 && this.countBits(rawGrid[r][c + 1]) >= 2) {
            internalEdges.push(edge);
          } else {
            otherEdges.push(edge);
          }
        }
        // 檢查下方相鄰是否未連通
        if (r < R - 1 && !(rawGrid[r][c] & this.DIR.DOWN)) {
          const edge = { r1: r, c1: c, r2: r + 1, c2: c, bit1: this.DIR.DOWN, bit2: this.DIR.UP };
          if (this.countBits(rawGrid[r][c]) >= 2 && this.countBits(rawGrid[r + 1][c]) >= 2) {
            internalEdges.push(edge);
          } else {
            otherEdges.push(edge);
          }
        }
      }
    }

    // 依據盤面大小計算注入的環路數量
    let cycleCount = 0;
    if (R === 5) cycleCount = 2 + Math.floor(Math.random() * 2); // 2~3 條
    else if (R === 6) cycleCount = 4 + Math.floor(Math.random() * 3); // 4~6 條
    else if (R === 7) cycleCount = 7 + Math.floor(Math.random() * 4); // 7~10 條
    else if (R >= 8) cycleCount = 10 + Math.floor(Math.random() * 6); // 10~15 條

    // 優先注入內部閉合邊
    const edgePool = internalEdges.length >= cycleCount ? internalEdges : [...internalEdges, ...otherEdges];
    for (let i = 0; i < cycleCount && edgePool.length > 0; i++) {
      const idx = Math.floor(Math.random() * edgePool.length);
      const edge = edgePool.splice(idx, 1)[0];
      rawGrid[edge.r1][edge.c1] |= edge.bit1;
      rawGrid[edge.r2][edge.c2] |= edge.bit2;
    }

    // 4. 設定中心為電池能量核心
    this.sourcePos = { r: Math.floor(R / 2), c: Math.floor(C / 2) };

    // 5. 隨機旋轉洗牌 (所有格子打亂 1~3 次 90 度)
    this.grid = [];
    let totalParMoves = 0;

    for (let r = 0; r < R; r++) {
      this.grid[r] = [];
      for (let c = 0; c < C; c++) {
        const targetMask = rawGrid[r][c];
        const isSource = (r === this.sourcePos.r && c === this.sourcePos.c);
        const isEndpoint = (!isSource && this.countBits(targetMask) === 1);

        const rotCount = Math.floor(Math.random() * 3) + 1;
        let currentMask = targetMask;
        for (let i = 0; i < rotCount; i++) {
          currentMask = this.rotateMask(currentMask);
        }

        totalParMoves += this.getMinClicksToSolve(currentMask, targetMask);

        this.grid[r][c] = {
          targetMask,
          currentMask,
          rotationDeg: rotCount * 90,
          initialDeg: rotCount * 90,
          isPowered: false,
          isSource,
          isEndpoint
        };
      }
    }

    this.parMoves = Math.max(1, totalParMoves);
  }

  /* ------------------------------------------------------------------------
     幾何旋轉與位元計算
     ------------------------------------------------------------------------ */
  rotateMask(mask) {
    let newMask = 0;
    if (mask & this.DIR.UP) newMask |= this.DIR.RIGHT;
    if (mask & this.DIR.RIGHT) newMask |= this.DIR.DOWN;
    if (mask & this.DIR.DOWN) newMask |= this.DIR.LEFT;
    if (mask & this.DIR.LEFT) newMask |= this.DIR.UP;
    return newMask;
  }

  /* ------------------------------------------------------------------------
     遊戲流程與狀態控制
     ------------------------------------------------------------------------ */
  startNewGame() {
    this.stopConfetti();
    this.isWon = false;
    this.moves = 0;
    this.hintsUsed = 0;
    this.updateHintCount();
    this.lastPoweredCount = 0;
    this.lastPoweredBulbCount = 0;
    this.dom.movesText.textContent = '0';
    this.dom.gridBoard.classList.remove('is-won');

    this.stopTimer();
    this.timerSeconds = 0;
    this.dom.timerText.textContent = '00:00';

    this.generateBoard();
    this.renderBoard();
    this.updatePowerFlow(false);
    this.startTimer();
    this.saveGameState();
  }

  restartCurrentBoard() {
    if (this.isWon) return;
    const R = this.gridSize;
    const C = this.gridSize;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const cell = this.grid[r][c];
        cell.rotationDeg = cell.initialDeg;
        let mask = cell.targetMask;
        const rots = ((cell.initialDeg / 90) % 4 + 4) % 4;
        for (let i = 0; i < rots; i++) mask = this.rotateMask(mask);
        cell.currentMask = mask;
      }
    }
    this.moves = 0;
    this.lastPoweredCount = 0;
    this.lastPoweredBulbCount = 0;
    this.dom.movesText.textContent = '0';
    this.announce('已重置這一局');
    this.renderBoard();
    this.updatePowerFlow(false);
    this.saveGameState();
  }

  startTimer() {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      const mins = Math.floor(this.timerSeconds / 60).toString().padStart(2, '0');
      const secs = (this.timerSeconds % 60).toString().padStart(2, '0');
      this.dom.timerText.textContent = `${mins}:${secs}`;
      if (this.timerSeconds % 5 === 0 && !this.isWon) {
        this.saveGameState();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /* ------------------------------------------------------------------------
     進度與統計持久化 (localStorage - 支援各棋盤規格獨立存檔)
     ------------------------------------------------------------------------ */
  saveGameState(size = this.gridSize) {
    if (this.isWon && size === this.gridSize) return;
    try {
      if (size === this.gridSize && this.grid && this.grid.length === size) {
        this.gameStates[size] = {
          gridSize: this.gridSize,
          grid: this.grid,
          sourcePos: this.sourcePos,
          moves: this.moves,
          hintsUsed: this.hintsUsed,
          parMoves: this.parMoves,
          timerSeconds: this.timerSeconds,
          timestamp: Date.now()
        };
      }
      const payload = {
        currentSize: this.gridSize,
        states: this.gameStates
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  loadGameState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      let data = JSON.parse(raw);
      if (!data) return false;

      // 向下相容舊版單一盤面存檔格式
      if (!data.states && data.gridSize && Array.isArray(data.grid)) {
        const oldSize = data.gridSize;
        data = {
          currentSize: oldSize,
          states: {
            [oldSize]: data
          }
        };
      }

      this.gameStates = data.states || {};
      const targetSize = data.currentSize && [5, 6, 7, 8].includes(Number(data.currentSize)) ? Number(data.currentSize) : 5;
      this.gridSize = targetSize;

      // 更新 Tab UI
      this.syncSizeButtons();

      return this.loadGameStateForSize(targetSize);
    } catch (e) {
      console.warn('載入 Loop 進度失敗:', e);
      return false;
    }
  }

  loadGameStateForSize(size) {
    const state = this.gameStates && this.gameStates[size];
    if (!state || !state.grid || !Array.isArray(state.grid) || state.grid.length !== size) {
      return false;
    }

    this.gridSize = size;
    this.grid = state.grid;
    this.sourcePos = state.sourcePos || { r: Math.floor(size / 2), c: Math.floor(size / 2) };
    this.moves = state.moves || 0;
    this.hintsUsed = state.hintsUsed || 0;
    this.updateHintCount();
    this.timerSeconds = state.timerSeconds || 0;
    
    // 若存檔無 parMoves 則根據當前盤面重新計算
    if (typeof state.parMoves === 'number' && state.parMoves > 0) {
      this.parMoves = state.parMoves;
    } else {
      let calcPar = 0;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const cell = this.grid[r][c];
          calcPar += this.getMinClicksToSolve(cell.currentMask, cell.targetMask);
        }
      }
      this.parMoves = Math.max(1, calcPar);
    }

    this.isWon = false;
    this.lastPoweredCount = 0;
    this.lastPoweredBulbCount = 0;

    // 更新 Tab UI
    this.syncSizeButtons();

    this.dom.movesText.textContent = this.moves.toString();
    const mins = Math.floor(this.timerSeconds / 60).toString().padStart(2, '0');
    const secs = (this.timerSeconds % 60).toString().padStart(2, '0');
    this.dom.timerText.textContent = `${mins}:${secs}`;
    this.dom.gridBoard.classList.remove('is-won');

    this.renderBoard();
    this.updatePowerFlow(false);
    this.startTimer();
    return true;
  }

  clearGameState(size = this.gridSize) {
    try {
      if (size) {
        delete this.gameStates[size];
      } else {
        this.gameStates = {};
      }
      const payload = {
        currentSize: this.gridSize,
        states: this.gameStates
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  saveStats(size, seconds, moves, stars = 1) {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      const stats = raw ? JSON.parse(raw) : {};
      const key = `${size}x${size}`;
      const cur = stats[key] || { bestTime: null, bestMoves: null, bestStars: 0, clears: 0 };

      cur.clears = (cur.clears || 0) + 1;
      if (cur.bestTime === null || seconds < cur.bestTime) cur.bestTime = seconds;
      if (cur.bestMoves === null || moves < cur.bestMoves) cur.bestMoves = moves;
      if (!cur.bestStars || stars > cur.bestStars) cur.bestStars = stars;

      stats[key] = cur;
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (_) {}
  }

  /* ------------------------------------------------------------------------
     SVG 線條渲染與棋盤繪製 (分層架構：線路旋轉層 + 頂層固定電池/燈泡層)
     ------------------------------------------------------------------------ */
  renderBoard() {
    const R = this.gridSize;
    const C = this.gridSize;
    // 重繪前記下焦點是否在棋盤裡，重繪後放回同一格，不讓鍵盤焦點掉回 body
    const hadFocus = this.dom.gridBoard.contains(document.activeElement);
    this.focusIndex = Math.min(this.focusIndex, R * C - 1);
    this.dom.gridBoard.style.gridTemplateColumns = `repeat(${C}, 1fr)`;
    this.dom.gridBoard.innerHTML = '';

    for (let r = 0; r < R; r++) {
      // role=row 用 display: contents，不影響原本的 CSS grid 排版
      const row = document.createElement('div');
      row.className = 'grid-row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < C; c++) {
        const cell = this.grid[r][c];
        const tile = document.createElement('div');
        tile.className = `cell-tile ${cell.isSource ? 'is-source' : ''} ${cell.isEndpoint ? 'is-endpoint' : ''}`;
        tile.id = `cell-${r}-${c}`;
        tile.setAttribute('role', 'gridcell');
        tile.tabIndex = (r * C + c) === this.focusIndex ? 0 : -1;
        tile.dataset.index = String(r * C + c);

        // 1. 底層旋轉導線層 (隨點擊旋轉)
        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'pipe-svg-wrapper';
        svgWrapper.style.transform = `rotate(${cell.rotationDeg}deg)`;
        svgWrapper.innerHTML = this.generateWireSVG(cell);
        tile.appendChild(svgWrapper);

        // 2. 頂層固定元件層 (電池與燈泡維持正立不隨導線旋轉)
        if (cell.isSource || cell.isEndpoint) {
          const deviceWrapper = document.createElement('div');
          deviceWrapper.className = 'device-overlay';
          deviceWrapper.innerHTML = this.generateDeviceSVG(cell);
          tile.appendChild(deviceWrapper);
        }

        tile.addEventListener('click', () => {
          this.setFocusIndex(r * C + c, false);
          this.handleCellClick(r, c);
        });
        row.appendChild(tile);
      }
      this.dom.gridBoard.appendChild(row);
    }
    this.updateCellLabels();
    if (hadFocus) this.focusBoard();
  }

  /* 盤面大小按鈕：視覺 active 與 aria-pressed 同步 */
  syncSizeButtons() {
    this.dom.tabs.forEach(tab => {
      const on = parseInt(tab.dataset.size, 10) === this.gridSize;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* 每格的螢幕閱讀器標籤：座標、元件種類、開口方向、是否通電 */
  updateCellLabels() {
    if (!this.grid) return;
    const R = this.gridSize;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < R; c++) {
        const tile = document.getElementById(`cell-${r}-${c}`);
        if (!tile) continue;
        const cell = this.grid[r][c];
        const kind = cell.isSource ? '電池' : (cell.isEndpoint ? '燈泡' : '導線');
        const power = cell.isPowered ? '已通電' : '未通電';
        tile.setAttribute('aria-label', `第 ${r + 1} 列第 ${c + 1} 行，${kind}，${describeMask(cell.currentMask)}，${power}`);
      }
    }
  }

  setFocusIndex(index, moveFocus = true) {
    const tiles = this.dom.gridBoard.querySelectorAll('.cell-tile');
    if (!tiles.length) return;
    const next = Math.max(0, Math.min(index, tiles.length - 1));
    tiles.forEach((tile, i) => { tile.tabIndex = i === next ? 0 : -1; });
    this.focusIndex = next;
    if (moveFocus) tiles[next].focus();
  }

  focusBoard() {
    this.setFocusIndex(this.focusIndex, true);
  }

  handleBoardKey(e) {
    const size = this.gridSize;
    const r = Math.floor(this.focusIndex / size);
    const c = this.focusIndex % size;
    let next = null;
    switch (e.key) {
      case 'ArrowUp': next = r > 0 ? this.focusIndex - size : null; break;
      case 'ArrowDown': next = r < size - 1 ? this.focusIndex + size : null; break;
      case 'ArrowLeft': next = c > 0 ? this.focusIndex - 1 : null; break;
      case 'ArrowRight': next = c < size - 1 ? this.focusIndex + 1 : null; break;
      case 'Home': next = r * size; break;
      case 'End': next = r * size + size - 1; break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.handleCellClick(r, c);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next !== null) this.setFocusIndex(next, true);
  }

  announce(text) {
    if (!this.dom.statusMsg) return;
    // 先清空再寫入，同樣的訊息連續出現也會被重新播報
    this.dom.statusMsg.textContent = '';
    window.setTimeout(() => { this.dom.statusMsg.textContent = text; }, 30);
  }

  updateHintCount() {
    if (this.dom.hintCount) this.dom.hintCount.textContent = String(this.hintsUsed || 0);
    if (this.dom.btnHint) this.dom.btnHint.setAttribute('aria-label', `提示，已用 ${this.hintsUsed || 0} 次`);
  }

  openDialog(dialog) {
    if (!dialog) return;
    this.lastOpener = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    const primary = dialog.querySelector('.btn-action.primary');
    if (primary) primary.focus();
  }

  closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    const opener = this.lastOpener;
    this.lastOpener = null;
    if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
  }

  generateWireSVG(cell) {
    const mask = cell.targetMask;
    let bgLines = '';
    let sparkLines = '';

    if (mask & this.DIR.UP) {
      bgLines += `<line class="wire-line" x1="50" y1="50" x2="50" y2="0"/>`;
      sparkLines += `<line class="wire-spark" x1="50" y1="50" x2="50" y2="0"/>`;
    }
    if (mask & this.DIR.RIGHT) {
      bgLines += `<line class="wire-line" x1="50" y1="50" x2="100" y2="50"/>`;
      sparkLines += `<line class="wire-spark" x1="50" y1="50" x2="100" y2="50"/>`;
    }
    if (mask & this.DIR.DOWN) {
      bgLines += `<line class="wire-line" x1="50" y1="50" x2="50" y2="100"/>`;
      sparkLines += `<line class="wire-spark" x1="50" y1="50" x2="50" y2="100"/>`;
    }
    if (mask & this.DIR.LEFT) {
      bgLines += `<line class="wire-line" x1="50" y1="50" x2="0" y2="50"/>`;
      sparkLines += `<line class="wire-spark" x1="50" y1="50" x2="0" y2="50"/>`;
    }

    let centerStud = '';
    // 一般 2 向、3 向、4 向電路交叉點渲染金屬端子
    if (!cell.isSource && !cell.isEndpoint) {
      centerStud = `
        <circle class="circuit-node" cx="50" cy="50" r="8"/>
        <circle class="circuit-spark-node" cx="50" cy="50" r="4"/>
      `;
    }

    return `
      <svg class="pipe-svg" viewBox="0 0 100 100">
        ${bgLines}
        ${sparkLines}
        ${centerStud}
      </svg>
    `;
  }

  generateDeviceSVG(cell) {
    let content = '';

    if (cell.isSource) {
      // 1. 起點：固定正立電池 (Upright Battery Source)
      content = `
        <g class="battery-source">
          <circle class="battery-glow-ring" cx="50" cy="50" r="22"/>
          <rect class="battery-cap" x="44" y="27" width="12" height="5" rx="1.5"/>
          <rect class="battery-body" x="35" y="31" width="30" height="38" rx="5"/>
          <rect class="battery-charge-bg" x="38" y="34" width="24" height="32" rx="3"/>
          <rect class="battery-charge-level" x="40" y="44" width="20" height="20" rx="2"/>
          <path class="battery-bolt" d="M51 36 L44 48 L49 48 L47 62 L57 46 L51 46 Z"/>
        </g>
      `;
    } else if (cell.isEndpoint) {
      // 2. 終點：固定正立燈泡 (Upright Terminal Lightbulb)
      content = `
        <g class="bulb-terminal">
          <circle class="bulb-glow" cx="50" cy="50" r="22"/>
          <g class="bulb-rays">
            <line class="bulb-ray" x1="50" y1="23" x2="50" y2="16"/>
            <line class="bulb-ray" x1="69" y1="31" x2="74" y2="26"/>
            <line class="bulb-ray" x1="77" y1="50" x2="84" y2="50"/>
            <line class="bulb-ray" x1="69" y1="69" x2="74" y2="74"/>
            <line class="bulb-ray" x1="50" y1="77" x2="50" y2="84"/>
            <line class="bulb-ray" x1="31" y1="69" x2="26" y2="74"/>
            <line class="bulb-ray" x1="23" y1="50" x2="16" y2="50"/>
            <line class="bulb-ray" x1="31" y1="31" x2="26" y2="26"/>
          </g>
          <circle class="bulb-socket" cx="50" cy="50" r="16"/>
          <circle class="bulb-glass" cx="50" cy="50" r="13"/>
          <path class="bulb-filament" d="M44 54 Q50 40 56 54"/>
          <circle class="bulb-center-spark" cx="50" cy="48" r="2.5"/>
        </g>
      `;
    }

    return `
      <svg class="device-svg" viewBox="0 0 100 100">
        ${content}
      </svg>
    `;
  }

  /* ------------------------------------------------------------------------
     點擊旋轉與連通度檢測 (BFS Power Flow)
     ------------------------------------------------------------------------ */
  handleCellClick(r, c) {
    if (this.isWon) return;

    this.sound.playRotate();

    const cell = this.grid[r][c];
    cell.rotationDeg += 90;
    cell.currentMask = this.rotateMask(cell.currentMask);
    this.moves++;
    this.dom.movesText.textContent = this.moves;

    const tile = document.getElementById(`cell-${r}-${c}`);
    if (tile) {
      const wrapper = tile.querySelector('.pipe-svg-wrapper');
      if (wrapper) wrapper.style.transform = `rotate(${cell.rotationDeg}deg)`;
    }

    this.updatePowerFlow(true);
    this.saveGameState();
  }

  updatePowerFlow(playSoundEffect = true) {
    const R = this.gridSize;
    const C = this.gridSize;

    // 1. 重置所有格子通電狀態
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        this.grid[r][c].isPowered = false;
      }
    }

    // 2. 從電池核心開始做 BFS 電流遍歷
    const queue = [[this.sourcePos.r, this.sourcePos.c]];
    this.grid[this.sourcePos.r][this.sourcePos.c].isPowered = true;
    let poweredCount = 0;
    let poweredBulbCount = 0;

    while (queue.length > 0) {
      const [r, c] = queue.shift();
      poweredCount++;
      if (this.grid[r][c].isEndpoint) {
        poweredBulbCount++;
      }

      const curMask = this.grid[r][c].currentMask;

      // UP
      if ((curMask & this.DIR.UP) && r > 0) {
        const nextCell = this.grid[r - 1][c];
        if ((nextCell.currentMask & this.DIR.DOWN) && !nextCell.isPowered) {
          nextCell.isPowered = true;
          queue.push([r - 1, c]);
        }
      }
      // RIGHT
      if ((curMask & this.DIR.RIGHT) && c < C - 1) {
        const nextCell = this.grid[r][c + 1];
        if ((nextCell.currentMask & this.DIR.LEFT) && !nextCell.isPowered) {
          nextCell.isPowered = true;
          queue.push([r, c + 1]);
        }
      }
      // DOWN
      if ((curMask & this.DIR.DOWN) && r < R - 1) {
        const nextCell = this.grid[r + 1][c];
        if ((nextCell.currentMask & this.DIR.UP) && !nextCell.isPowered) {
          nextCell.isPowered = true;
          queue.push([r + 1, c]);
        }
      }
      // LEFT
      if ((curMask & this.DIR.LEFT) && c > 0) {
        const nextCell = this.grid[r][c - 1];
        if ((nextCell.currentMask & this.DIR.RIGHT) && !nextCell.isPowered) {
          nextCell.isPowered = true;
          queue.push([r, c - 1]);
        }
      }
    }

    // 3. 點亮燈泡或導通音效
    if (playSoundEffect) {
      if (poweredBulbCount > this.lastPoweredBulbCount) {
        this.sound.playBulbLight();
      } else if (poweredCount > this.lastPoweredCount && poweredCount > 1) {
        this.sound.playFlow();
      }
    }
    this.lastPoweredCount = poweredCount;
    this.lastPoweredBulbCount = poweredBulbCount;

    // 4. 更新 DOM 通電與燈泡發光樣式
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const tile = document.getElementById(`cell-${r}-${c}`);
        if (tile) {
          tile.classList.toggle('is-powered', this.grid[r][c].isPowered);
        }
      }
    }

    this.updateCellLabels();

    const totalCells = R * C;
    const progressPercent = Math.round((poweredCount / totalCells) * 100);
    this.dom.progressText.textContent = `${progressPercent}%`;

    // 5. 判斷是否過關
    if (poweredCount === totalCells && this.validateNoDanglingEnds()) {
      this.handleWin();
    }
  }

  validateNoDanglingEnds() {
    const R = this.gridSize;
    const C = this.gridSize;

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const mask = this.grid[r][c].currentMask;
        if ((mask & this.DIR.UP) && r === 0) return false;
        if ((mask & this.DIR.RIGHT) && c === C - 1) return false;
        if ((mask & this.DIR.DOWN) && r === R - 1) return false;
        if ((mask & this.DIR.LEFT) && c === 0) return false;

        if ((mask & this.DIR.UP) && !(this.grid[r - 1][c].currentMask & this.DIR.DOWN)) return false;
        if ((mask & this.DIR.RIGHT) && !(this.grid[r][c + 1].currentMask & this.DIR.LEFT)) return false;
        if ((mask & this.DIR.DOWN) && !(this.grid[r + 1][c].currentMask & this.DIR.UP)) return false;
        if ((mask & this.DIR.LEFT) && !(this.grid[r][c - 1].currentMask & this.DIR.RIGHT)) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------------
     提示與校正功能
     ------------------------------------------------------------------------ */
  applyHint() {
    if (this.isWon) return;
    const R = this.gridSize;
    const C = this.gridSize;
    const wrongCells = [];

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const cell = this.grid[r][c];
        if (cell.currentMask !== cell.targetMask) {
          wrongCells.push({ r, c, cell });
        }
      }
    }

    if (wrongCells.length === 0) return;

    this.sound.playHint();
    this.hintsUsed = (this.hintsUsed || 0) + 1;
    this.updateHintCount();
    const capNote = this.hintsUsed >= 3 ? '這局最高 1 星' : '這局最高 2 星';

    const chosen = wrongCells[Math.floor(Math.random() * wrongCells.length)];
    const { r, c, cell } = chosen;

    while (cell.currentMask !== cell.targetMask) {
      cell.rotationDeg += 90;
      cell.currentMask = this.rotateMask(cell.currentMask);
    }

    const tile = document.getElementById(`cell-${r}-${c}`);
    if (tile) {
      tile.classList.add('is-hinted');
      const wrapper = tile.querySelector('.pipe-svg-wrapper');
      if (wrapper) wrapper.style.transform = `rotate(${cell.rotationDeg}deg)`;
      setTimeout(() => tile.classList.remove('is-hinted'), 1000);
    }
    this.announce(`提示：第 ${r + 1} 列第 ${c + 1} 行已轉好，${capNote}`);
    this.updatePowerFlow(true);
    this.saveGameState();
  }

  /* ------------------------------------------------------------------------
     通關獎勵、星級評分與 Confetti 動畫
     ------------------------------------------------------------------------ */
  handleWin() {
    this.isWon = true;
    this.stopTimer();

    // 依據理論最佳步數計算 1~3 星
    const par = this.parMoves || 1;
    const hints = this.hintsUsed || 0;
    const stars = evaluateLoopStars(this.moves, par, hints);
    const badgeText = stars === 3 ? '完美導通' : (stars === 2 ? '優秀通電' : '順利過關');

    this.clearGameState(this.gridSize);
    this.saveStats(this.gridSize, this.timerSeconds, this.moves, stars);
    this.dom.gridBoard.classList.add('is-won');

    this.sound.playWin();
    this.triggerConfetti();

    const starSvg = (active) => `
      <svg class="win-star-icon ${active ? 'active' : ''}" width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    `;

    const starsHtml = `
      <div class="win-stars-row" role="img" aria-label="${stars} 星（滿分 3 星）">
        ${starSvg(stars >= 1)}
        ${starSvg(stars >= 2)}
        ${starSvg(stars >= 3)}
      </div>
      <div class="win-stars-rating-badge">${badgeText}・${stars} 星</div>
    `;
    const hintLine = hints > 0
      ? `<li>使用提示：<b>${hints} 次</b><span class="stat-note">（${hints >= 3 ? '最高 1 星' : '最高 2 星'}）</span></li>`
      : '<li>使用提示：<b>0 次</b></li>';

    this.announce(`過關！${stars} 星，${this.moves} 步，用時 ${this.dom.timerText.textContent}`);

    const delay = prefersReducedMotion() ? 0 : 600;
    setTimeout(() => {
      this.dom.modalTitle.textContent = '電力全開！';
      this.dom.modalBody.innerHTML = `
        ${starsHtml}
        <ul class="win-stats">
          <li>盤面：<b>${this.gridSize} × ${this.gridSize}</b></li>
          <li>用時：<b>${this.dom.timerText.textContent}</b></li>
          <li>旋轉步數：<b>${this.moves} 步</b><span class="stat-note">（標準最少 ${par} 步）</span></li>
          ${hintLine}
        </ul>
      `;
      this.openDialog(this.dom.winDialog);
    }, delay);
  }

  /* 彩帶改走共用模組 BoboConfetti；模組缺席時安靜退場，遊戲照常能玩 */
  triggerConfetti() {
    const canvas = this.dom.confettiCanvas;
    if (!canvas) return;
    const confetti = (typeof BoboConfetti !== 'undefined') ? BoboConfetti : null;
    if (!confetti) return;
    // 參數完全比照本遊戲原本那份實作，接共用模組不改變既有的慶祝手感：
    // 45 顆圓點從畫面中心爆開、帶重力落下並淡出，配電力色票（琥珀／翠綠／天藍／靛紫）
    this.confettiStop = confetti.burst(canvas, {
      colors: ['#F59E0B', '#FBBF24', '#10B981', '#38BDF8', '#818CF8'],
      pieces: 45,
      origin: 'center',
      shape: 'circle',
      spread: 14,
      gravity: 0.28,
      fade: 0.022
    });
  }

  /* 開新局時收掉還在飛的彩帶（模組會 cancelAnimationFrame 並清空畫布） */
  stopConfetti() {
    if (typeof this.confettiStop === 'function') {
      this.confettiStop();
      this.confettiStop = null;
    }
  }
}

// 頁面載入啟動
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    new LoopNetGame();
  });
}

// 讓 node 測試可以直接驗證純函式
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evaluateLoopStars, describeMask };
}
