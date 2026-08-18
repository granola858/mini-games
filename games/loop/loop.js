/* ==========================================================================
   Loop 水管接接樂 (Loop Net) 核心遊戲邏輯
   ========================================================================== */

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
    localStorage.setItem('loopnet_sound', this.enabled);
    return this.enabled;
  }

  playRotate() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(160, now + 0.05);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.05);
  }

  playFlow() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.025);

      gain.gain.setValueAtTime(0.06, now + i * 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.025 + 0.16);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.025);
      osc.stop(now + i * 0.025 + 0.16);
    });
  }

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

  playWin() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 987.77, 1046.50, 1318.51];
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);

      gain.gain.setValueAtTime(0.2, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.4);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.4);
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
    this.startNewGame();
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
      localStorage.setItem('loopnet_theme', next);
      try {
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
        this.startNewGame();
      });
    });

    this.dom.btnRestart.addEventListener('click', () => this.restartCurrentBoard());
    this.dom.btnHint.addEventListener('click', () => this.applyHint());
    this.dom.btnNewGame.addEventListener('click', () => this.startNewGame());
    this.dom.modalCloseBtn.addEventListener('click', () => {
      this.dom.modalOverlay.classList.remove('active');
      this.startNewGame();
    });

    this.dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.dom.modalOverlay) {
        this.dom.modalOverlay.classList.remove('active');
      }
    });
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

    // 3. 設定中心為水源/電源核心
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

        this.grid[r][c] = {
          targetMask,
          currentMask,
          rotationDeg: rotCount * 90,
          initialDeg: rotCount * 90,
          isPowered: false,
          isSource: (r === this.sourcePos.r && c === this.sourcePos.c)
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
    this.dom.movesText.textContent = '0';
    this.dom.gridBoard.classList.remove('is-won');

    this.stopTimer();
    this.timerSeconds = 0;
    this.dom.timerText.textContent = '00:00';

    this.generateBoard();
    this.renderBoard();
    this.updatePowerFlow(false);
    this.startTimer();
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
    this.dom.movesText.textContent = '0';
    this.renderBoard();
    this.updatePowerFlow(false);
  }

  startTimer() {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      const mins = Math.floor(this.timerSeconds / 60).toString().padStart(2, '0');
      const secs = (this.timerSeconds % 60).toString().padStart(2, '0');
      this.dom.timerText.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
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
        tile.className = `cell-tile ${cell.isSource ? 'is-source' : ''}`;
        tile.id = `cell-${r}-${c}`;
        tile.title = `點擊旋轉水管 (${r + 1}, ${c + 1})`;

        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'pipe-svg-wrapper';
        svgWrapper.style.transform = `rotate(${cell.rotationDeg}deg)`;

        svgWrapper.innerHTML = this.generatePipeSVG(cell.targetMask);
        tile.appendChild(svgWrapper);

        tile.addEventListener('click', () => this.handleCellClick(r, c));
        this.dom.gridBoard.appendChild(tile);
      }
    }
  }

  generatePipeSVG(mask) {
    let bgLines = '';
    let liquidLines = '';

    if (mask & this.DIR.UP) {
      bgLines += `<line class="pipe-line" x1="50" y1="50" x2="50" y2="0"/>`;
      liquidLines += `<line class="pipe-liquid" x1="50" y1="50" x2="50" y2="0"/>`;
    }
    if (mask & this.DIR.RIGHT) {
      bgLines += `<line class="pipe-line" x1="50" y1="50" x2="100" y2="50"/>`;
      liquidLines += `<line class="pipe-liquid" x1="50" y1="50" x2="100" y2="50"/>`;
    }
    if (mask & this.DIR.DOWN) {
      bgLines += `<line class="pipe-line" x1="50" y1="50" x2="50" y2="100"/>`;
      liquidLines += `<line class="pipe-liquid" x1="50" y1="50" x2="50" y2="100"/>`;
    }
    if (mask & this.DIR.LEFT) {
      bgLines += `<line class="pipe-line" x1="50" y1="50" x2="0" y2="50"/>`;
      liquidLines += `<line class="pipe-liquid" x1="50" y1="50" x2="0" y2="50"/>`;
    }

    bgLines += `<circle class="pipe-core" cx="50" cy="50" r="9"/>`;
    liquidLines += `<circle class="pipe-liquid-core" cx="50" cy="50" r="4.5"/>`;

    return `
      <svg class="pipe-svg" viewBox="0 0 100 100">
        ${bgLines}
        ${liquidLines}
      </svg>
    `;
  }

  /* ------------------------------------------------------------------------
     點擊旋轉與連通度檢測 (BFS Flow)
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

    // 2. 從電源/水源核心開始做 BFS 遍歷
    const queue = [[this.sourcePos.r, this.sourcePos.c]];
    this.grid[this.sourcePos.r][this.sourcePos.c].isPowered = true;
    let poweredCount = 0;

    while (queue.length > 0) {
      const [r, c] = queue.shift();
      poweredCount++;
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

    // 3. 連通數量增加時播放水流音效
    if (playSoundEffect && poweredCount > this.lastPoweredCount && poweredCount > 1) {
      this.sound.playFlow();
    }
    this.lastPoweredCount = poweredCount;

    // 4. 更新 DOM 通電/流動樣式
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
  }

  /* ------------------------------------------------------------------------
     通關獎勵與 Confetti 動畫
     ------------------------------------------------------------------------ */
  handleWin() {
    this.isWon = true;
    this.stopTimer();
    this.dom.gridBoard.classList.add('is-won');

    this.sound.playWin();
    this.triggerConfetti();

    setTimeout(() => {
      this.dom.modalTitle.textContent = '電力全開！⚡';
      this.dom.modalBody.innerHTML = `
        恭喜接通全網迴路！<br>
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
      color: ['#6366F1', '#10B981', '#F59E0B', '#38BDF8', '#EC4899'][Math.floor(Math.random() * 5)],
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
