/* ==========================================================================
   Loop 電流接接樂 (Loop Circuit) 核心遊戲邏輯
   ========================================================================== */

const STORAGE_KEY = 'loop_game_state';
const STATS_KEY = 'loop_game_stats';

class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('loopnet_sound') !== 'false';
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleSound() {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem('loopnet_sound', this.enabled);
    } catch (_) {}
    return this.enabled;
  }

  /* 旋轉開關點擊音效 (Relay Switch Click) */
  playRotate() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.04);

    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.04);
  }

  /* 電流導通音效 (Electric Zap / Flow) */
  playFlow() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    [587.33, 739.99, 880.00].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now + i * 0.02);

      gain.gain.setValueAtTime(0.05, now + i * 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.02 + 0.12);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.02);
      osc.stop(now + i * 0.02 + 0.12);
    });
  }

  /* 燈泡點亮叮噹音效 (Bulb Light-Up Chime) */
  playBulbLight() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    [659.25, 987.77, 1318.51].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.035);

      gain.gain.setValueAtTime(0.12, now + i * 0.035);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.035 + 0.25);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.035);
      osc.stop(now + i * 0.035 + 0.25);
    });
  }

  /* 提示音效 (Hint Chime) */
  playHint() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    [659.25, 880, 1174.66].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.05);

      gain.gain.setValueAtTime(0.12, now + i * 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 0.22);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.05);
      osc.stop(now + i * 0.05 + 0.22);
    });
  }

  /* 勝利電力全開和弦 (Power Victory Fanfare) */
  playWin() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51, 1567.98];
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.07);

      gain.gain.setValueAtTime(0.2, now + i * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.45);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.07);
      osc.stop(now + i * 0.07 + 0.45);
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
    this.grid = [];     // 儲存每個格子的狀態
    this.sourcePos = { r: 0, c: 0 };
    this.moves = 0;
    this.isWon = false;
    this.lastPoweredCount = 0;
    this.lastPoweredBulbCount = 0;

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
    this.setupSoundUI();
    this.bindEvents();
    if (!this.loadGameState()) {
      this.startNewGame();
    }
  }

  /* ------------------------------------------------------------------------
     主題與設定 (相容首頁 bobo-home-preferences-v2)
     ------------------------------------------------------------------------ */
  setupTheme() {
    let savedTheme = 'light';
    try {
      const prefs = JSON.parse(localStorage.getItem('bobo-home-preferences-v2') || '{}');
      if (prefs.theme && ['dark', 'light'].includes(prefs.theme)) {
        savedTheme = prefs.theme;
      } else if (localStorage.getItem('loopnet_theme')) {
        savedTheme = localStorage.getItem('loopnet_theme');
      } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        savedTheme = 'dark';
      }
    } catch (_) {}

    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeIcon(savedTheme);

    this.dom.themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('loopnet_theme', next);
        const prefs = JSON.parse(localStorage.getItem('bobo-home-preferences-v2') || '{}');
        prefs.theme = next;
        localStorage.setItem('bobo-home-preferences-v2', JSON.stringify(prefs));
      } catch (_) {}
      this.updateThemeIcon(next);
    });
  }

  updateThemeIcon(theme) {
    this.dom.themeBtn.innerHTML = theme === 'dark'
      ? '<i class="fa-solid fa-sun" style="color: #FBBF24;"></i>'
      : '<i class="fa-solid fa-moon"></i>';
  }

  setupSoundUI() {
    this.updateSoundIcon(this.sound.enabled);
    this.dom.soundBtn.addEventListener('click', () => {
      const isEnabled = this.sound.toggleSound();
      this.updateSoundIcon(isEnabled);
    });
  }

  updateSoundIcon(enabled) {
    this.dom.soundBtn.innerHTML = enabled
      ? '<i class="fa-solid fa-volume-high"></i>'
      : '<i class="fa-solid fa-volume-xmark" style="color: var(--text-secondary);"></i>';
  }

  bindEvents() {
    // Tab 難度切換
    this.dom.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const size = parseInt(tab.dataset.size, 10);
        if (this.gridSize === size) return;
        this.dom.tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.gridSize = size;
        this.clearGameState();
        this.startNewGame();
      });
    });

    this.dom.btnRestart.addEventListener('click', () => this.restartCurrentBoard());
    this.dom.btnHint.addEventListener('click', () => this.applyHint());
    this.dom.btnNewGame.addEventListener('click', () => {
      this.clearGameState();
      this.startNewGame();
    });
    this.dom.modalCloseBtn.addEventListener('click', () => {
      this.dom.modalOverlay.classList.remove('active');
      this.clearGameState();
      this.startNewGame();
    });

    this.dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.dom.modalOverlay) {
        this.dom.modalOverlay.classList.remove('active');
      }
    });

    // 頁面卸載時保存進度
    window.addEventListener('beforeunload', () => {
      if (!this.isWon) this.saveGameState();
    });
  }

  countBits(mask) {
    let count = 0;
    if (mask & this.DIR.UP) count++;
    if (mask & this.DIR.RIGHT) count++;
    if (mask & this.DIR.DOWN) count++;
    if (mask & this.DIR.LEFT) count++;
    return count;
  }

  /* ------------------------------------------------------------------------
     關卡生成演算法 (Randomized Spanning Tree)
     ------------------------------------------------------------------------ */
  generateBoard() {
    const R = this.gridSize;
    const C = this.gridSize;

    // 1. 初始化空網格
    const rawGrid = Array.from({ length: R }, () => Array(C).fill(0));
    const visited = Array.from({ length: R }, () => Array(C).fill(false));

    // 2. 隨機 DFS 生成生成樹 (確保全圖必能唯一完全連通)
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

    // 3. 設定中心為電池能量核心
    this.sourcePos = { r: Math.floor(R / 2), c: Math.floor(C / 2) };

    // 4. 隨機旋轉洗牌 (隨機打亂 1~3 次 90 度)
    this.grid = [];
    for (let r = 0; r < R; r++) {
      this.grid[r] = [];
      for (let c = 0; c < C; c++) {
        const targetMask = rawGrid[r][c];
        const rotCount = Math.floor(Math.random() * 3) + 1;
        let currentMask = targetMask;
        for (let i = 0; i < rotCount; i++) {
          currentMask = this.rotateMask(currentMask);
        }

        const isSource = (r === this.sourcePos.r && c === this.sourcePos.c);
        const isEndpoint = (!isSource && this.countBits(targetMask) === 1);

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
    this.isWon = false;
    this.moves = 0;
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
     進度與統計持久化 (localStorage)
     ------------------------------------------------------------------------ */
  saveGameState() {
    if (this.isWon) return;
    try {
      const state = {
        gridSize: this.gridSize,
        grid: this.grid,
        sourcePos: this.sourcePos,
        moves: this.moves,
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
      if (!state || !state.grid || !Array.isArray(state.grid) || !state.gridSize) return false;

      this.gridSize = state.gridSize;
      this.grid = state.grid;
      this.sourcePos = state.sourcePos || { r: Math.floor(this.gridSize / 2), c: Math.floor(this.gridSize / 2) };
      this.moves = state.moves || 0;
      this.timerSeconds = state.timerSeconds || 0;
      this.isWon = false;
      this.lastPoweredCount = 0;
      this.lastPoweredBulbCount = 0;

      // 更新 Tab UI
      this.dom.tabs.forEach(tab => {
        tab.classList.toggle('active', parseInt(tab.dataset.size, 10) === this.gridSize);
      });

      this.dom.movesText.textContent = this.moves.toString();
      const mins = Math.floor(this.timerSeconds / 60).toString().padStart(2, '0');
      const secs = (this.timerSeconds % 60).toString().padStart(2, '0');
      this.dom.timerText.textContent = `${mins}:${secs}`;

      this.renderBoard();
      this.updatePowerFlow(false);
      this.startTimer();
      return true;
    } catch (e) {
      console.warn('載入 Loop 進度失敗:', e);
      return false;
    }
  }

  clearGameState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  saveStats(size, seconds, moves) {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      const stats = raw ? JSON.parse(raw) : {};
      const key = `${size}x${size}`;
      const cur = stats[key] || { bestTime: null, bestMoves: null, clears: 0 };

      cur.clears = (cur.clears || 0) + 1;
      if (cur.bestTime === null || seconds < cur.bestTime) cur.bestTime = seconds;
      if (cur.bestMoves === null || moves < cur.bestMoves) cur.bestMoves = moves;

      stats[key] = cur;
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (_) {}
  }

  /* ------------------------------------------------------------------------
     SVG 線條渲染與棋盤繪製
     ------------------------------------------------------------------------ */
  renderBoard() {
    const R = this.gridSize;
    const C = this.gridSize;
    this.dom.gridBoard.style.gridTemplateColumns = `repeat(${C}, 1fr)`;
    this.dom.gridBoard.innerHTML = '';

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const cell = this.grid[r][c];
        const tile = document.createElement('div');
        tile.className = `cell-tile ${cell.isSource ? 'is-source' : ''} ${cell.isEndpoint ? 'is-endpoint' : ''}`;
        tile.id = `cell-${r}-${c}`;
        
        let tileTitle = `點擊旋轉電路 (${r + 1}, ${c + 1})`;
        if (cell.isSource) tileTitle = `能量電池核心 (${r + 1}, ${c + 1})`;
        else if (cell.isEndpoint) tileTitle = `電路終端燈泡 (${r + 1}, ${c + 1})`;
        tile.title = tileTitle;

        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'pipe-svg-wrapper';
        svgWrapper.style.transform = `rotate(${cell.rotationDeg}deg)`;

        svgWrapper.innerHTML = this.generatePipeSVG(cell);
        tile.appendChild(svgWrapper);

        tile.addEventListener('click', () => this.handleCellClick(r, c));
        this.dom.gridBoard.appendChild(tile);
      }
    }
  }

  generatePipeSVG(cell) {
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

    let centerComponent = '';

    if (cell.isSource) {
      // 1. 起點：電池 (Battery Source)
      centerComponent = `
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
      // 2. 終點：燈泡 (Terminal Lightbulb)
      centerComponent = `
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
    } else {
      // 3. 一般節點：金屬端子連接點 (Circuit Junction Stud)
      centerComponent = `
        <circle class="circuit-node" cx="50" cy="50" r="8"/>
        <circle class="circuit-spark-node" cx="50" cy="50" r="4"/>
      `;
    }

    return `
      <svg class="pipe-svg" viewBox="0 0 100 100">
        ${bgLines}
        ${sparkLines}
        ${centerComponent}
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
    this.updatePowerFlow(true);
    this.saveGameState();
  }

  /* ------------------------------------------------------------------------
     通關獎勵與 Confetti 動畫
     ------------------------------------------------------------------------ */
  handleWin() {
    this.isWon = true;
    this.stopTimer();
    this.clearGameState();
    this.saveStats(this.gridSize, this.timerSeconds, this.moves);
    this.dom.gridBoard.classList.add('is-won');

    this.sound.playWin();
    this.triggerConfetti();

    setTimeout(() => {
      this.dom.modalTitle.textContent = '電力全開！⚡';
      this.dom.modalBody.innerHTML = `
        恭喜連接電池並點亮所有終端燈泡！<br>
        關卡規格：<b>${this.gridSize} × ${this.gridSize}</b><br>
        總計耗時：<b>${this.dom.timerText.textContent}</b><br>
        旋轉步數：<b>${this.moves} 步</b>
      `;
      this.dom.modalOverlay.classList.add('active');
    }, 600);
  }

  triggerConfetti() {
    const canvas = this.dom.confettiCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth || document.documentElement.clientWidth;
    canvas.height = window.innerHeight || document.documentElement.clientHeight;

    const particles = Array.from({ length: 45 }, () => ({
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 14,
      vy: (Math.random() - 0.8) * 12,
      color: ['#F59E0B', '#FBBF24', '#10B981', '#38BDF8', '#818CF8'][Math.floor(Math.random() * 5)],
      size: Math.random() * 6 + 4,
      gravity: 0.28,
      alpha: 1
    }));

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let stillAlive = false;

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.alpha -= 0.022;

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

// 頁面載入啟動
document.addEventListener('DOMContentLoaded', () => {
  new LoopNetGame();
});
