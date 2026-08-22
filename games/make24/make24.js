/* ==========================================================================
   24 點大腦算術 (Make 24) 核心遊戲邏輯
   ========================================================================== */

const STORAGE_KEY = 'make24_game_state';
const BEST_STREAK_KEY = 'make24_best_streak';

const SUITS = [
  { symbol: '♠', type: 'suit-black', name: 'spade' },
  { symbol: '♥', type: 'suit-red', name: 'heart' },
  { symbol: '♦', type: 'suit-red', name: 'diamond' },
  { symbol: '♣', type: 'suit-black', name: 'club' }
];

const MODES = {
  easy: {
    id: 'easy',
    name: '簡單',
    maxNum: 9,
    oddMax: 2,           // 偶數 >= 2
    minSolutions: 4,
    allowFraction: false
  },
  medium: {
    id: 'medium',
    name: '標準',
    maxNum: 10,
    oddMax: 3,
    minSolutions: 2,
    allowFraction: false
  },
  hard: {
    id: 'hard',
    name: '困難',
    maxNum: 12,
    allowFraction: false
  },
  master: {
    id: 'master',
    name: '大師',
    maxNum: 13,
    allowFraction: true
  }
};

const CURATED_MASTER_PUZZLES = [
  [3, 3, 8, 8],
  [5, 5, 5, 1],
  [1, 4, 5, 6],
  [1, 3, 4, 6],
  [2, 7, 7, 10],
  [1, 5, 11, 11],
  [3, 7, 9, 13],
  [3, 3, 7, 7],
  [4, 4, 10, 10],
  [1, 6, 6, 8],
  [5, 7, 7, 11],
  [3, 8, 8, 10],
  [2, 3, 11, 13],
  [6, 9, 9, 10]
];

/* --------------------------------------------------------------------------
   求解與特徵分析演算法
   -------------------------------------------------------------------------- */

/**
 * 求解 24 點並標記解法中是否出現分數/非整數中繼運算
 */
function solve24Detailed(nums) {
  const results = [];
  const helper = (list) => {
    if (list.length === 1) {
      if (Math.abs(list[0].val - 24) < 1e-5) {
        results.push({
          expr: list[0].expr,
          isFraction: !!list[0].isFraction
        });
      }
      return;
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const nextList = list.filter((_, idx) => idx !== i && idx !== j);
        const a = list[i], b = list[j];

        // 加法
        helper([...nextList, {
          val: a.val + b.val,
          expr: `(${a.expr} + ${b.expr})`,
          isFraction: a.isFraction || b.isFraction || !Number.isInteger(Math.round((a.val + b.val) * 1e5) / 1e5)
        }]);

        // 減法
        helper([...nextList, {
          val: a.val - b.val,
          expr: `(${a.expr} - ${b.expr})`,
          isFraction: a.isFraction || b.isFraction || !Number.isInteger(Math.round((a.val - b.val) * 1e5) / 1e5)
        }]);

        // 乘法
        helper([...nextList, {
          val: a.val * b.val,
          expr: `(${a.expr} × ${b.expr})`,
          isFraction: a.isFraction || b.isFraction || !Number.isInteger(Math.round((a.val * b.val) * 1e5) / 1e5)
        }]);

        // 除法
        if (Math.abs(b.val) > 1e-5) {
          const divVal = a.val / b.val;
          const isNonIntegerDivision = Math.abs(divVal - Math.round(divVal)) > 1e-5;
          helper([...nextList, {
            val: divVal,
            expr: `(${a.expr} ÷ ${b.expr})`,
            isFraction: a.isFraction || b.isFraction || isNonIntegerDivision
          }]);
        }
      }
    }
  };

  helper(nums.map(n => ({ val: n, expr: n.toString(), isFraction: false })));

  // 去重並優先保留整數解標記
  const map = new Map();
  results.forEach(item => {
    if (!map.has(item.expr)) {
      map.set(item.expr, item.isFraction);
    } else if (!item.isFraction) {
      map.set(item.expr, false);
    }
  });

  const uniqueSolutions = [];
  map.forEach((isFraction, expr) => {
    uniqueSolutions.push({ expr, isFraction });
  });

  return uniqueSolutions;
}

/**
 * 簡易封裝，回傳字串陣列（相容既有介面）
 */
function solve24(nums) {
  return solve24Detailed(nums).map(s => s.expr);
}

/**
 * 分析題目的奇偶特徵、解法空間與難度標籤
 */
function analyzePuzzle(nums) {
  const oddCount = nums.filter(n => n % 2 !== 0).length;
  const evenCount = 4 - oddCount;
  const rawSolutions = solve24Detailed(nums);
  const solutions = rawSolutions.map(s => s.expr);
  const solutionCount = solutions.length;
  const hasIntegerSolution = rawSolutions.some(s => !s.isFraction);
  const hasFractionSolution = rawSolutions.some(s => s.isFraction);
  const isFractionOnly = solutionCount > 0 && !hasIntegerSolution;

  let tag = '常規題型';
  if (isFractionOnly) {
    tag = '💡 分數逆算題';
  } else if (oddCount === 4) {
    tag = '💡 四奇數挑戰';
  } else if (oddCount === 3) {
    tag = '💡 三奇數攻防';
  } else if (solutionCount === 1) {
    tag = '💡 精準唯一解';
  } else if (evenCount >= 3) {
    tag = '💡 偶數因數題';
  } else if (hasFractionSolution) {
    tag = '💡 複合運算題';
  }

  return {
    nums,
    oddCount,
    evenCount,
    solutions,
    rawSolutions,
    solutionCount,
    hasIntegerSolution,
    hasFractionSolution,
    isFractionOnly,
    tag
  };
}

/**
 * 難度符合性檢驗
 */
function isPuzzleMatchingDifficulty(puzzleInfo, mode) {
  if (puzzleInfo.solutionCount === 0) return false;

  switch (mode) {
    case 'easy':
      // 偶數 >= 2 (oddCount <= 2), 必須有整數解, 解法數 >= 4
      return puzzleInfo.evenCount >= 2 && puzzleInfo.hasIntegerSolution && puzzleInfo.solutionCount >= 4;

    case 'medium':
      // 必須有整數解, 解法數 2~12 種, 奇數 <= 3
      return puzzleInfo.hasIntegerSolution && puzzleInfo.solutionCount >= 2 && puzzleInfo.oddCount <= 3;

    case 'hard':
      // 必須有解，且 (奇數 >= 3 或 解法數 <= 3)
      return puzzleInfo.solutionCount >= 1 && (puzzleInfo.oddCount >= 3 || puzzleInfo.solutionCount <= 3);

    case 'master':
      // 分數唯一解，或 4 奇數少解，或 大牌 (11~13) 少解，或 奇數 >= 3 少解
      return puzzleInfo.isFractionOnly ||
             (puzzleInfo.oddCount === 4 && puzzleInfo.solutionCount <= 3) ||
             (puzzleInfo.oddCount >= 3 && puzzleInfo.solutionCount <= 2) ||
             (puzzleInfo.nums.some(n => n >= 11) && puzzleInfo.solutionCount <= 2);

    default:
      return true;
  }
}

/* --------------------------------------------------------------------------
   音效管理
   -------------------------------------------------------------------------- */
class SoundManager {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.ctx = new AudioContext();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playTone(freq, type, duration, delay = 0) {
    try {
      this.init();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime + delay);

      gain.gain.setValueAtTime(0.12, this.ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + delay + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(this.ctx.currentTime + delay);
      osc.stop(this.ctx.currentTime + delay + duration);
    } catch (_) {}
  }

  playCardClick() {
    this.playTone(520, 'sine', 0.08);
  }

  playOpClick() {
    this.playTone(440, 'triangle', 0.06);
  }

  playBackspace() {
    this.playTone(280, 'sine', 0.08);
  }

  playWin() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.playTone(f, 'triangle', 0.25, i * 0.09);
    });
  }
}

/* --------------------------------------------------------------------------
   主遊戲控制類別
   -------------------------------------------------------------------------- */
class Make24Game {
  constructor() {
    // 狀態變數 (4 檔模式: easy, medium, hard, master)
    this.currentMode = 'easy';
    this.cardData = [];          // 當前局的 4 張卡片資料 [{num, suit, displayRank, subLabel}]
    this.usedCardIndices = new Set(); // 記錄已使用的卡片索引
    this.tokens = [];            // 目前算式 Token 陣列 [{type: 'num'|'op', val: string, cardIdx?: number}]
    this.solutions = [];         // 當前數字的可行解
    this.puzzleInfo = null;      // 當前題目特徵資料
    this.sound = new SoundManager();
    this.isWon = false;

    // 計分與統計
    this.streak = 0;
    this.bestStreak = this.getBestStreak(this.currentMode);
    this.timerSeconds = 0;
    this.timerInterval = null;

    // DOM 元素引用
    this.dom = {
      themeBtn: document.getElementById('theme-btn'),
      tabButtons: document.querySelectorAll('.tab-btn'),
      timerText: document.getElementById('timer-text'),
      streakText: document.getElementById('streak-text'),
      bestText: document.getElementById('best-text'),
      displayCard: document.getElementById('display-card'),
      equationContainer: document.getElementById('equation-container'),
      evalResult: document.getElementById('eval-result'),
      cardsGrid: document.getElementById('cards-grid'),
      btnBackspace: document.getElementById('btn-backspace'),
      btnClear: document.getElementById('btn-clear'),
      btnHint: document.getElementById('btn-hint'),
      btnSkip: document.getElementById('btn-skip'),
      modalOverlay: document.getElementById('modal-overlay'),
      modalTitle: document.getElementById('modal-title'),
      modalBody: document.getElementById('modal-body'),
      modalCloseBtn: document.getElementById('modal-close-btn'),
      confettiCanvas: document.getElementById('confetti-canvas')
    };

    this.init();
  }

  init() {
    this.setupTheme();
    this.bindEvents();
    if (!this.loadGameState()) {
      this.bestStreak = this.getBestStreak(this.currentMode);
      this.updateStatsDisplay();
      this.startNewGame();
    }
  }

  getBestStreakKey(mode) {
    return `make24_best_streak_${mode}`;
  }

  getBestStreak(mode) {
    try {
      const modeVal = localStorage.getItem(this.getBestStreakKey(mode));
      if (modeVal !== null) return parseInt(modeVal, 10) || 0;
      const oldVal = localStorage.getItem(BEST_STREAK_KEY);
      if (oldVal !== null) return parseInt(oldVal, 10) || 0;
    } catch (_) {}
    return 0;
  }

  /* ------------------------------------------------------------------------
     主題切換邏輯 (與首頁 bobo-home-preferences-v2 相容)
     ------------------------------------------------------------------------ */
  setupTheme() {
    let savedTheme = 'light';
    try {
      const prefs = JSON.parse(localStorage.getItem('bobo-home-preferences-v2') || '{}');
      if (prefs.theme && ['dark', 'light'].includes(prefs.theme)) {
        savedTheme = prefs.theme;
      } else if (localStorage.getItem('make24_theme')) {
        savedTheme = localStorage.getItem('make24_theme');
      } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        savedTheme = 'dark';
      }
    } catch (_) {}

    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeIcon(savedTheme);

    if (this.dom.themeBtn) {
      this.dom.themeBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', nextTheme);
        try {
          localStorage.setItem('make24_theme', nextTheme);
          const prefs = JSON.parse(localStorage.getItem('bobo-home-preferences-v2') || '{}');
          prefs.theme = nextTheme;
          localStorage.setItem('bobo-home-preferences-v2', JSON.stringify(prefs));
        } catch (_) {}
        this.updateThemeIcon(nextTheme);
      });
    }
  }

  updateThemeIcon(theme) {
    if (this.dom.themeBtn) {
      this.dom.themeBtn.innerHTML = theme === 'dark'
        ? '<i class="fa-solid fa-sun" style="color: #FBBF24;"></i>'
        : '<i class="fa-solid fa-moon"></i>';
    }
  }

  /* ------------------------------------------------------------------------
     事件綁定 (Events & Keyboard Shortcuts)
     ------------------------------------------------------------------------ */
  bindEvents() {
    // 4 檔模式切換
    this.dom.tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode && MODES[mode]) {
          this.switchMode(mode);
        }
      });
    });

    // 運算符按鈕
    document.querySelectorAll('.btn-key.op').forEach(btn => {
      btn.addEventListener('click', () => {
        this.sound.playOpClick();
        this.addOperatorToken(btn.dataset.op);
      });
    });

    // 功能按鈕
    if (this.dom.btnBackspace) {
      this.dom.btnBackspace.addEventListener('click', () => {
        this.sound.playBackspace();
        this.handleBackspace();
      });
    }
    if (this.dom.btnClear) {
      this.dom.btnClear.addEventListener('click', () => {
        this.sound.playBackspace();
        this.handleClear();
      });
    }
    if (this.dom.btnHint) {
      this.dom.btnHint.addEventListener('click', () => this.showHint());
    }
    if (this.dom.btnSkip) {
      this.dom.btnSkip.addEventListener('click', () => {
        this.streak = 0; // 換牌重置連勝
        this.updateStatsDisplay();
        this.clearGameState();
        this.startNewGame();
      });
    }

    // Modal 關閉
    if (this.dom.modalCloseBtn) {
      this.dom.modalCloseBtn.addEventListener('click', () => {
        this.dom.modalOverlay.classList.remove('active');
        if (this.isWon) {
          this.clearGameState();
          this.startNewGame();
        }
      });
    }

    if (this.dom.modalOverlay) {
      this.dom.modalOverlay.addEventListener('click', (e) => {
        if (e.target === this.dom.modalOverlay) {
          this.dom.modalOverlay.classList.remove('active');
          if (this.isWon) {
            this.clearGameState();
            this.startNewGame();
          }
        }
      });
    }

    // 頁面卸載時保存進度
    window.addEventListener('beforeunload', () => {
      if (!this.isWon) this.saveGameState();
    });

    // 鍵盤快速鍵支援
    window.addEventListener('keydown', (e) => {
      if (this.dom.modalOverlay && this.dom.modalOverlay.classList.contains('active')) {
        if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
          e.preventDefault();
          if (this.dom.modalCloseBtn) this.dom.modalCloseBtn.click();
        }
        return;
      }

      if (['1', '2', '3', '4'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const cardIndex = parseInt(e.key, 10) - 1;
        if (this.cardData[cardIndex] && !this.usedCardIndices.has(cardIndex)) {
          e.preventDefault();
          this.sound.playCardClick();
          this.addNumberToken(cardIndex, this.cardData[cardIndex].num);
        }
      } else if (['+', '-', '*', '/', '(', ')'].includes(e.key)) {
        e.preventDefault();
        this.sound.playOpClick();
        const map = { '*': '×', '/': '÷' };
        this.addOperatorToken(map[e.key] || e.key);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        this.sound.playBackspace();
        this.handleBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.sound.playBackspace();
        this.handleClear();
      }
    });
  }

  switchMode(mode) {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    this.dom.tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    this.streak = 0;
    this.bestStreak = this.getBestStreak(mode);
    this.updateStatsDisplay();
    this.clearGameState();
    this.startNewGame();
  }

  /* ------------------------------------------------------------------------
     遊戲流程控制 (Game Loop)
     ------------------------------------------------------------------------ */
  startNewGame() {
    this.stopTimer();
    this.timerSeconds = 0;
    this.isWon = false;
    if (this.dom.timerText) this.dom.timerText.textContent = '0s';

    // 生成符合當前難度特徵的保證有解卡牌
    this.generateSolvableCards();
    this.usedCardIndices.clear();
    this.tokens = [];

    this.renderCards();
    this.updateEquationDisplay();
    this.startTimer();
    this.saveGameState();
  }

  startTimer() {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      if (this.dom.timerText) this.dom.timerText.textContent = `${this.timerSeconds}s`;
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
     進度持久化 (localStorage)
     ------------------------------------------------------------------------ */
  saveGameState() {
    if (this.isWon) return;
    try {
      const state = {
        currentMode: this.currentMode,
        cardData: this.cardData,
        usedCardIndices: Array.from(this.usedCardIndices),
        tokens: this.tokens,
        solutions: this.solutions,
        puzzleInfo: this.puzzleInfo,
        streak: this.streak,
        timerSeconds: this.timerSeconds,
        timestamp: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  loadGameState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw);
      if (!state || !state.cardData || state.cardData.length !== 4) return false;

      // 舊版難度相容遷移
      let mode = state.currentMode || 'easy';
      if (mode === 'classic') mode = 'medium';
      if (mode === 'expert') mode = 'master';
      if (!MODES[mode]) mode = 'easy';

      this.currentMode = mode;
      this.cardData = state.cardData;
      this.usedCardIndices = new Set(state.usedCardIndices || []);
      this.tokens = state.tokens || [];
      this.solutions = state.solutions || [];
      this.puzzleInfo = state.puzzleInfo || null;
      this.streak = state.streak || 0;
      this.bestStreak = this.getBestStreak(this.currentMode);
      this.timerSeconds = state.timerSeconds || 0;
      this.isWon = false;

      this.dom.tabButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === this.currentMode);
      });

      this.updateStatsDisplay();
      this.renderCards();
      this.updateEquationDisplay();
      this.startTimer();
      return true;
    } catch (e) {
      console.warn('載入 24 點進度失敗:', e);
      return false;
    }
  }

  clearGameState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  /* ------------------------------------------------------------------------
     智慧難度題目生成引擎
     ------------------------------------------------------------------------ */
  generateSolvableCards() {
    const mode = this.currentMode;
    const modeConfig = MODES[mode] || MODES.easy;
    let puzzle = null;

    // 大師模式有 45% 機率直接從經典魔王題庫選題
    if (mode === 'master' && Math.random() < 0.45) {
      const template = CURATED_MASTER_PUZZLES[Math.floor(Math.random() * CURATED_MASTER_PUZZLES.length)];
      const shuffled = [...template].sort(() => Math.random() - 0.5);
      const analyzed = analyzePuzzle(shuffled);
      if (analyzed.solutionCount > 0) {
        puzzle = analyzed;
      }
    }

    if (!puzzle) {
      let attempts = 0;
      const maxAttempts = 150;
      while (attempts < maxAttempts) {
        attempts++;
        const testNums = Array.from({ length: 4 }, () => Math.floor(Math.random() * modeConfig.maxNum) + 1);
        const analyzed = analyzePuzzle(testNums);
        if (isPuzzleMatchingDifficulty(analyzed, mode)) {
          puzzle = analyzed;
          break;
        }
      }
    }

    // 防呆備援機制
    if (!puzzle) {
      if (mode === 'master') {
        const template = CURATED_MASTER_PUZZLES[Math.floor(Math.random() * CURATED_MASTER_PUZZLES.length)];
        puzzle = analyzePuzzle([...template].sort(() => Math.random() - 0.5));
      } else {
        const fallbacks = {
          easy: [2, 4, 6, 8],
          medium: [3, 4, 6, 7],
          hard: [3, 3, 7, 7]
        };
        const nums = fallbacks[mode] || [1, 2, 3, 4];
        puzzle = analyzePuzzle(nums);
      }
    }

    this.puzzleInfo = puzzle;
    // 簡單與標準模式優先展示整數解
    if (mode === 'easy' || mode === 'medium') {
      const integerSolutions = puzzle.rawSolutions.filter(s => !s.isFraction).map(s => s.expr);
      this.solutions = integerSolutions.length > 0 ? integerSolutions : puzzle.solutions;
    } else {
      this.solutions = puzzle.solutions;
    }

    // 隨機指派撲克牌花色與牌面文字
    this.cardData = puzzle.nums.map(num => {
      const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
      let displayRank = num.toString();
      let subLabel = '';
      if (num === 1) { displayRank = 'A'; subLabel = '1'; }
      else if (num === 11) { displayRank = 'J'; subLabel = '11'; }
      else if (num === 12) { displayRank = 'Q'; subLabel = '12'; }
      else if (num === 13) { displayRank = 'K'; subLabel = '13'; }

      return { num, suit, displayRank, subLabel };
    });
  }

  /* ------------------------------------------------------------------------
     UI 繪製：撲克牌卡片
     ------------------------------------------------------------------------ */
  renderCards() {
    if (!this.dom.cardsGrid) return;
    this.dom.cardsGrid.innerHTML = '';
    this.cardData.forEach((card, idx) => {
      const btn = document.createElement('button');
      btn.className = `poker-card ${card.suit.type}`;
      btn.dataset.index = idx;
      btn.disabled = this.usedCardIndices.has(idx) || this.isWon;
      btn.title = `第 ${idx + 1} 張牌 (鍵盤快速鍵: ${idx + 1})`;

      btn.innerHTML = `
        <div class="card-corner top">
          <span class="card-suit-icon">${card.suit.symbol}</span>
        </div>
        <div class="card-center">
          <span class="center-number">${card.displayRank}</span>
          ${card.subLabel ? `<span class="center-sub">(${card.subLabel})</span>` : ''}
        </div>
        <div class="card-corner bottom">
          <span class="card-suit-icon">${card.suit.symbol}</span>
        </div>
      `;

      btn.addEventListener('click', () => {
        this.sound.playCardClick();
        this.addNumberToken(idx, card.num);
      });
      this.dom.cardsGrid.appendChild(btn);
    });
  }

  addNumberToken(cardIdx, numValue) {
    if (this.usedCardIndices.has(cardIdx) || this.isWon) return;

    this.tokens.push({ type: 'num', val: numValue.toString(), cardIdx });
    this.usedCardIndices.add(cardIdx);

    this.renderCards();
    this.updateEquationDisplay();
    this.saveGameState();
  }

  addOperatorToken(opSymbol) {
    if (this.isWon) return;
    this.tokens.push({ type: 'op', val: opSymbol });
    this.updateEquationDisplay();
    this.saveGameState();
  }

  handleBackspace() {
    if (this.tokens.length === 0 || this.isWon) return;
    const popped = this.tokens.pop();
    if (popped.type === 'num' && popped.cardIdx !== undefined) {
      this.usedCardIndices.delete(popped.cardIdx);
      this.renderCards();
    }
    this.updateEquationDisplay();
    this.saveGameState();
  }

  handleClear() {
    if (this.isWon) return;
    this.tokens = [];
    this.usedCardIndices.clear();
    this.renderCards();
    this.updateEquationDisplay();
    this.saveGameState();
  }

  /* ------------------------------------------------------------------------
     算式輸入框顯示與即時計算
     ------------------------------------------------------------------------ */
  updateEquationDisplay() {
    if (!this.dom.equationContainer || !this.dom.evalResult) return;

    if (this.tokens.length === 0) {
      this.dom.equationContainer.innerHTML = `<span style="color: var(--text-secondary); font-size: 13px; font-family: sans-serif;">點選下方撲克牌與符號組合 24 點</span>`;
      this.dom.evalResult.textContent = '';
      if (this.dom.displayCard) this.dom.displayCard.classList.remove('is-correct');
      return;
    }

    this.dom.equationContainer.innerHTML = '';
    this.tokens.forEach(token => {
      const span = document.createElement('span');
      span.className = `equation-token ${token.type === 'num' ? 'num' : 'op'}`;
      span.textContent = token.val;
      this.dom.equationContainer.appendChild(span);
    });

    const evalRes = this.evaluateTokens();
    if (evalRes.error) {
      this.dom.evalResult.textContent = '算式計算中...';
      this.dom.evalResult.className = 'eval-result';
      if (this.dom.displayCard) this.dom.displayCard.classList.remove('is-correct');
    } else {
      const valFormatted = Number.isInteger(evalRes.val) ? evalRes.val : evalRes.val.toFixed(2);
      this.dom.evalResult.textContent = `= ${valFormatted}`;

      // 獲勝判定：使用全部 4 張卡牌且計算結果等於 24
      const allUsed = this.usedCardIndices.size === 4;
      const isTwentyFour = Math.abs(evalRes.val - 24) < 1e-5;

      if (allUsed && isTwentyFour && !this.isWon) {
        this.dom.evalResult.textContent = '= 24 (過關！🎉)';
        this.dom.evalResult.className = 'eval-result success';
        if (this.dom.displayCard) this.dom.displayCard.classList.add('is-correct');
        this.handleWin();
      } else {
        this.dom.evalResult.className = 'eval-result';
        if (this.dom.displayCard) this.dom.displayCard.classList.remove('is-correct');
      }
    }
  }

  evaluateTokens() {
    try {
      const exprStr = this.tokens.map(t => {
        if (t.val === '×') return '*';
        if (t.val === '÷') return '/';
        return t.val;
      }).join('');

      // 安全檢查：僅允許數字、四則運算符、括號與小數點
      if (!/^[0-9+\-*/().\s]+$/.test(exprStr)) return { error: true };
      if (/[*\/+\-]$/.test(exprStr)) return { error: true };

      const fn = new Function(`return (${exprStr})`);
      const val = fn();
      if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) return { error: true };

      return { val };
    } catch (_) {
      return { error: true };
    }
  }

  /* ------------------------------------------------------------------------
     過關與獎勵
     ------------------------------------------------------------------------ */
  handleWin() {
    this.isWon = true;
    this.stopTimer();
    this.clearGameState();
    this.streak++;
    if (this.streak > this.bestStreak) {
      this.bestStreak = this.streak;
      try {
        localStorage.setItem(this.getBestStreakKey(this.currentMode), this.bestStreak.toString());
        localStorage.setItem(BEST_STREAK_KEY, this.bestStreak.toString());
      } catch (_) {}
    }
    this.updateStatsDisplay();
    this.sound.playWin();

    this.triggerConfetti();

    const modeName = MODES[this.currentMode]?.name || '當前';
    setTimeout(() => {
      this.showModal('解謎成功！🎉', `難度：<b>${modeName} 模式</b><br>耗時：<b>${this.timerSeconds} 秒</b><br>當前連勝：<b>${this.streak} 局</b><br>該模式最佳：<b>${this.bestStreak} 局</b>`);
      if (this.dom.modalCloseBtn) {
        this.dom.modalCloseBtn.onclick = () => {
          this.dom.modalOverlay.classList.remove('active');
          this.startNewGame();
        };
      }
    }, 450);
  }

  updateStatsDisplay() {
    if (this.dom.streakText) this.dom.streakText.textContent = this.streak;
    if (this.dom.bestText) this.dom.bestText.textContent = this.bestStreak;
  }

  /* ------------------------------------------------------------------------
     提示與彈窗
     ------------------------------------------------------------------------ */
  showHint() {
    if (this.solutions.length === 0) return;
    const randomSolution = this.solutions[Math.floor(Math.random() * this.solutions.length)];
    const tagHtml = this.puzzleInfo && this.puzzleInfo.tag
      ? `<div class="puzzle-tag">${this.puzzleInfo.tag}</div>`
      : '';

    this.showModal('解法參考', `${tagHtml}<div>其中一個可行的組合算式為：</div><div class="hint-solution">${randomSolution} = 24</div>`);
    if (this.dom.modalCloseBtn) {
      this.dom.modalCloseBtn.onclick = () => {
        this.dom.modalOverlay.classList.remove('active');
      };
    }
  }

  showModal(title, htmlContent) {
    if (!this.dom.modalTitle || !this.dom.modalBody || !this.dom.modalOverlay) return;
    this.dom.modalTitle.textContent = title;
    this.dom.modalBody.innerHTML = htmlContent;
    this.dom.modalOverlay.classList.add('active');
  }

  /* ------------------------------------------------------------------------
     五彩紙屑粒子特效 (Confetti)
     ------------------------------------------------------------------------ */
  triggerConfetti() {
    const canvas = this.dom.confettiCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth || document.documentElement.clientWidth;
    canvas.height = window.innerHeight || document.documentElement.clientHeight;

    const particles = Array.from({ length: 45 }, () => ({
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 12,
      vy: (Math.random() - 0.8) * 11,
      color: ['#6366F1', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6'][Math.floor(Math.random() * 6)],
      size: Math.random() * 6 + 4,
      gravity: 0.25,
      alpha: 1
    }));

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let stillAlive = false;

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.alpha -= 0.018;

        if (p.alpha > 0) {
          stillAlive = true;
          ctx.globalAlpha = Math.max(0, p.alpha);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      if (stillAlive) {
        requestAnimationFrame(animate);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };

    animate();
  }
}

// 支援 Node.js 模組匯出以供測試
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Make24Game,
    MODES,
    CURATED_MASTER_PUZZLES,
    solve24Detailed,
    solve24,
    analyzePuzzle,
    isPuzzleMatchingDifficulty
  };
}

// 初始化遊戲實例 (瀏覽器環境)
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    new Make24Game();
  });
}
