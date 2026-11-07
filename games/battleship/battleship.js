/**
 * 海戰棋 Battleship - 核心遊戲引擎
 */

// 船艦配置定義
const SHIP_TYPES = [
  { id: 'carrier', name: '航空母艦', size: 5, icon: '🚢' },
  { id: 'battleship', name: '戰列艦', size: 4, icon: '🛳️' },
  { id: 'cruiser', name: '巡洋艦', size: 3, icon: '🚤' },
  { id: 'submarine', name: '潛水艇', size: 3, icon: '🧭' },
  { id: 'destroyer', name: '驅逐艦', size: 2, icon: '⛵' }
];

const BOARD_SIZE = 10;
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const STORAGE_KEY = 'bobo-battleship-saved-game-v1';

// 音效合成器 - 薄薄一層包在全站共用模組 BoboAudio 上。
// 瀏覽器樣板（AudioContext 延後到使用者手勢才建立、iOS 靜音 buffer 解鎖、
// 背景 suspend／前景與 'interrupted' 喚醒、每個節點都 stop + disconnect、
// 偏好持久化）全部由模組接管，這裡只留下海戰棋自己的音色。
//
// 注意：'battleship-muted' 這個舊 key 存的是「靜音」，與模組的 enabled 相反，
// 所以要 invert: true —— 老玩家的靜音偏好才不會被反過來。
//
// BoboAudio 缺席時整個類別安靜退場：遊戲照常能玩，只是沒有聲音。
class SoundFX {
  constructor() {
    this.kit = (typeof BoboAudio !== 'undefined' && BoboAudio)
      ? BoboAudio.create({ storageKey: 'battleship-muted', invert: true })
      : null;
  }

  /** 是否靜音（UI 沿用舊介面讀 muted，與模組的 enabled 相反） */
  get muted() {
    return this.kit ? !this.kit.enabled : false;
  }

  /** 切換靜音並持久化 @returns {boolean} 切換後是否靜音 */
  toggleMute() {
    if (!this.kit) return false;
    return !this.kit.toggle();
  }

  /** 聲納掃描：880 → 440 Hz 下滑 */
  playSonar() {
    if (!this.kit) return;
    this.kit.sweep({ from: 880, to: 440, type: 'sine', duration: 0.3, gain: 0.15, floor: 0.001 });
  }

  /** 發射砲彈：300 → 900 Hz 上滑（音量走線性衰減） */
  playLaunch() {
    if (!this.kit) return;
    this.kit.sweep({
      from: 300, to: 900, glide: 0.18, type: 'triangle',
      duration: 0.2, gain: 0.12, curve: 'linear', floor: 0.01
    });
  }

  /** 命中爆炸：低通濾波白噪，截止頻率 900 → 50 Hz */
  playHit() {
    if (!this.kit) return;
    this.kit.noise({
      duration: 0.35, gain: 0.4, floor: 0.01,
      filter: { type: 'lowpass', frequency: 900, to: 50 }
    });
  }

  /** 落空水花：160 → 90 Hz 悶響 */
  playMiss() {
    if (!this.kit) return;
    this.kit.sweep({ from: 160, to: 90, type: 'sine', duration: 0.22, gain: 0.2, floor: 0.01 });
  }

  /** 擊沉：兩聲間隔 0.22 秒的 520 → 280 Hz 線性下滑警報 */
  playSunk() {
    if (!this.kit) return;
    this.kit.chord(
      [{ from: 520, to: 280, delay: 0 }, { from: 520, to: 280, delay: 0.22 }],
      { type: 'sawtooth', duration: 0.18, gain: 0.16, freqCurve: 'linear', floor: 0.01 }
    );
  }

  /** 勝利：C 大三和弦琶音上行 */
  playVictory() {
    if (!this.kit) return;
    this.kit.chord(
      [523.25, 659.25, 783.99, 1046.50],
      { type: 'triangle', duration: 0.35, gain: 0.2, stagger: 0.12, floor: 0.001 }
    );
  }

  /** 落敗：四音下行 */
  playDefeat() {
    if (!this.kit) return;
    this.kit.chord(
      [440, 392, 349.23, 293.66],
      { type: 'sine', duration: 0.38, gain: 0.25, stagger: 0.16, floor: 0.001 }
    );
  }
}

// 智慧 AI 對手系統
class BattleAI {
  constructor(difficulty = 'medium') {
    this.difficulty = difficulty;
    this.reset();
  }

  reset() {
    this.targetQueue = [];
    this.currentHits = [];
    this.huntDirection = null;
    this.shotsFired = new Set();
  }

  setDifficulty(diff) {
    this.difficulty = diff;
  }

  toJSON() {
    return {
      difficulty: this.difficulty,
      targetQueue: this.targetQueue,
      currentHits: this.currentHits,
      huntDirection: this.huntDirection,
      shotsFired: Array.from(this.shotsFired)
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.difficulty = data.difficulty || 'medium';
    this.targetQueue = data.targetQueue || [];
    this.currentHits = data.currentHits || [];
    this.huntDirection = data.huntDirection || null;
    this.shotsFired = new Set(data.shotsFired || []);
  }

  getNextMove(playerBoard) {
    let target = null;

    if (this.difficulty === 'easy') {
      target = this.getRandomShot();
    } else if (this.difficulty === 'medium') {
      target = this.getHuntAndTargetMove(playerBoard);
    } else {
      target = this.getAdvancedMove(playerBoard);
    }

    if (target) {
      this.shotsFired.add(`${target.r},${target.c}`);
    }
    return target;
  }

  getRandomShot() {
    const available = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const key = `${r},${c}`;
        if (!this.shotsFired.has(key)) {
          available.push({ r, c });
        }
      }
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }

  getHuntAndTargetMove(playerBoard) {
    while (this.targetQueue.length > 0) {
      const candidate = this.targetQueue.shift();
      const key = `${candidate.r},${candidate.c}`;
      if (!this.shotsFired.has(key) && this.isValidCoord(candidate.r, candidate.c)) {
        return candidate;
      }
    }

    const parityShots = [];
    const regularShots = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const key = `${r},${c}`;
        if (!this.shotsFired.has(key)) {
          if ((r + c) % 2 === 0) {
            parityShots.push({ r, c });
          } else {
            regularShots.push({ r, c });
          }
        }
      }
    }

    if (parityShots.length > 0) {
      return parityShots[Math.floor(Math.random() * parityShots.length)];
    }
    if (regularShots.length > 0) {
      return regularShots[Math.floor(Math.random() * regularShots.length)];
    }
    return null;
  }

  getAdvancedMove(playerBoard) {
    const minShipLen = this.getSmallestAliveShipSize(playerBoard);

    while (this.targetQueue.length > 0) {
      const candidate = this.targetQueue.shift();
      const key = `${candidate.r},${candidate.c}`;
      if (!this.shotsFired.has(key) && this.isValidCoord(candidate.r, candidate.c)) {
        return candidate;
      }
    }

    const candidates = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const key = `${r},${c}`;
        if (!this.shotsFired.has(key) && (r + c) % 2 === 0) {
          const space = this.calculateFreeSpace(r, c);
          if (space >= minShipLen) {
            candidates.push({ r, c, weight: space });
          }
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.weight - a.weight);
      const topCount = Math.min(candidates.length, 3);
      return candidates[Math.floor(Math.random() * topCount)];
    }

    return this.getHuntAndTargetMove(playerBoard);
  }

  calculateFreeSpace(r, c) {
    let hSpace = 1;
    for (let col = c - 1; col >= 0 && !this.shotsFired.has(`${r},${col}`); col--) hSpace++;
    for (let col = c + 1; col < BOARD_SIZE && !this.shotsFired.has(`${r},${col}`); col++) hSpace++;

    let vSpace = 1;
    for (let row = r - 1; row >= 0 && !this.shotsFired.has(`${row},${c}`); row--) vSpace++;
    for (let row = r + 1; row < BOARD_SIZE && !this.shotsFired.has(`${row},${c}`); row++) vSpace++;

    return Math.max(hSpace, vSpace);
  }

  getSmallestAliveShipSize(playerBoard) {
    let minSize = 5;
    playerBoard.ships.forEach(ship => {
      if (!ship.isSunk && ship.size < minSize) {
        minSize = ship.size;
      }
    });
    return minSize;
  }

  recordShotResult(r, c, isHit, isSunk, sunkShip) {
    if (isHit) {
      this.currentHits.push({ r, c });

      if (isSunk) {
        this.currentHits = [];
        this.huntDirection = null;
        this.targetQueue = [];
      } else {
        this.updateTargetQueue();
      }
    }
  }

  updateTargetQueue() {
    if (this.currentHits.length === 1) {
      const { r, c } = this.currentHits[0];
      const neighbors = [
        { r: r - 1, c },
        { r: r + 1, c },
        { r, c: c - 1 },
        { r, c: c + 1 }
      ];
      this.targetQueue = neighbors.filter(n => 
        this.isValidCoord(n.r, n.c) && !this.shotsFired.has(`${n.r},${n.c}`)
      );
    } else if (this.currentHits.length >= 2) {
      const isHorizontal = this.currentHits[0].r === this.currentHits[1].r;
      const sorted = [...this.currentHits].sort((a, b) => 
        isHorizontal ? a.c - b.c : a.r - b.r
      );
      
      const newQueue = [];
      if (isHorizontal) {
        const row = sorted[0].r;
        const left = { r: row, c: sorted[0].c - 1 };
        const right = { r: row, c: sorted[sorted.length - 1].c + 1 };
        if (this.isValidCoord(left.r, left.c) && !this.shotsFired.has(`${left.r},${left.c}`)) newQueue.push(left);
        if (this.isValidCoord(right.r, right.c) && !this.shotsFired.has(`${right.r},${right.c}`)) newQueue.push(right);
      } else {
        const col = sorted[0].c;
        const top = { r: sorted[0].r - 1, c: col };
        const bottom = { r: sorted[sorted.length - 1].r + 1, c: col };
        if (this.isValidCoord(top.r, top.c) && !this.shotsFired.has(`${top.r},${top.c}`)) newQueue.push(top);
        if (this.isValidCoord(bottom.r, bottom.c) && !this.shotsFired.has(`${bottom.r},${bottom.c}`)) newQueue.push(bottom);
      }
      this.targetQueue = newQueue;
    }
  }

  isValidCoord(r, c) {
    return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
  }
}

// 艦隊棋盤管理類
class GameBoard {
  constructor() {
    this.ships = [];
    this.grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.shots = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  }

  reset() {
    this.ships = [];
    this.grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.shots = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  }

  toJSON() {
    return {
      ships: this.ships.map(s => ({
        id: s.id,
        name: s.name,
        size: s.size,
        isHorizontal: s.isHorizontal,
        positions: s.positions,
        hits: Array.from(s.hits),
        isSunk: s.isSunk
      })),
      grid: this.grid,
      shots: this.shots
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.grid = data.grid || Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.shots = data.shots || Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.ships = (data.ships || []).map(s => ({
      id: s.id,
      name: s.name,
      size: s.size,
      isHorizontal: s.isHorizontal,
      positions: s.positions || [],
      hits: new Set(s.hits || []),
      isSunk: !!s.isSunk
    }));
  }

  canPlaceShip(shipId, size, r, c, isHorizontal) {
    if (isHorizontal) {
      if (c + size > BOARD_SIZE) return false;
      for (let i = 0; i < size; i++) {
        if (this.grid[r][c + i] !== null && this.grid[r][c + i] !== shipId) return false;
      }
    } else {
      if (r + size > BOARD_SIZE) return false;
      for (let i = 0; i < size; i++) {
        if (this.grid[r + i][c] !== null && this.grid[r + i][c] !== shipId) return false;
      }
    }
    return true;
  }

  placeShip(shipDef, r, c, isHorizontal) {
    const { id, name, size } = shipDef;
    if (!this.canPlaceShip(id, size, r, c, isHorizontal)) return false;

    this.removeShip(id);

    const positions = [];
    for (let i = 0; i < size; i++) {
      const row = isHorizontal ? r : r + i;
      const col = isHorizontal ? c + i : c;
      this.grid[row][col] = id;
      positions.push({ r: row, c: col });
    }

    this.ships.push({
      id,
      name,
      size,
      isHorizontal,
      positions,
      hits: new Set(),
      isSunk: false
    });

    return true;
  }

  removeShip(shipId) {
    const idx = this.ships.findIndex(s => s.id === shipId);
    if (idx !== -1) {
      const ship = this.ships[idx];
      ship.positions.forEach(p => {
        this.grid[p.r][p.c] = null;
      });
      this.ships.splice(idx, 1);
    }
  }

  randomizeFleet() {
    this.reset();
    SHIP_TYPES.forEach(shipDef => {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 200) {
        const isHorizontal = Math.random() < 0.5;
        const r = Math.floor(Math.random() * BOARD_SIZE);
        const c = Math.floor(Math.random() * BOARD_SIZE);
        if (this.canPlaceShip(shipDef.id, shipDef.size, r, c, isHorizontal)) {
          this.placeShip(shipDef, r, c, isHorizontal);
          placed = true;
        }
        attempts++;
      }
    });
  }

  receiveAttack(r, c) {
    if (this.shots[r][c] !== null) {
      return { alreadyShot: true };
    }

    const shipId = this.grid[r][c];
    if (shipId) {
      this.shots[r][c] = 'hit';
      const ship = this.ships.find(s => s.id === shipId);
      ship.hits.add(`${r},${c}`);
      if (ship.hits.size === ship.size) {
        ship.isSunk = true;
      }
      return {
        hit: true,
        isSunk: ship.isSunk,
        ship
      };
    } else {
      this.shots[r][c] = 'miss';
      return { hit: false };
    }
  }

  allShipsSunk() {
    return this.ships.length === SHIP_TYPES.length && this.ships.every(s => s.isSunk);
  }

  getAliveShipsCount() {
    return this.ships.filter(s => !s.isSunk).length;
  }
}

// 戰績紀錄（勝敗場數、最佳命中率、最快勝利）
const RECORDS_KEY = 'bobo-battleship-records-v1';

// 盤面格子的無障礙標籤用的船名查表
const SHIP_NAME = Object.fromEntries(SHIP_TYPES.map(s => [s.id, s.name]));

// 是否開啟「減少動態效果」（JS 驅動的動態要自己看這個）
const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
};

const themeKit = () => ((typeof BoboTheme !== 'undefined' && BoboTheme) ? BoboTheme : null);

// 主遊戲控制器
class BattleshipGame {
  constructor() {
    this.sound = new SoundFX();
    this.ai = new BattleAI('medium');
    this.playerBoard = new GameBoard();
    this.enemyBoard = new GameBoard();

    this.gameState = 'placement';
    this.selectedShipId = null;
    this.isHorizontal = true;
    this.enemyTurnTimer = null;
    // 飛行中的砲彈：落點揭曉前，盤面先不顯示命中／落空（避免結果比砲彈先到）
    this.pendingShots = new Set();
    // 每開一局就加一，舊局還在飛的砲彈落地時發現世代不同就不處理
    this.round = 0;

    // 兩個盤面各自記住鍵盤焦點所在的格子（roving tabindex）
    this.focusPos = {
      player: { r: 0, c: 0 },
      enemy: { r: 0, c: 0 }
    };

    this.stats = {
      playerShots: 0,
      playerHits: 0,
      enemyShots: 0,
      enemyHits: 0,
      elapsedSeconds: 0,
      timerInterval: null
    };

    this.records = this.loadRecords();

    this.cacheDOM();
    this.bindEvents();
    this.init();
  }

  cacheDOM() {
    const byId = (id) => document.getElementById(id);
    this.dom = {
      soundToggle: byId('sound-toggle'),
      themeBtn: byId('theme-btn'),
      rulesBtn: byId('rules-btn'),
      rulesDialog: byId('rules-dialog'),
      rulesCloseBtn: byId('rules-close-btn'),
      playerGrid: byId('player-grid'),
      enemyGrid: byId('enemy-grid'),
      placementPanel: byId('placement-panel'),
      shipDock: byId('ship-dock'),
      rotateBtn: byId('rotate-btn'),
      randomBtn: byId('random-btn'),
      resetPlacementBtn: byId('reset-placement-btn'),
      startBattleBtn: byId('start-battle-btn'),
      diffBtns: document.querySelectorAll('.diff-btn'),
      statusDot: byId('status-dot'),
      statusText: byId('status-text'),
      phaseTag: byId('phase-tag'),
      playerAccuracy: byId('player-accuracy'),
      battleTime: byId('battle-time'),
      recordSummary: byId('record-summary'),
      replayBtn: byId('replay-btn'),
      playerBadges: byId('player-badges'),
      enemyBadges: byId('enemy-badges'),
      playerManifest: byId('player-manifest'),
      enemyManifest: byId('enemy-manifest'),
      playerFleetHealth: byId('player-fleet-health'),
      enemyFleetHealth: byId('enemy-fleet-health'),
    };
  }

  init() {
    const kit = themeKit();
    if (kit) kit.init();
    this.updateThemeButton();
    this.updateSoundToggleIcon();
    this.updateRecordSummary();
    this.buildGridDOM(this.dom.playerGrid, 'player');
    this.buildGridDOM(this.dom.enemyGrid, 'enemy');

    if (!this.loadGameState()) {
      this.startPlacementPhase();
    }
  }

  /* ---------- 存檔 ---------- */

  saveGameState() {
    try {
      const state = {
        gameState: this.gameState,
        difficulty: this.ai.difficulty,
        isHorizontal: this.isHorizontal,
        playerBoard: this.playerBoard.toJSON(),
        enemyBoard: this.enemyBoard.toJSON(),
        ai: this.ai.toJSON(),
        stats: {
          playerShots: this.stats.playerShots,
          playerHits: this.stats.playerHits,
          enemyShots: this.stats.enemyShots,
          enemyHits: this.stats.enemyHits,
          elapsedSeconds: this.stats.elapsedSeconds
        },
        timestamp: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  loadGameState() {
    let state = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      state = JSON.parse(raw);
    } catch (_) {
      return false;
    }
    if (!state || !state.gameState) return false;

    try {
      this.ai.fromJSON(state.ai);
      this.syncDifficultyButtons();

      this.playerBoard.fromJSON(state.playerBoard);
      this.enemyBoard.fromJSON(state.enemyBoard);
      this.isHorizontal = state.isHorizontal !== false;
      this.updateRotateLabel();

      this.stats.playerShots = state.stats?.playerShots || 0;
      this.stats.playerHits = state.stats?.playerHits || 0;
      this.stats.enemyShots = state.stats?.enemyShots || 0;
      this.stats.enemyHits = state.stats?.enemyHits || 0;
      this.stats.elapsedSeconds = state.stats?.elapsedSeconds || 0;

      this.gameState = state.gameState;

      if (this.gameState === 'placement') {
        this.showPlacementUI();
        this.setStatus('請配置艦隊陣型，完成後按「開始戰鬥」');
        this.renderShipDock();
        this.renderPlayerGrid();
        this.renderEnemyGrid();
        this.renderManifests();
        this.checkPlacementReady();
        this.updateAccuracy();
        this.updateTimerDisplay();
        return true;
      }

      if (this.gameState === 'player-turn' || this.gameState === 'enemy-turn') {
        this.dom.placementPanel.classList.add('hidden');
        this.startTimer();
        this.renderPlayerGrid();
        this.renderEnemyGrid();
        this.renderManifests();
        this.updateAccuracy();
        this.updateTimerDisplay();

        if (this.gameState === 'enemy-turn') {
          // 上次存檔時電腦正要開砲：重新整理後照樣輪到電腦，不讓玩家多打一發
          this.enterEnemyTurnUI();
          this.setStatus('繼續上次的對局：輪到敵方開砲…');
          this.enemyTurnTimer = setTimeout(() => this.executeEnemyTurn(), 500);
        } else {
          this.enterPlayerTurnUI();
          this.setStatus('繼續上次的對局：輪到你了，選一個敵方座標開砲。');
        }
        return true;
      }
    } catch (e) {
      console.warn('載入進度失敗:', e);
    }
    return false;
  }

  clearGameState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  loadRecords() {
    const empty = { wins: 0, losses: 0, bestAccuracy: null, fastestWin: null };
    try {
      const raw = localStorage.getItem(RECORDS_KEY);
      if (!raw) return empty;
      const data = JSON.parse(raw);
      return {
        wins: Number(data.wins) || 0,
        losses: Number(data.losses) || 0,
        bestAccuracy: Number.isFinite(data.bestAccuracy) ? data.bestAccuracy : null,
        fastestWin: Number.isFinite(data.fastestWin) ? data.fastestWin : null
      };
    } catch (_) {
      return empty;
    }
  }

  saveRecords() {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(this.records));
    } catch (_) {}
  }

  updateRecordSummary() {
    const { wins, losses } = this.records;
    this.dom.recordSummary.textContent = `${wins} 勝 ${losses} 敗`;
  }

  /* ---------- 盤面 DOM 與鍵盤 ---------- */

  buildGridDOM(container, type) {
    container.innerHTML = '';

    // 欄座標列：純視覺，每格的 aria-label 已經帶座標
    const headerRow = document.createElement('div');
    headerRow.className = 'grid-row';
    headerRow.setAttribute('aria-hidden', 'true');
    const corner = document.createElement('div');
    corner.className = 'coord-header';
    headerRow.appendChild(corner);
    for (let c = 1; c <= BOARD_SIZE; c++) {
      const colHeader = document.createElement('div');
      colHeader.className = 'coord-header';
      colHeader.textContent = c;
      headerRow.appendChild(colHeader);
    }
    container.appendChild(headerRow);

    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = document.createElement('div');
      row.className = 'grid-row';
      row.setAttribute('role', 'row');

      const rowHeader = document.createElement('div');
      rowHeader.className = 'coord-header';
      rowHeader.textContent = ROWS[r];
      rowHeader.setAttribute('aria-hidden', 'true');
      row.appendChild(rowHeader);

      for (let c = 0; c < BOARD_SIZE; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('role', 'gridcell');
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.dataset.type = type;
        cell.tabIndex = (r === 0 && c === 0) ? 0 : -1;
        row.appendChild(cell);
      }
      container.appendChild(row);
    }
  }

  getCell(type, r, c) {
    const grid = type === 'player' ? this.dom.playerGrid : this.dom.enemyGrid;
    return grid.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
  }

  // roving tabindex：整個盤面只留一格 tabIndex=0
  setRovingCell(type, r, c, focus) {
    const prev = this.focusPos[type];
    const prevCell = this.getCell(type, prev.r, prev.c);
    if (prevCell) prevCell.tabIndex = -1;
    this.focusPos[type] = { r, c };
    const cell = this.getCell(type, r, c);
    if (!cell) return;
    cell.tabIndex = 0;
    if (focus) cell.focus();
  }

  handleGridKeydown(e, type) {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    let r = parseInt(cell.dataset.row, 10);
    let c = parseInt(cell.dataset.col, 10);
    let moved = true;

    switch (e.key) {
      case 'ArrowUp': r = Math.max(0, r - 1); break;
      case 'ArrowDown': r = Math.min(BOARD_SIZE - 1, r + 1); break;
      case 'ArrowLeft': c = Math.max(0, c - 1); break;
      case 'ArrowRight': c = Math.min(BOARD_SIZE - 1, c + 1); break;
      case 'Home': c = 0; break;
      case 'End': c = BOARD_SIZE - 1; break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        moved = false;
        this.activateCell(type, r, c, 'keyboard');
        break;
      default:
        moved = false;
    }

    if (moved) {
      e.preventDefault();
      this.setRovingCell(type, r, c, true);
    }
  }

  activateCell(type, r, c, source) {
    if (type === 'enemy') {
      this.handlePlayerAttack(r, c);
      return;
    }
    if (this.gameState !== 'placement') return;

    if (!this.selectedShipId) {
      // 沒選船時，在已放好的船上按下 = 收回這艘船重放
      const shipId = this.playerBoard.grid[r][c];
      if (shipId) {
        this.pickUpShip(shipId);
        this.previewShipPlacement(r, c);
      } else {
        this.setStatus('先在船塢選一艘船，再選要放的位置。');
      }
      return;
    }

    this.tryPlaceSelectedShip(r, c, source);
  }

  tryPlaceSelectedShip(r, c, source) {
    const shipDef = SHIP_TYPES.find(s => s.id === this.selectedShipId);
    if (!shipDef) return;
    if (this.playerBoard.placeShip(shipDef, r, c, this.isHorizontal)) {
      this.sound.playSonar();
      this.selectedShipId = null;
      this.clearPlacementPreview();
      this.renderPlayerGrid();
      this.renderShipDock();
      this.checkPlacementReady();
      this.saveGameState();
      const left = SHIP_TYPES.length - this.playerBoard.ships.length;
      this.setStatus(left > 0
        ? `${shipDef.name}已就位（${ROWS[r]}${c + 1}），還有 ${left} 艘待部署。`
        : '五艘船都就位了，按「開始戰鬥」出航！');
      // 下一艘未部署的船自動選起來，鍵盤玩家不必跑回船塢
      const next = SHIP_TYPES.find(s => !this.playerBoard.ships.some(p => p.id === s.id));
      if (next && source === 'keyboard') {
        this.selectedShipId = next.id;
        this.renderShipDock();
        this.previewShipPlacement(r, c);
        this.setStatus(`${shipDef.name}已就位。接著放${next.name}（${next.size} 格）。`);
      }
    } else {
      // 放不下：紅色預覽停留一下，並說明原因
      this.previewShipPlacement(r, c);
      this.flashInvalid();
      this.setStatus(`${shipDef.name}放不下：超出海域或和其他船重疊，換個位置或按 R 旋轉。`);
    }
  }

  flashInvalid() {
    clearTimeout(this.invalidTimer);
    this.dom.playerGrid.classList.add('placement-error');
    this.invalidTimer = setTimeout(() => {
      this.dom.playerGrid.classList.remove('placement-error');
    }, 600);
  }

  pickUpShip(shipId) {
    this.playerBoard.removeShip(shipId);
    this.selectedShipId = shipId;
    this.renderPlayerGrid();
    this.renderShipDock();
    this.checkPlacementReady();
    this.sound.playSonar();
    this.saveGameState();
    this.setStatus(`已收回${SHIP_NAME[shipId]}，選一個新位置放下。`);
  }

  /* ---------- 事件 ---------- */

  bindEvents() {
    this.dom.soundToggle.addEventListener('click', () => {
      this.sound.toggleMute();
      this.updateSoundToggleIcon();
    });

    this.dom.themeBtn.addEventListener('click', () => {
      const kit = themeKit();
      if (kit) {
        kit.toggle();
      } else {
        const root = document.documentElement;
        root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      }
      this.updateThemeButton();
    });

    this.dom.rulesBtn.addEventListener('click', () => this.openDialog(this.dom.rulesDialog, this.dom.rulesCloseBtn));
    this.dom.rulesCloseBtn.addEventListener('click', () => this.dom.rulesDialog.close());

    this.dom.rotateBtn.addEventListener('click', () => this.rotate());

    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (this.gameState !== 'placement' || (e.key !== 'r' && e.key !== 'R')) return;
      // 對話框開著、或正在輸入時不攔截
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      this.rotate();
    });

    this.dom.randomBtn.addEventListener('click', () => {
      this.playerBoard.randomizeFleet();
      this.selectedShipId = null;
      this.clearPlacementPreview();
      this.renderPlayerGrid();
      this.renderShipDock();
      this.checkPlacementReady();
      this.sound.playSonar();
      this.saveGameState();
      this.setStatus('已隨機佈好五艘船，按「開始戰鬥」出航，或點船調整位置。');
    });

    this.dom.resetPlacementBtn.addEventListener('click', () => {
      this.playerBoard.reset();
      this.selectedShipId = SHIP_TYPES[0].id;
      this.clearPlacementPreview();
      this.renderPlayerGrid();
      this.renderShipDock();
      this.checkPlacementReady();
      this.sound.playSonar();
      this.saveGameState();
      this.setStatus(`船都收回船塢了。先放${SHIP_TYPES[0].name}（${SHIP_TYPES[0].size} 格）。`);
    });

    this.dom.startBattleBtn.addEventListener('click', () => {
      if (this.playerBoard.ships.length === SHIP_TYPES.length) {
        this.startCombatPhase();
      }
    });

    this.dom.diffBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.ai.setDifficulty(btn.dataset.diff);
        this.syncDifficultyButtons();
        this.sound.playSonar();
        this.saveGameState();
      });
    });

    // 盤面：pointerover 涵蓋滑鼠移動與觸控按下，觸控玩家也看得到落點預覽
    this.dom.playerGrid.addEventListener('pointerover', (e) => {
      if (this.gameState !== 'placement' || !this.selectedShipId) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      this.previewShipPlacement(+cell.dataset.row, +cell.dataset.col);
    });
    this.dom.playerGrid.addEventListener('pointerleave', (e) => {
      if (this.gameState === 'placement' && e.pointerType === 'mouse') this.clearPlacementPreview();
    });
    // 鍵盤焦點移動時也顯示預覽
    this.dom.playerGrid.addEventListener('focusin', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      this.focusPos.player = { r: +cell.dataset.row, c: +cell.dataset.col };
      if (this.gameState === 'placement' && this.selectedShipId) {
        this.previewShipPlacement(+cell.dataset.row, +cell.dataset.col);
      }
    });
    this.dom.enemyGrid.addEventListener('focusin', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      this.focusPos.enemy = { r: +cell.dataset.row, c: +cell.dataset.col };
    });

    this.dom.playerGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const r = +cell.dataset.row;
      const c = +cell.dataset.col;
      this.setRovingCell('player', r, c, false);
      this.activateCell('player', r, c, 'pointer');
    });

    this.dom.enemyGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const r = +cell.dataset.row;
      const c = +cell.dataset.col;
      this.setRovingCell('enemy', r, c, false);
      this.handlePlayerAttack(r, c);
    });

    this.dom.playerGrid.addEventListener('keydown', (e) => this.handleGridKeydown(e, 'player'));
    this.dom.enemyGrid.addEventListener('keydown', (e) => this.handleGridKeydown(e, 'enemy'));

    this.dom.replayBtn.addEventListener('click', () => this.restart());
  }

  openDialog(dialog, focusTarget) {
    if (!dialog) return;
    const opener = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    if (focusTarget) focusTarget.focus();
    const restore = () => {
      dialog.removeEventListener('close', restore);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus();
      }
    };
    dialog.addEventListener('close', restore);
  }

  restart() {
    if (typeof BoboCelebrate !== 'undefined') BoboCelebrate.close();
    this.clearGameState();
    this.startPlacementPhase();
    const firstShip = this.dom.shipDock.querySelector('.dock-ship');
    if (firstShip) firstShip.focus();
  }

  rotate() {
    this.isHorizontal = !this.isHorizontal;
    this.updateRotateLabel();
    this.sound.playSonar();
    const { r, c } = this.focusPos.player;
    if (this.selectedShipId) this.previewShipPlacement(r, c);
    this.setStatus(`船身方向：${this.isHorizontal ? '水平' : '垂直'}`);
    this.saveGameState();
  }

  updateRotateLabel() {
    this.dom.rotateBtn.textContent = `旋轉方向：${this.isHorizontal ? '水平' : '垂直'}`;
  }

  syncDifficultyButtons() {
    this.dom.diffBtns.forEach(b => {
      const on = b.dataset.diff === this.ai.difficulty;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  updateSoundToggleIcon() {
    const on = !this.sound.muted;
    this.dom.soundToggle.classList.toggle('muted', !on);
    this.dom.soundToggle.setAttribute('aria-pressed', String(on));
    this.dom.soundToggle.title = on ? '音效：開' : '音效：關';
  }

  updateThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    this.dom.themeBtn.setAttribute('aria-pressed', String(dark));
    this.dom.themeBtn.title = dark ? '深色模式：開' : '深色模式：關';
  }

  setStatus(text) {
    this.dom.statusText.textContent = text;
  }

  /* ---------- 階段 ---------- */

  // 佈陣時敵方海域不能開砲，整個移出 Tab 順序；開戰後恢復 roving 停點
  setEnemyGridTabbable(on) {
    this.dom.enemyGrid.querySelectorAll('.cell').forEach(cell => { cell.tabIndex = -1; });
    if (on) {
      const { r, c } = this.focusPos.enemy;
      const cell = this.getCell('enemy', r, c);
      if (cell) cell.tabIndex = 0;
    }
  }

  showPlacementUI() {
    this.setEnemyGridTabbable(false);
    this.dom.placementPanel.classList.remove('hidden');
    this.dom.replayBtn.hidden = true;
    this.dom.phaseTag.textContent = '佈陣階段';
    this.dom.statusDot.className = 'status-dot';
    this.dom.enemyGrid.parentElement.classList.remove('active-target');
    this.dom.playerGrid.parentElement.classList.remove('active-target');
    this.dom.enemyGrid.setAttribute('aria-disabled', 'true');
    this.dom.playerGrid.removeAttribute('aria-disabled');
  }

  enterPlayerTurnUI() {
    this.gameState = 'player-turn';
    this.dom.phaseTag.textContent = '輪到你';
    this.dom.statusDot.className = 'status-dot';
    this.dom.enemyGrid.parentElement.classList.add('active-target');
    this.dom.playerGrid.parentElement.classList.remove('active-target');
    // 用 aria-disabled 而非 disabled，焦點才不會在換手時掉到 body
    this.dom.enemyGrid.removeAttribute('aria-disabled');
    if (!this.dom.enemyGrid.querySelector('.cell[tabindex="0"]')) this.setEnemyGridTabbable(true);
  }

  enterEnemyTurnUI() {
    this.gameState = 'enemy-turn';
    this.dom.phaseTag.textContent = '敵方行動';
    this.dom.statusDot.className = 'status-dot enemy-turn';
    this.dom.enemyGrid.parentElement.classList.remove('active-target');
    this.dom.playerGrid.parentElement.classList.add('active-target');
    this.dom.enemyGrid.setAttribute('aria-disabled', 'true');
  }

  startPlacementPhase() {
    clearTimeout(this.enemyTurnTimer);
    this.round++;
    this.pendingShots.clear();
    document.querySelectorAll('.shell').forEach(el => el.remove());
    this.gameState = 'placement';
    this.playerBoard.reset();
    this.enemyBoard.reset();
    this.ai.reset();
    this.selectedShipId = null;
    this.clearIntervalTimer();

    this.playerBoard.randomizeFleet();

    this.showPlacementUI();
    this.setStatus('已先幫你隨機佈陣：可以直接按「開始戰鬥」，或點船調整位置。');
    this.dom.playerAccuracy.textContent = '0%';
    this.dom.battleTime.textContent = '00:00';

    this.stats = {
      playerShots: 0,
      playerHits: 0,
      enemyShots: 0,
      enemyHits: 0,
      elapsedSeconds: 0,
      timerInterval: null
    };

    this.renderShipDock();
    this.renderPlayerGrid();
    this.renderEnemyGrid();
    this.renderManifests();
    this.checkPlacementReady();
    this.saveGameState();
  }

  renderShipDock() {
    this.dom.shipDock.innerHTML = '';
    SHIP_TYPES.forEach(ship => {
      const placed = this.playerBoard.ships.some(s => s.id === ship.id);
      const selected = this.selectedShipId === ship.id;
      const dockShip = document.createElement('button');
      dockShip.type = 'button';
      dockShip.className = `dock-ship${placed ? ' placed' : ''}${selected ? ' selected' : ''}`;
      dockShip.dataset.id = ship.id;
      dockShip.setAttribute('aria-pressed', String(selected));
      dockShip.setAttribute('aria-label',
        `${ship.name}，${ship.size} 格，${placed ? '已部署，按下收回重放' : (selected ? '已選取' : '待部署')}`);

      const info = document.createElement('span');
      info.className = 'ship-info';
      info.innerHTML = `<span>${ship.name}</span><span>${ship.size} 格</span>`;
      info.setAttribute('aria-hidden', 'true');

      const preview = document.createElement('span');
      preview.className = 'ship-preview';
      preview.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < ship.size; i++) {
        const pCell = document.createElement('span');
        pCell.className = 'preview-cell';
        preview.appendChild(pCell);
      }

      dockShip.appendChild(info);
      dockShip.appendChild(preview);

      dockShip.addEventListener('click', () => {
        if (placed) {
          this.pickUpShip(ship.id);
        } else {
          this.selectedShipId = selected ? null : ship.id;
          this.renderShipDock();
          this.sound.playSonar();
          if (this.selectedShipId) {
            this.setStatus(`已選${ship.name}（${ship.size} 格），點我方海域放置。`);
          }
        }
        const again = this.dom.shipDock.querySelector(`[data-id="${ship.id}"]`);
        if (again) again.focus();
      });

      this.dom.shipDock.appendChild(dockShip);
    });
  }

  previewShipPlacement(r, c) {
    this.clearPlacementPreview();
    const shipDef = SHIP_TYPES.find(s => s.id === this.selectedShipId);
    if (!shipDef) return;

    const canPlace = this.playerBoard.canPlaceShip(shipDef.id, shipDef.size, r, c, this.isHorizontal);
    const className = canPlace ? 'preview-valid' : 'preview-invalid';

    for (let i = 0; i < shipDef.size; i++) {
      const row = this.isHorizontal ? r : r + i;
      const col = this.isHorizontal ? c + i : c;
      if (row < BOARD_SIZE && col < BOARD_SIZE) {
        const cell = this.getCell('player', row, col);
        if (cell) cell.classList.add(className);
      }
    }
  }

  clearPlacementPreview() {
    this.dom.playerGrid.querySelectorAll('.preview-valid, .preview-invalid')
      .forEach(cell => cell.classList.remove('preview-valid', 'preview-invalid'));
  }

  checkPlacementReady() {
    const allPlaced = this.playerBoard.ships.length === SHIP_TYPES.length;
    this.dom.startBattleBtn.disabled = !allPlaced;
  }

  startCombatPhase() {
    this.dom.placementPanel.classList.add('hidden');
    this.clearPlacementPreview();
    this.selectedShipId = null;

    this.enemyBoard.randomizeFleet();

    this.stats.playerShots = 0;
    this.stats.playerHits = 0;
    this.stats.enemyShots = 0;
    this.stats.enemyHits = 0;
    this.stats.elapsedSeconds = 0;

    this.startTimer();
    this.enterPlayerTurnUI();
    this.setStatus('開戰！輪到你了，選一個敵方座標開砲。');

    this.renderPlayerGrid();
    this.renderEnemyGrid();
    this.renderManifests();
    this.sound.playLaunch();
    this.saveGameState();

    // 鍵盤玩家直接進入敵方海域
    this.setRovingCell('enemy', this.focusPos.enemy.r, this.focusPos.enemy.c, true);
  }

  startTimer() {
    this.clearIntervalTimer();
    this.stats.timerInterval = setInterval(() => {
      this.stats.elapsedSeconds++;
      this.updateTimerDisplay();
      if (this.stats.elapsedSeconds % 5 === 0) {
        this.saveGameState();
      }
    }, 1000);
  }

  updateTimerDisplay() {
    this.dom.battleTime.textContent = this.formatTime(this.stats.elapsedSeconds);
  }

  formatTime(seconds) {
    const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
    const secs = String(seconds % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  clearIntervalTimer() {
    if (this.stats.timerInterval) {
      clearInterval(this.stats.timerInterval);
      this.stats.timerInterval = null;
    }
  }

  // 玩家開火：判定與存檔立即完成；畫面上砲彈從我方海域飛向目標，落地才揭曉命中或落空
  handlePlayerAttack(r, c) {
    const coordName = `${ROWS[r]}${c + 1}`;
    if (this.gameState === 'enemy-turn') {
      this.setStatus('敵方正在開砲，請稍等。');
      return;
    }
    if (this.gameState !== 'player-turn') return;
    const res = this.enemyBoard.receiveAttack(r, c);
    if (res.alreadyShot) {
      this.setStatus(`${coordName} 已經打過了，換一格。`);
      return;
    }

    this.stats.playerShots++;
    if (res.hit) this.stats.playerHits++;
    const victory = this.enemyBoard.allShipsSunk();

    if (victory) {
      // 最後一發：先鎖住盤面，等砲彈落地再宣布勝利
      this.gameState = 'resolving';
      this.dom.enemyGrid.setAttribute('aria-disabled', 'true');
    } else {
      // 先切換狀態再存檔：重新整理時才會接著讓電腦開砲（修正重整多打一發的漏洞）
      this.enterEnemyTurnUI();
      this.saveGameState();
    }

    const key = `enemy:${r},${c}`;
    this.pendingShots.add(key);
    this.renderEnemyGrid();

    this.launchShell(this.dom.playerGrid, this.dom.enemyGrid, r, c, () => {
      this.pendingShots.delete(key);
      if (res.hit) {
        if (res.isSunk) {
          this.sound.playSunk();
          this.setStatus(`擊沉敵方${res.ship.name}（${coordName}）！`);
        } else {
          this.sound.playHit();
          this.setStatus(`命中（${coordName}）！`);
        }
      } else {
        this.sound.playMiss();
        this.setStatus(`${coordName} 落空。`);
      }
      this.updateAccuracy();
      this.renderEnemyGrid();
      this.renderManifests();
      this.playLandingEffect(this.dom.enemyGrid, r, c, res);

      if (victory) {
        this.handleGameOver('victory');
        return;
      }
      this.enemyTurnTimer = setTimeout(() => this.executeEnemyTurn(), 450);
    });
  }

  // 電腦回合：一樣先判定，砲彈從敵方海域飛過來，落地才揭曉並換手
  executeEnemyTurn() {
    if (this.gameState !== 'enemy-turn') return;

    const move = this.ai.getNextMove(this.playerBoard);
    if (!move) return;

    const { r, c } = move;
    const res = this.playerBoard.receiveAttack(r, c);
    this.stats.enemyShots++;
    if (res.hit) this.stats.enemyHits++;

    this.ai.recordShotResult(r, c, res.hit, res.isSunk, res.ship);
    const coordName = `${ROWS[r]}${c + 1}`;
    const key = `player:${r},${c}`;
    this.pendingShots.add(key);
    this.renderPlayerGrid();

    this.launchShell(this.dom.enemyGrid, this.dom.playerGrid, r, c, () => {
      this.pendingShots.delete(key);
      let message;
      if (res.hit) {
        if (res.isSunk) {
          this.sound.playSunk();
          message = `我方${res.ship.name}被擊沉（${coordName}）！`;
        } else {
          this.sound.playHit();
          message = `我方船艦在 ${coordName} 中彈！`;
        }
      } else {
        this.sound.playMiss();
        message = `敵方砲火落在 ${coordName}，沒打中。`;
      }

      this.renderPlayerGrid();
      this.renderManifests();
      this.playLandingEffect(this.dom.playerGrid, r, c, res);

      if (this.playerBoard.allShipsSunk()) {
        this.setStatus(message);
        this.handleGameOver('defeat');
        return;
      }

      this.enterPlayerTurnUI();
      this.setStatus(`${message}輪到你了。`);
      this.saveGameState();
    });
  }

  // 砲彈飛行：從開砲方海域的中心飛到目標格，中段放大做出拋物線的感覺。
  // 減少動態效果或瀏覽器不支援時不飛，直接落地（同步呼叫 onLand）。
  launchShell(fromGrid, toGrid, r, c, onLand) {
    const cell = toGrid.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
    if (!cell || prefersReducedMotion() || typeof cell.animate !== 'function') {
      onLand();
      return;
    }
    const from = fromGrid.getBoundingClientRect();
    const to = cell.getBoundingClientRect();
    const ex = to.left + to.width / 2;
    const ey = to.top + to.height / 2;
    const dx = from.left + from.width / 2 - ex;
    const dy = from.top + from.height / 2 - ey;
    // 距離越遠飛越久，但控制在 220–380ms，不讓玩家覺得在等
    const duration = Math.round(Math.min(380, Math.max(220, Math.hypot(dx, dy) * 0.5)));

    const shell = document.createElement('span');
    shell.className = 'shell';
    shell.setAttribute('aria-hidden', 'true');
    shell.style.left = `${ex}px`;
    shell.style.top = `${ey}px`;
    document.body.appendChild(shell);

    const generation = this.round;
    const anim = shell.animate([
      { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0 },
      { transform: `translate(-50%, -50%) translate(${dx * 0.85}px, ${dy * 0.85}px) scale(0.9)`, opacity: 1, offset: 0.15 },
      { transform: `translate(-50%, -50%) translate(${dx * 0.45}px, ${dy * 0.45}px) scale(1.45)`, offset: 0.55 },
      { transform: 'translate(-50%, -50%) scale(0.7)', opacity: 1 }
    ], { duration, easing: 'cubic-bezier(0.4, 0, 0.9, 0.6)' });
    anim.onfinish = () => {
      shell.remove();
      if (generation === this.round) onLand();
    };
    anim.oncancel = () => shell.remove();
  }

  // 落地效果：命中、落空、擊沉各不相同（減少動態效果時由 CSS 改成只變色）
  playLandingEffect(gridEl, r, c, res) {
    const cellAt = (row, col) => gridEl.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    const restartClass = (el, cls) => {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
      el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
    };
    if (res.isSunk && res.ship && Array.isArray(res.ship.positions)) {
      // 擊沉：整艘船從落點往外一格一格閃過去
      const ordered = [...res.ship.positions]
        .sort((a, b) => (Math.abs(a.r - r) + Math.abs(a.c - c)) - (Math.abs(b.r - r) + Math.abs(b.c - c)));
      ordered.forEach((pos, index) => {
        const el = cellAt(pos.r, pos.c);
        if (!el) return;
        el.style.animationDelay = `${index * 55}ms`;
        restartClass(el, 'sunk-flash');
        el.addEventListener('animationend', () => { el.style.animationDelay = ''; }, { once: true });
      });
    } else if (res.hit) {
      this.triggerCellImpact(gridEl, r, c);
    } else {
      restartClass(cellAt(r, c), 'miss-splash');
    }
  }

  updateAccuracy() {
    if (this.stats.playerShots === 0) {
      this.dom.playerAccuracy.textContent = '0%';
      return;
    }
    const acc = Math.round((this.stats.playerHits / this.stats.playerShots) * 100);
    this.dom.playerAccuracy.textContent = `${acc}%`;
  }

  triggerCellImpact(gridEl, r, c) {
    const cell = gridEl.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
    if (!cell) return;
    cell.classList.add('hit-impact');
    setTimeout(() => cell.classList.remove('hit-impact'), 380);
  }

  handleGameOver(result) {
    clearTimeout(this.enemyTurnTimer);
    this.gameState = 'game-over';
    this.clearIntervalTimer();
    this.clearGameState();
    this.dom.statusDot.className = 'status-dot game-over';
    this.dom.phaseTag.textContent = result === 'victory' ? '勝利' : '戰敗';
    this.dom.enemyGrid.setAttribute('aria-disabled', 'true');
    this.dom.enemyGrid.parentElement.classList.remove('active-target');
    this.dom.playerGrid.parentElement.classList.remove('active-target');
    this.dom.replayBtn.hidden = false;

    const acc = this.stats.playerShots > 0
      ? Math.round((this.stats.playerHits / this.stats.playerShots) * 100) : 0;

    // 更新戰績
    const isNewBest = result === 'victory' && this.records.wins > 0
      && (this.records.bestAccuracy === null || acc > this.records.bestAccuracy);
    if (result === 'victory') {
      this.records.wins++;
      if (this.records.bestAccuracy === null || acc > this.records.bestAccuracy) this.records.bestAccuracy = acc;
      if (this.records.fastestWin === null || this.stats.elapsedSeconds < this.records.fastestWin) {
        this.records.fastestWin = this.stats.elapsedSeconds;
      }
    } else {
      this.records.losses++;
    }
    this.saveRecords();
    this.updateRecordSummary();

    // 共用過關卡片：勝利附彩帶，戰敗用虛線色帶；關掉後焦點回到戰況列的「再來一局」
    const fastest = this.records.fastestWin;
    const cardStats = [
      { label: '命中率', value: `${acc}%`, isBest: isNewBest },
      { label: '消耗彈藥', value: `${this.stats.playerShots} 發` },
      { label: '作戰耗時', value: this.formatTime(this.stats.elapsedSeconds),
        isBest: result === 'victory' && fastest === this.stats.elapsedSeconds && this.records.wins > 1 }
    ];
    const recordLine = `目前戰績 ${this.records.wins} 勝 ${this.records.losses} 敗。`;
    const show = () => {
      if (this.gameState !== 'game-over' || typeof BoboCelebrate === 'undefined') {
        this.dom.replayBtn.focus();
        return;
      }
      BoboCelebrate.show({
        outcome: result === 'victory' ? 'win' : 'lose',
        gameName: 'Battleship 海戰棋',
        title: result === 'victory' ? '海上大捷！' : '艦隊覆沒',
        subtitle: (result === 'victory'
          ? (isNewBest ? `命中率 ${acc}%，刷新你的最佳紀錄！` : '敵方艦隊全數沉沒。')
          : '這次被搶先一步。換個陣型，再戰一次吧！') + recordLine,
        stats: cardStats,
        accent: '#8a5a00',
        accentDark: '#e0b04a',
        primary: { label: '再來一局', onClick: () => this.restart() },
        secondary: { label: '看盤面' },
        returnFocus: this.dom.replayBtn
      });
    };

    if (result === 'victory') {
      this.sound.playVictory();
      this.setStatus('勝利！敵方艦隊全數沉沒。');
    } else {
      this.sound.playDefeat();
      this.setStatus('戰敗：我方艦隊全數沉沒。');
    }
    // 讓最後一發的落地效果演完再出卡片
    setTimeout(show, prefersReducedMotion() ? 0 : 600);
  }

  /* ---------- 渲染 ---------- */

  renderPlayerGrid() {
    const cells = this.dom.playerGrid.querySelectorAll('.cell');
    cells.forEach(cell => {
      const r = +cell.dataset.row;
      const c = +cell.dataset.col;
      const keepImpact = cell.classList.contains('hit-impact');
      cell.className = 'cell';
      if (keepImpact) cell.classList.add('hit-impact');
      const shipId = this.playerBoard.grid[r][c];
      const shot = this.playerBoard.shots[r][c];
      const coord = `${ROWS[r]}${c + 1}`;
      let label;

      if (shipId) cell.classList.add('has-ship', 'ship-body');
      if (this.pendingShots.has(`player:${r},${c}`)) cell.classList.add('awaiting-shot');

      if (shot === 'hit') {
        const ship = this.playerBoard.ships.find(s => s.id === shipId);
        if (ship && ship.isSunk) {
          cell.classList.add('sunk');
          label = `${coord}，我方${SHIP_NAME[shipId]}已沉沒`;
        } else {
          cell.classList.add('hit');
          label = `${coord}，我方${SHIP_NAME[shipId]}中彈`;
        }
      } else if (shot === 'miss') {
        cell.classList.add('miss');
        label = `${coord}，敵方砲彈落空`;
      } else if (shipId) {
        label = `${coord}，我方${SHIP_NAME[shipId]}`;
      } else {
        label = `${coord}，空海域`;
      }
      cell.setAttribute('aria-label', label);
    });
  }

  renderEnemyGrid() {
    const cells = this.dom.enemyGrid.querySelectorAll('.cell');
    cells.forEach(cell => {
      const r = +cell.dataset.row;
      const c = +cell.dataset.col;
      const keepImpact = cell.classList.contains('hit-impact');
      cell.className = 'cell';
      if (keepImpact) cell.classList.add('hit-impact');
      const shot = this.enemyBoard.shots[r][c];
      const shipId = this.enemyBoard.grid[r][c];
      const coord = `${ROWS[r]}${c + 1}`;
      let label = `${coord}，未射擊`;
      if (this.pendingShots.has(`enemy:${r},${c}`)) cell.classList.add('awaiting-shot');

      if (shot === 'hit') {
        const ship = this.enemyBoard.ships.find(s => s.id === shipId);
        if (ship && ship.isSunk) {
          cell.classList.add('sunk');
          label = `${coord}，擊沉${SHIP_NAME[shipId]}`;
        } else {
          cell.classList.add('hit');
          label = `${coord}，命中`;
        }
      } else if (shot === 'miss') {
        cell.classList.add('miss');
        label = `${coord}，落空`;
      }
      cell.setAttribute('aria-label', label);
    });
  }

  renderManifests() {
    this.renderBadges(this.dom.playerBadges, this.playerBoard, '我方');
    this.renderBadges(this.dom.enemyBadges, this.enemyBoard, '敵方');

    this.renderSingleManifest(this.dom.playerManifest, this.playerBoard, false);
    this.renderSingleManifest(this.dom.enemyManifest, this.enemyBoard, true);

    // 佈陣階段敵方還沒下船，顯示滿編而不是 0
    const alive = (board) => (board.ships.length ? board.getAliveShipsCount() : SHIP_TYPES.length);
    this.dom.playerFleetHealth.textContent = `我艦存活：${alive(this.playerBoard)} / 5`;
    this.dom.enemyFleetHealth.textContent = `敵艦存活：${alive(this.enemyBoard)} / 5`;
  }

  renderBadges(container, board, side) {
    if (!container) return;
    container.innerHTML = '';
    const alive = [];
    SHIP_TYPES.forEach(shipDef => {
      const ship = board.ships.find(s => s.id === shipDef.id);
      const isSunk = ship ? ship.isSunk : false;
      if (!isSunk) alive.push(shipDef.name);
      const badge = document.createElement('span');
      badge.className = `fleet-badge${isSunk ? ' sunk' : ''}`;
      badge.textContent = shipDef.icon;
      badge.title = `${shipDef.name}（${shipDef.size} 格）${isSunk ? '已擊沉' : '存活'}`;
      container.appendChild(badge);
    });
    container.setAttribute('aria-label', `${side}艦隊存活 ${alive.length} 艘`);
  }

  renderSingleManifest(container, board, isEnemy) {
    if (!container) return;
    container.innerHTML = '';
    SHIP_TYPES.forEach(shipDef => {
      const ship = board.ships.find(s => s.id === shipDef.id);
      const isSunk = ship ? ship.isSunk : false;
      const hitCount = ship ? ship.hits.size : 0;

      const item = document.createElement('div');
      item.className = `manifest-item${isSunk ? ' sunk' : ''}`;

      const name = document.createElement('span');
      name.textContent = `${shipDef.icon} ${shipDef.name}${isSunk ? '（已沉沒）' : ''}`;

      const pegs = document.createElement('div');
      pegs.className = 'manifest-pegs';
      pegs.setAttribute('aria-hidden', 'true');

      for (let i = 0; i < shipDef.size; i++) {
        const peg = document.createElement('span');
        if (isEnemy) {
          peg.className = `peg ${isSunk ? 'sunk-peg' : 'fog-peg'}`;
        } else {
          peg.className = `peg ${i < hitCount ? 'hit' : ''}`;
        }
        pegs.appendChild(peg);
      }

      item.appendChild(name);
      item.appendChild(pegs);
      container.appendChild(item);
    });
  }
}

// 頁面初始化
document.addEventListener('DOMContentLoaded', () => {
  window.battleshipGame = new BattleshipGame();
});
