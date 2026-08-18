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

class Make24Game {
  constructor() {
    // 狀態變數
    this.currentMode = 'classic'; // 'classic' (1-10) 或 'expert' (1-13)
    this.cardData = [];          // 當前局的 4 張卡片資料 [{num, suit, displayRank, subLabel}]
    this.usedCardIndices = new Set(); // 記錄已使用的卡片索引
    this.tokens = [];            // 目前算式 Token 陣列 [{type: 'num'|'op', val: string, cardIdx?: number}]
    this.solutions = [];         // 當前數字的所有可行解
    this.sound = new SoundManager();
    this.isWon = false;

    // 計分與統計
    this.streak = 0;
    this.bestStreak = parseInt(localStorage.getItem(BEST_STREAK_KEY) || '0', 10);
    this.timerSeconds = 0;
    this.timerInterval = null;

    // DOM 元素引用
    this.dom = {
      themeBtn: document.getElementById('theme-btn'),
      tabClassic: document.getElementById('tab-classic'),
      tabExpert: document.getElementById('tab-expert'),
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
    this.updateStatsDisplay();
    if (!this.loadGameState()) {
      this.startNewGame();
    }
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

  updateThemeIcon(theme) {
    this.dom.themeBtn.innerHTML = theme === 'dark'
      ? '<i class="fa-solid fa-sun" style="color: #FBBF24;"></i>'
      : '<i class="fa-solid fa-moon"></i>';
  }

  /* ------------------------------------------------------------------------
     事件綁定 (Events & Keyboard Shortcuts)
     ------------------------------------------------------------------------ */
  bindEvents() {
    // 模式切換
    this.dom.tabClassic.addEventListener('click', () => this.switchMode('classic'));
    this.dom.tabExpert.addEventListener('click', () => this.switchMode('expert'));

    // 運算符按鈕
    document.querySelectorAll('.btn-key.op').forEach(btn => {
      btn.addEventListener('click', () => {
        this.sound.playOpClick();
        this.addOperatorToken(btn.dataset.op);
      });
    });

    // 功能按鈕
    this.dom.btnBackspace.addEventListener('click', () => {
      this.sound.playBackspace();
      this.handleBackspace();
    });
    this.dom.btnClear.addEventListener('click', () => {
      this.sound.playBackspace();
      this.handleClear();
    });
    this.dom.btnHint.addEventListener('click', () => this.showHint());
    this.dom.btnSkip.addEventListener('click', () => {
      this.streak = 0; // 換牌重置連勝
      this.updateStatsDisplay();
      this.clearGameState();
      this.startNewGame();
    });

    // Modal 關閉
    this.dom.modalCloseBtn.addEventListener('click', () => {
      this.dom.modalOverlay.classList.remove('active');
      if (this.isWon) {
        this.clearGameState();
        this.startNewGame();
      }
    });

    this.dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.dom.modalOverlay) {
        this.dom.modalOverlay.classList.remove('active');
        if (this.isWon) {
          this.clearGameState();
          this.startNewGame();
        }
      }
    });

    // 頁面卸載時保存進度
    window.addEventListener('beforeunload', () => {
      if (!this.isWon) this.saveGameState();
    });

    // 鍵盤快速鍵支援
    window.addEventListener('keydown', (e) => {
      if (this.dom.modalOverlay.classList.contains('active')) {
        if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
          e.preventDefault();
          this.dom.modalCloseBtn.click();
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
    this.dom.tabClassic.classList.toggle('active', mode === 'classic');
    this.dom.tabExpert.classList.toggle('active', mode === 'expert');
    this.streak = 0;
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
    this.dom.timerText.textContent = '0s';

    // 生成保證有解的 4 個數字
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
      this.dom.timerText.textContent = `${this.timerSeconds}s`;
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

      this.currentMode = state.currentMode || 'classic';
      this.cardData = state.cardData;
      this.usedCardIndices = new Set(state.usedCardIndices || []);
      this.tokens = state.tokens || [];
      this.solutions = state.solutions || [];
      this.streak = state.streak || 0;
      this.timerSeconds = state.timerSeconds || 0;
      this.isWon = false;

      this.dom.tabClassic.classList.toggle('active', this.currentMode === 'classic');
      this.dom.tabExpert.classList.toggle('active', this.currentMode === 'expert');

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
     保證有解的 24 點求解引擎 (支援括號與分數除法)
     ------------------------------------------------------------------------ */
  generateSolvableCards() {
    const maxNum = this.currentMode === 'classic' ? 10 : 13;
    let valid = false;

    while (!valid) {
      const testNums = Array.from({ length: 4 }, () => Math.floor(Math.random() * maxNum) + 1);
      const solutions = this.solve24(testNums);

      if (solutions.length > 0) {
        this.solutions = solutions;
        // 隨機指派花色與卡面文字
        this.cardData = testNums.map(num => {
          const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
          let displayRank = num.toString();
          let subLabel = '';
          if (this.currentMode === 'expert') {
            if (num === 1) { displayRank = 'A'; subLabel = '1'; }
            else if (num === 11) { displayRank = 'J'; subLabel = '11'; }
            else if (num === 12) { displayRank = 'Q'; subLabel = '12'; }
            else if (num === 13) { displayRank = 'K'; subLabel = '13'; }
          }

          return { num, suit, displayRank, subLabel };
        });
        valid = true;
      }
    }
  }

  solve24(nums) {
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

  /* ------------------------------------------------------------------------
     UI 繪製：左上/右下花色，正中間大數字
     ------------------------------------------------------------------------ */
  renderCards() {
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
    if (this.tokens.length === 0) {
      this.dom.equationContainer.innerHTML = `<span style="color: var(--text-secondary); font-size: 13px; font-family: sans-serif;">點選下方撲克牌與符號組合 24 點</span>`;
      this.dom.evalResult.textContent = '';
      this.dom.displayCard.classList.remove('is-correct');
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
      this.dom.displayCard.classList.remove('is-correct');
    } else {
      const valFormatted = Number.isInteger(evalRes.val) ? evalRes.val : evalRes.val.toFixed(2);
      this.dom.evalResult.textContent = `= ${valFormatted}`;

      // 獲勝判定：使用全數 4 張卡片且結果等於 24
      const allUsed = this.usedCardIndices.size === 4;
      const isTwentyFour = Math.abs(evalRes.val - 24) < 1e-5;

      if (allUsed && isTwentyFour && !this.isWon) {
        this.dom.evalResult.textContent = '= 24 (過關！🎉)';
        this.dom.evalResult.className = 'eval-result success';
        this.dom.displayCard.classList.add('is-correct');
        this.handleWin();
      } else {
        this.dom.evalResult.className = 'eval-result';
        this.dom.displayCard.classList.remove('is-correct');
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
        localStorage.setItem(BEST_STREAK_KEY, this.bestStreak.toString());
      } catch (_) {}
    }
    this.updateStatsDisplay();
    this.sound.playWin();

    this.triggerConfetti();

    setTimeout(() => {
      this.showModal('解謎成功！🎉', `耗時：<b>${this.timerSeconds} 秒</b><br>當前連勝：<b>${this.streak} 局</b><br>歷史最佳：<b>${this.bestStreak} 局</b>`);
      this.dom.modalCloseBtn.onclick = () => {
        this.dom.modalOverlay.classList.remove('active');
        this.startNewGame();
      };
    }, 450);
  }

  updateStatsDisplay() {
    this.dom.streakText.textContent = this.streak;
    this.dom.bestText.textContent = this.bestStreak;
  }

  /* ------------------------------------------------------------------------
     提示與彈窗
     ------------------------------------------------------------------------ */
  showHint() {
    if (this.solutions.length === 0) return;
    const randomSolution = this.solutions[Math.floor(Math.random() * this.solutions.length)];
    this.showModal('解法參考', `其中一個可行的組合算式為：<div class="hint-solution">${randomSolution} = 24</div>`);
    this.dom.modalCloseBtn.onclick = () => {
      this.dom.modalOverlay.classList.remove('active');
    };
  }

  showModal(title, htmlContent) {
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

// 初始化遊戲實例
document.addEventListener('DOMContentLoaded', () => {
  new Make24Game();
});
