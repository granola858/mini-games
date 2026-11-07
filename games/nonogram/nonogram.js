let size = 8;
    // 預設難度在下方常數區從 NonogramCore 取得後才指派，避免暫時性死區。
    let difficulty;
    let currentAction = 'fill';
    let gameStates = {};
    let themeColor = '#FFB7F1';
    let darkMode = false;

    let isDragging = false;
    let dragAction = null;
    let dragSnapshot = null;
    let dragHistoryCommitted = false;
    let actionHistory = [];
    let lastSavedAt = 0;
    // 存檔版本號：每次寫入都以 max(本地, 存檔) + 1 遞增，取代 Date.now() 當權威，
    // 避免背景分頁／bfcache 舊文件靠「寫得比較晚」搶走主導權。
    let saveRevision = 0;
    // 這個文件自上次寫入後真的改動過的盤面槽位，只有它們會被標記成新版本。
    const dirtySlotKeys = new Set();

    let isBoardLocked = false;
    let wakeLockSentinel = null;
    let isWakeLockEnabled = false;
    // 「塗黑／標記 Ｏ」切換列可以在設定裡收起；收起時點格子一律塗黑
    let isMarkToolVisible = true;

    const SAVE_KEY = 'nonogram_save_data';
    // 戰績與圖案收集進度另存一把 key：跟盤面存檔的多分頁合併邏輯無關，讀寫都獨立包 try/catch。
    const STATS_KEY = 'nonogram_stats_v1';
    const ALLOWED_SIZES = [8, 10, 12];
    const DEFAULT_THEME_COLOR = '#FFB7F1';
    const PRIMARY_DARK_TEXT = '#13212F';
    const LIGHT_SURFACE_COLOR = '#FFFFFF';
    const DARK_SURFACE_COLOR = '#0F141C';
    // 深色模式下會承載主題色文字的底色：頁面、卡片／分段按鈕、格子、靜音底
    const DARK_SURFACES = [DARK_SURFACE_COLOR, '#1A212C', '#202837', '#232C3B'];
    const SHARED_SEED_PREFIX = 'NGM';
    const HINT_LIMIT = 3; // 每一局可用的提示次數，清空盤面或返回上一步都不會退還
    const RESULT_STATE = {
      IN_PROGRESS: 'in-progress',
      WIN: 'win',
      REVEALED: 'revealed',
      COMPLETED: 'completed'
    };
    // 純邏輯（題目生成、線解推理、難度評分）都在 nonogram-core.js，
    // 這裡解構成區域別名，既有呼叫點就不必逐一改寫。
    const {
      getClues,
      cloneGrid,
      createEmptyPlayerState,
      buildCluesFromSolution,
      countSolutions,
      areClueLinesEqual,
      isValidMatrix,
      isValidClueSet,
      normalizeDifficultyChoice,
      DIFFICULTY_CHOICES,
      DEFAULT_DIFFICULTY,
      RANDOM_DIFFICULTY
    } = NonogramCore;

    difficulty = DEFAULT_DIFFICULTY;

    // 「圖案」模式沿用同一套槽位機制：槽位 key 是「尺寸 x picture」，存檔格式不必另開欄位。
    const PICTURE_MODE = NonogramCore.PICTURE_MODE;
    const SLOT_CHOICES = [...DIFFICULTY_CHOICES, PICTURE_MODE];
    // 切回隨機模式時要回到玩家上次選的難度，所以另外記住
    let lastRandomDifficulty = DEFAULT_DIFFICULTY;

    function normalizeSlotChoice(value) {
      return SLOT_CHOICES.includes(value) ? value : DEFAULT_DIFFICULTY;
    }

    function isPictureMode() {
      return difficulty === PICTURE_MODE;
    }

    const DIFFICULTY_LABELS = {
      easy: '簡單',
      medium: '中等',
      hard: '困難',
      random: '隨機'
    };

    // 每個「盤面尺寸 × 難度」是一個獨立槽位，各自保存一局進度。
    // 「隨機」也是一個槽位：否則抽到的難度會蓋掉該難度槽位裡進行中的那一局。
    const ALLOWED_SLOTS = ALLOWED_SIZES.flatMap(allowedSize =>
      SLOT_CHOICES.map(allowedDifficulty => ({
        size: allowedSize,
        difficulty: allowedDifficulty,
        key: getSlotKey(allowedSize, allowedDifficulty)
      }))
    );

    const sizeSelect = document.getElementById('size-select');
    const difficultySelect = document.getElementById('difficulty-select');
    const actionBtns = document.querySelectorAll('#action-toggle .action-btn');
    const actionToggle = document.getElementById('action-toggle');
    const topMsg = document.getElementById('top-msg');
    const boardEl = document.getElementById('board');
    const mainActions = document.getElementById('main-actions');
    const checkBtn = document.getElementById('check-btn');
    const hintBtn = document.getElementById('hint-btn');
    const hintMsg = document.getElementById('hint-msg');
    const hintCount = document.getElementById('hint-count');
    const newGameBtn = document.getElementById('new-game-btn');
    const undoBtn = document.getElementById('undo-btn');
    const clearBoardBtn = document.getElementById('clear-board-btn');
    const resultBox = document.getElementById('result-box');
    const resultBtns = document.getElementById('result-btns');
    const confirmDialog = document.getElementById('confirm-dialog');
    const confirmTitle = document.getElementById('confirm-title');
    const confirmMessage = document.getElementById('confirm-message');
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    const confirmOkBtn = document.getElementById('confirm-ok-btn');
    const menuBtn = document.getElementById('menu-btn');
    const menuPanel = document.getElementById('menu-panel');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const paletteBtns = document.querySelectorAll('.palette-swatch');
    const customColorInput = document.getElementById('custom-color-input');
    const currentSeedOutput = document.getElementById('current-seed-output');
    const copySeedBtn = document.getElementById('copy-seed-btn');
    const seedInput = document.getElementById('seed-input');
    const loadSeedBtn = document.getElementById('load-seed-btn');
    const seedFeedback = document.getElementById('seed-feedback');
    const boardLockBtn = document.getElementById('board-lock-btn');
    const wakeLockCheckbox = document.getElementById('wake-lock-checkbox');
    const wakeLockNote = document.getElementById('wake-lock-note');
    const markToolCheckbox = document.getElementById('mark-tool-checkbox');
    const modeBtns = document.querySelectorAll('#mode-toggle .mode-btn');
    const difficultyGroup = document.getElementById('difficulty-group');
    const pictureGroup = document.getElementById('picture-group');
    const pictureProgress = document.getElementById('picture-progress');
    const srStatus = document.getElementById('sr-status');
    const rulesBtn = document.getElementById('rules-btn');
    const rulesDialog = document.getElementById('rules-dialog');
    const rulesCloseBtn = document.getElementById('rules-close-btn');
    const themeKit = (typeof BoboTheme !== 'undefined') ? BoboTheme : null;

    // 全頁唯一的播報出口；先清空再寫入，同一句話連續出現也會再念一次
    function announce(message) {
      if (!srStatus) return;
      srStatus.textContent = '';
      window.setTimeout(() => { srStatus.textContent = message; }, 30);
    }

    // --- 戰績與圖案收集 (Stats) ---
    function readStats() {
      const empty = { wins: 0, solvedPictures: [], lastPicture: {} };
      try {
        const raw = localStorage.getItem(STATS_KEY);
        if (!raw) return empty;
        const parsed = JSON.parse(raw);
        const known = new Set(NonogramCore.PICTURES.map(picture => picture.id));
        return {
          wins: Number.isInteger(parsed?.wins) && parsed.wins > 0 ? parsed.wins : 0,
          solvedPictures: Array.isArray(parsed?.solvedPictures)
            ? parsed.solvedPictures.filter(id => known.has(id))
            : [],
          lastPicture: parsed && typeof parsed.lastPicture === 'object' && parsed.lastPicture ? parsed.lastPicture : {}
        };
      } catch (error) {
        return empty;
      }
    }

    function writeStats(stats) {
      try {
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
      } catch (error) {
        console.warn('Unable to save Nonogram stats', error);
      }
    }


    function isValidHexColor(value) {
      return /^#[0-9A-F]{6}$/i.test(value || '');
    }

    function normalizeThemeColor(value) {
      return isValidHexColor(value) ? value.toUpperCase() : DEFAULT_THEME_COLOR;
    }

    function hexToRgb(value) {
      const normalized = normalizeThemeColor(value).slice(1);
      return {
        r: parseInt(normalized.slice(0, 2), 16),
        g: parseInt(normalized.slice(2, 4), 16),
        b: parseInt(normalized.slice(4, 6), 16)
      };
    }

    function hexToRgba(value, alpha) {
      const { r, g, b } = hexToRgb(value);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function toHexChannel(value) {
      return Math.round(value).toString(16).padStart(2, '0').toUpperCase();
    }

    function mixHexColors(start, end, amount) {
      const startRgb = hexToRgb(start);
      const endRgb = hexToRgb(end);
      const ratio = Math.min(1, Math.max(0, amount));
      return `#${toHexChannel(startRgb.r + (endRgb.r - startRgb.r) * ratio)}${toHexChannel(startRgb.g + (endRgb.g - startRgb.g) * ratio)}${toHexChannel(startRgb.b + (endRgb.b - startRgb.b) * ratio)}`;
    }

    function toLinearChannel(channel) {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }

    function getRelativeLuminance(value) {
      const { r, g, b } = hexToRgb(value);
      return 0.2126 * toLinearChannel(r) + 0.7152 * toLinearChannel(g) + 0.0722 * toLinearChannel(b);
    }

    function getContrastRatio(foreground, background) {
      const lighter = Math.max(getRelativeLuminance(foreground), getRelativeLuminance(background));
      const darker = Math.min(getRelativeLuminance(foreground), getRelativeLuminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    }

    function getPrimaryContrastColor(value) {
      const { r, g, b } = hexToRgb(value);
      const yiq = (r * 299 + g * 587 + b * 114) / 1000;
      return yiq >= 165 ? PRIMARY_DARK_TEXT : LIGHT_SURFACE_COLOR;
    }

    // 淺色模式下把主題色在 HSL 中逐步調暗（保留色相與飽和度），
    // 直到在白底與淺灰卡片底（#FAFAFA）上都達到 4.5:1，給文字與外框使用。
    function getDarkenedReadableColor(value) {
      const surfaces = [LIGHT_SURFACE_COLOR, '#FAFAFA'];
      const passes = color => surfaces.every(surface => getContrastRatio(color, surface) >= 4.5);
      if (passes(value)) return value;

      const { r, g, b } = hexToRgb(value);
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      const delta = max - min;
      let h = 0;
      if (delta) {
        if (max === rn) h = ((gn - bn) / delta) % 6;
        else if (max === gn) h = (bn - rn) / delta + 2;
        else h = (rn - gn) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      let l = (max + min) / 2;
      const sat = delta ? delta / (1 - Math.abs(2 * l - 1)) : 0;

      const fromHsl = lightness => {
        const c = (1 - Math.abs(2 * lightness - 1)) * sat;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = lightness - c / 2;
        const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
        return `#${toHexChannel((r1 + m) * 255)}${toHexChannel((g1 + m) * 255)}${toHexChannel((b1 + m) * 255)}`;
      };

      while (l > 0) {
        l = Math.max(0, l - 0.02);
        const candidate = fromHsl(l);
        if (passes(candidate)) return candidate;
      }
      return PRIMARY_DARK_TEXT;
    }

    function getReadableAccentColor(value) {
      if (!darkMode) return getDarkenedReadableColor(value);

      // 深色模式的文字會出現在頁面底、卡片底、格子底與分段按鈕底上，全部都要 ≥ 4.5:1
      const passesDark = color => DARK_SURFACES.every(surface => getContrastRatio(color, surface) >= 4.5);
      if (passesDark(value)) {
        return value;
      }

      for (let step = 1; step <= 20; step++) {
        const candidate = mixHexColors(value, LIGHT_SURFACE_COLOR, step / 20);
        if (passesDark(candidate)) {
          return candidate;
        }
      }

      return LIGHT_SURFACE_COLOR;
    }

    function updatePaletteSelection() {
      paletteBtns.forEach(btn => {
        btn.classList.toggle('active', normalizeThemeColor(btn.dataset.color) === themeColor);
      });
    }

    function applyThemeColor(nextColor) {
      themeColor = normalizeThemeColor(nextColor);
      // 填色／按鈕底色：淺色模式用原色，深色模式提亮到在深底看得清楚
      const appliedPrimaryColor = darkMode ? getReadableAccentColor(themeColor) : themeColor;
      // 文字／外框：一律保證 4.5:1（淺色模式調暗、深色模式提亮）
      const displayColor = getReadableAccentColor(themeColor);
      document.documentElement.style.setProperty('--primary-color', appliedPrimaryColor);
      document.documentElement.style.setProperty('--primary-shadow', hexToRgba(appliedPrimaryColor, darkMode ? 0.28 : 0.4));
      document.documentElement.style.setProperty('--primary-display', displayColor);
      document.documentElement.style.setProperty('--primary-contrast', getPrimaryContrastColor(appliedPrimaryColor));
      customColorInput.value = themeColor.toLowerCase();
      updatePaletteSelection();
    }

    // 只同步畫面；主題的套用與保存一律交給 BoboTheme（全站共用偏好 bobo-home-preferences-v2）
    function applyDarkMode(nextMode) {
      darkMode = Boolean(nextMode);
      document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';

      darkModeToggle.classList.toggle('active', darkMode);
      darkModeToggle.setAttribute('aria-pressed', String(darkMode));

      applyThemeColor(themeColor);
    }

    function readDomTheme() {
      return document.documentElement.dataset.theme === 'dark';
    }

    function toggleTheme() {
      if (themeKit) {
        applyDarkMode(themeKit.toggle() === 'dark');
        return;
      }
      // 共用模組載入失敗時的退路：只切換這一頁，不寫入偏好
      document.documentElement.dataset.theme = darkMode ? 'light' : 'dark';
      applyDarkMode(readDomTheme());
    }

    function closeMenu(returnFocus = false) {
      const wasOpen = !menuPanel.classList.contains('hidden');
      menuPanel.classList.add('hidden');
      if (wasOpen && returnFocus) menuBtn.focus();
      menuBtn.classList.remove('active');
      menuBtn.setAttribute('aria-expanded', 'false');
    }

    function toggleMenu() {
      const isOpening = menuPanel.classList.contains('hidden');
      menuPanel.classList.toggle('hidden', !isOpening);
      menuBtn.classList.toggle('active', isOpening);
      menuBtn.setAttribute('aria-expanded', String(isOpening));
    }

    function solutionToHex(solution) {
      const bits = solution.flat().join('');
      let hex = '';
      for (let i = 0; i < bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16).toUpperCase();
      }
      return hex;
    }

    function encodeShareSeed(solution) {
      return `${SHARED_SEED_PREFIX}-${solution.length}-${solutionToHex(solution)}`;
    }

    function decodeShareSeed(seedText) {
      if (typeof seedText !== 'string') return null;

      const normalized = seedText.trim().toUpperCase();
      const match = normalized.match(new RegExp(`^${SHARED_SEED_PREFIX}-(${ALLOWED_SIZES.join('|')})-([0-9A-F]+)$`));
      if (!match) return null;

      const targetSize = parseInt(match[1], 10);
      const hex = match[2];
      const expectedHexLength = (targetSize * targetSize) / 4;
      if (hex.length !== expectedHexLength) return null;

      let bits = '';
      for (const char of hex) {
        bits += parseInt(char, 16).toString(2).padStart(4, '0');
      }

      const solution = [];
      let pointer = 0;
      for (let r = 0; r < targetSize; r++) {
        const rowBits = bits.slice(pointer, pointer + targetSize);
        solution.push(rowBits.split('').map(Number));
        pointer += targetSize;
      }

      // 這裡只負責還原盤面，唯一性與難度交給 ratePuzzle 一次判定，
      // 才能分辨「不是唯一解」與「唯一解但必須猜測」並給出不同訊息。
      const { rowClues, colClues } = buildCluesFromSolution(solution);

      return {
        size: targetSize,
        solution: solution,
        rowClues: rowClues,
        colClues: colClues,
        seed: normalized
      };
    }

    function updateCurrentSeedDisplay() {
      const currentState = getCurrentState();
      currentSeedOutput.value = currentState ? encodeShareSeed(currentState.solution) : '';
    }

    function showSeedFeedback(message, isError = false) {
      seedFeedback.textContent = message;
      seedFeedback.classList.toggle('error', isError);
    }

    function loadSeedFromInput() {
      const decodedSeed = decodeShareSeed(seedInput.value);
      if (!decodedSeed) {
        showSeedFeedback('Seed 格式錯誤。', true);
        return;
      }

      const rating = NonogramCore.ratePuzzle(decodedSeed.rowClues, decodedSeed.colClues);
      if (!rating.unique) {
        showSeedFeedback('這個題目不是唯一解，無法載入。', true);
        return;
      }
      if (!rating.difficulty) {
        showSeedFeedback('這個題目必須靠猜測才能解完，無法載入。', true);
        return;
      }

      // Seed 只記錄盤面，難度是盤面的純函式，載入後直接切到判定出的難度槽位。
      size = decodedSeed.size;
      difficulty = rating.difficulty;
      const slotKey = getCurrentSlotKey();

      gameStates[slotKey] = {
        solution: decodedSeed.solution,
        playerState: createEmptyPlayerState(size),
        globalRowClues: decodedSeed.rowClues,
        globalColClues: decodedSeed.colClues,
        isGameOver: false,
        resultState: RESULT_STATE.IN_PROGRESS,
        hintsUsed: 0,
        stateRevision: getStateRevision(gameStates[slotKey])
      };
      markStateDirty(slotKey);
      actionHistory = [];

      updateSlotButtons();
      renderBoard();
      resetUI();
      seedInput.value = decodedSeed.seed;
      showSeedFeedback(`已載入指定 Seed（${size}x${size}・${DIFFICULTY_LABELS[difficulty]}）。`);
      saveData();
    }

    async function copyCurrentSeed() {
      const currentSeed = currentSeedOutput.value.trim();
      if (!currentSeed) {
        showSeedFeedback('目前還沒有可分享的 Seed。', true);
        return;
      }

      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(currentSeed);
          showSeedFeedback('Seed 已複製。');
          return;
        }

        currentSeedOutput.focus();
        currentSeedOutput.select();
        const copied = document.execCommand('copy');
        showSeedFeedback(copied ? 'Seed 已複製。' : '無法自動複製，請手動複製。', !copied);
      } catch (error) {
        console.error(error);
        showSeedFeedback('無法自動複製，請手動複製。', true);
      }
    }

    function updateSlotButtons() {
      sizeSelect.value = String(size);
      const pictureMode = isPictureMode();
      modeBtns.forEach(b => {
        const isActive = (b.dataset.mode === PICTURE_MODE) === pictureMode;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
      if (!pictureMode) lastRandomDifficulty = normalizeDifficultyChoice(difficulty);
      difficultySelect.value = lastRandomDifficulty;
      difficultyGroup.classList.toggle('hidden', pictureMode);
      pictureGroup.classList.toggle('hidden', !pictureMode);
      updatePictureProgress();
    }

    function updatePictureProgress() {
      const pool = NonogramCore.getPictures(size);
      const solved = new Set(readStats().solvedPictures);
      const count = pool.filter(picture => solved.has(picture.id)).length;
      pictureProgress.textContent = `已完成 ${count}／${pool.length}`;
    }

    function showGenerationFailure() {
      closeMenu();
      actionToggle.classList.add('hidden');
      topMsg.classList.remove('hidden');
      topMsg.style.color = 'var(--error-color)';
      topMsg.innerText = '題目生成失敗，請再試一次';
      mainActions.classList.remove('hidden');
      resultBox.classList.add('hidden');
    }

    function getStateRevision(state) {
      const revision = Number(state?.stateRevision);
      return Number.isInteger(revision) && revision > 0 ? revision : 0;
    }

    // --- 槽位 (Slots) ---
    function getSlotKey(targetSize, targetDifficulty) {
      return `${targetSize}x${targetDifficulty}`;
    }

    // 用白名單比對而非拆字串，舊存檔的數字 key（"8"）才不會被誤判成合法槽位。
    function parseSlotKey(key) {
      return ALLOWED_SLOTS.find(slot => slot.key === key) || null;
    }

    function getCurrentSlotKey() {
      return getSlotKey(size, difficulty);
    }

    function getCurrentState() {
      return gameStates[getCurrentSlotKey()];
    }

    // 標記「這個文件動過某個槽位的盤面」，寫檔時才會把它升到最新版本號。
    function markStateDirty(slotKey = getCurrentSlotKey()) {
      dirtySlotKeys.add(String(slotKey));
    }

    function normalizeHintsUsed(value) {
      return Number.isInteger(value) && value > 0 ? Math.min(value, HINT_LIMIT) : 0;
    }

    function cloneSavedGameState(state) {
      if (!state) return null;
      return {
        solution: cloneGrid(state.solution),
        playerState: cloneGrid(state.playerState),
        globalRowClues: state.globalRowClues.map(line => line.slice()),
        globalColClues: state.globalColClues.map(line => line.slice()),
        isGameOver: Boolean(state.isGameOver),
        resultState: state.resultState || (state.isGameOver ? RESULT_STATE.COMPLETED : RESULT_STATE.IN_PROGRESS),
        hintsUsed: normalizeHintsUsed(state.hintsUsed),
        stateRevision: getStateRevision(state)
      };
    }

    function getGameStatePriority(state) {
      if (!state) return -1;
      if (state.resultState === RESULT_STATE.WIN) return 3;
      if (state.resultState === RESULT_STATE.REVEALED) return 2;
      if (state.isGameOver || state.resultState === RESULT_STATE.COMPLETED) return 1;
      return 0;
    }

    function resolveGameStateConflict(baseState, incomingState, isIncomingLive = true) {
      if (!baseState) return cloneSavedGameState(incomingState);
      if (!incomingState) return cloneSavedGameState(baseState);

      // 盤面版本號只有在該文件真的動過這個盤面時才會升版，所以版本高的必定是較新的操作。
      // 這是防止背景分頁／bfcache 舊文件用過期資料蓋掉已結算牌局的主要防線，
      // 也讓「開新局／載入 Seed 換題目」自然勝出，不必再靠比對題目是否相同來猜測意圖。
      const baseRevision = getStateRevision(baseState);
      const incomingRevision = getStateRevision(incomingState);
      if (incomingRevision > baseRevision) return cloneSavedGameState(incomingState);
      if (baseRevision > incomingRevision) return cloneSavedGameState(baseState);

      // 版本相同（舊版存檔，或兩份資料同時被修改）才退回結算優先權：已完成的牌局永遠優先。
      const basePriority = getGameStatePriority(baseState);
      const incomingPriority = getGameStatePriority(incomingState);
      if (basePriority > incomingPriority) return cloneSavedGameState(baseState);
      if (incomingPriority > basePriority) return cloneSavedGameState(incomingState);

      // 完全平手時，信任「目前正在操作的那一份」。
      return cloneSavedGameState(isIncomingLive ? incomingState : baseState);
    }

    function normalizeActionHistory(history, targetSize) {
      if (!Array.isArray(history)) return [];
      return history
        .filter(snapshot => isValidMatrix(snapshot, targetSize, value => value === 0 || value === 1 || value === 2))
        .map(snapshot => cloneGrid(snapshot));
    }

    function createRuntimeSnapshot() {
      const snapshotStates = {};

      ALLOWED_SLOTS.forEach(slot => {
        const validatedState = validateSavedGameState(gameStates[slot.key], slot.size);
        if (validatedState) snapshotStates[slot.key] = validatedState;
      });

      const availableKeys = Object.keys(snapshotStates);
      if (!availableKeys.length) return null;

      const currentKey = getCurrentSlotKey();
      const snapshotKey = snapshotStates[currentKey] ? currentKey : availableKeys[0];
      // 尺寸與難度一律從最終選定的槽位回推，不可拼湊出一個不存在的組合。
      const snapshotSlot = parseSlotKey(snapshotKey);

      return {
        size: snapshotSlot.size,
        difficulty: snapshotSlot.difficulty,
        themeColor: normalizeThemeColor(themeColor),
        randomDifficulty: normalizeDifficultyChoice(lastRandomDifficulty),
        isBoardLocked: Boolean(isBoardLocked),
        isWakeLockEnabled: Boolean(isWakeLockEnabled),
        isMarkToolVisible: Boolean(isMarkToolVisible),
        gameStates: snapshotStates,
        // actionHistory 只屬於目前操作中的槽位，退到別的槽位時必須丟棄，
        // 否則同尺寸不同題目的 undo 會通過尺寸檢查而套到錯的盤面上。
        actionHistory: snapshotKey === currentKey
          ? normalizeActionHistory(actionHistory, snapshotSlot.size)
          : [],
        revision: Math.max(0, saveRevision || 0),
        savedAt: Math.max(0, lastSavedAt || 0)
      };
    }

    // options.liveSide 指出哪一邊是「目前這個文件正在操作的資料」：
    //   'incoming' → 寫檔（base = localStorage、incoming = 本文件執行中的狀態）
    //   'base'     → 讀檔同步（base = 本文件執行中的狀態、incoming = localStorage）
    // 關卡選擇與個人化設定屬於這個文件本身，必須跟著 live 那一側，
    // 否則其他分頁的舊存檔會把正在結算的頁面拉到別的關卡。
    function mergeSavedData(baseData, incomingData, options = {}) {
      if (!baseData && !incomingData) return null;

      const isBaseLive = options.liveSide === 'base';
      const liveData = isBaseLive ? baseData : incomingData;
      const staleData = isBaseLive ? incomingData : baseData;

      const mergedStates = {};
      ALLOWED_SLOTS.forEach(slot => {
        const resolvedState = resolveGameStateConflict(
          baseData?.gameStates?.[slot.key],
          incomingData?.gameStates?.[slot.key],
          !isBaseLive
        );
        if (resolvedState) mergedStates[slot.key] = resolvedState;
      });

      const availableKeys = Object.keys(mergedStates);
      if (!availableKeys.length) return null;

      const liveKey = getSlotKey(Number(liveData?.size), normalizeSlotChoice(liveData?.difficulty));
      const staleKey = getSlotKey(Number(staleData?.size), normalizeSlotChoice(staleData?.difficulty));
      const mergedKey = mergedStates[liveKey]
        ? liveKey
        : (mergedStates[staleKey] ? staleKey : availableKeys[0]);
      const mergedSlot = parseSlotKey(mergedKey);
      const mergedSize = mergedSlot.size;

      // 只採用「來源槽位就是最終槽位」那一側的 undo 歷史，避免套到別的題目上。
      const liveHistory = mergedKey === liveKey ? normalizeActionHistory(liveData?.actionHistory, mergedSize) : [];
      const staleHistory = mergedKey === staleKey ? normalizeActionHistory(staleData?.actionHistory, mergedSize) : [];

      return {
        size: mergedSize,
        difficulty: mergedSlot.difficulty,
        themeColor: normalizeThemeColor(liveData?.themeColor ?? staleData?.themeColor),
        randomDifficulty: normalizeDifficultyChoice(liveData?.randomDifficulty ?? staleData?.randomDifficulty),
        isBoardLocked: Boolean((typeof liveData?.isBoardLocked === 'boolean') ? liveData.isBoardLocked : staleData?.isBoardLocked),
        isWakeLockEnabled: Boolean((typeof liveData?.isWakeLockEnabled === 'boolean') ? liveData.isWakeLockEnabled : staleData?.isWakeLockEnabled),
        // 舊存檔沒有這個欄位時維持顯示（預設值），不能被 Boolean(undefined) 變成隱藏
        isMarkToolVisible: (typeof liveData?.isMarkToolVisible === 'boolean')
          ? liveData.isMarkToolVisible
          : (typeof staleData?.isMarkToolVisible === 'boolean' ? staleData.isMarkToolVisible : true),
        gameStates: mergedStates,
        actionHistory: liveHistory.length ? liveHistory : staleHistory,
        revision: Math.max(Number(baseData?.revision) || 0, Number(incomingData?.revision) || 0),
        savedAt: Math.max(Number(baseData?.savedAt) || 0, Number(incomingData?.savedAt) || 0)
      };
    }

    function areSavedStatesEquivalent(leftState, rightState) {
      if (!leftState || !rightState) return false;
      if (leftState.isGameOver !== rightState.isGameOver) return false;
      if (leftState.resultState !== rightState.resultState) return false;
      if (normalizeHintsUsed(leftState.hintsUsed) !== normalizeHintsUsed(rightState.hintsUsed)) return false;

      return JSON.stringify(leftState.solution) === JSON.stringify(rightState.solution) &&
        JSON.stringify(leftState.playerState) === JSON.stringify(rightState.playerState) &&
        JSON.stringify(leftState.globalRowClues) === JSON.stringify(rightState.globalRowClues) &&
        JSON.stringify(leftState.globalColClues) === JSON.stringify(rightState.globalColClues);
    }

    function hasGameStateDifference(leftData, rightData) {
      if (!leftData || !rightData) return false;

      for (const slot of ALLOWED_SLOTS) {
        const leftState = leftData.gameStates?.[slot.key];
        const rightState = rightData.gameStates?.[slot.key];

        // 一側有、另一側沒有也算有差異，儲存層缺槽位時才會被回寫補齊。
        if (Boolean(leftState) !== Boolean(rightState)) return true;
        if (leftState && rightState && !areSavedStatesEquivalent(leftState, rightState)) {
          return true;
        }
      }

      return false;
    }

    // --- 本地儲存資料功能 (Local Storage) ---
    function saveData() {
      const runtimeSnapshot = createRuntimeSnapshot();
      if (!runtimeSnapshot) return;

      // 寫入前先重讀並合併（read-merge-write），否則背景分頁／bfcache 舊文件
      // 被瀏覽器回收時觸發的 pagehide 存檔，會整包蓋掉別處剛完成的結算。
      const storedData = readSavedData();
      const revision = Math.max(saveRevision, storedData?.revision || 0) + 1;

      dirtySlotKeys.forEach(dirtyKey => {
        const dirtyState = runtimeSnapshot.gameStates[dirtyKey];
        if (dirtyState) dirtyState.stateRevision = revision;
      });

      const mergedSnapshot = mergeSavedData(storedData, runtimeSnapshot, { liveSide: 'incoming' }) || runtimeSnapshot;
      mergedSnapshot.revision = revision;
      mergedSnapshot.savedAt = Date.now();

      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(mergedSnapshot));
      } catch (e) {
        console.warn('Unable to save Nonogram state to localStorage', e);
        return;
      }

      saveRevision = revision;
      lastSavedAt = mergedSnapshot.savedAt;
      dirtySlotKeys.forEach(dirtyKey => {
        if (gameStates[dirtyKey]) gameStates[dirtyKey].stateRevision = revision;
      });
      dirtySlotKeys.clear();

      // 合併時若採用了其他分頁較新的資料，立即套回畫面，避免記憶體與存檔長期不一致。
      if (hasGameStateDifference(runtimeSnapshot, mergedSnapshot)) {
        applySavedData(mergedSnapshot, false);
        renderBoard();
        if (!getCurrentState() || !getCurrentState().isGameOver) resetUI();
      }
    }

    function applySavedData(validatedData, shouldPersist = false) {
      size = validatedData.size;
      difficulty = validatedData.difficulty;
      themeColor = validatedData.themeColor;
      // 舊版存檔的 darkMode 欄位不再採用：主題一律跟著全站偏好走
      lastRandomDifficulty = normalizeDifficultyChoice(validatedData.randomDifficulty);
      gameStates = validatedData.gameStates;
      actionHistory = validatedData.actionHistory || [];
      saveRevision = Math.max(saveRevision, validatedData.revision || 0);
      lastSavedAt = Math.max(lastSavedAt, validatedData.savedAt || 0);

      applyThemeColor(themeColor);
      updateSlotButtons();

      if (typeof validatedData.isBoardLocked === 'boolean') {
        setBoardLockState(validatedData.isBoardLocked);
      }
      if (typeof validatedData.isWakeLockEnabled === 'boolean') {
        handleWakeLockChange(validatedData.isWakeLockEnabled, false);
      }
      if (typeof validatedData.isMarkToolVisible === 'boolean') {
        setMarkToolVisible(validatedData.isMarkToolVisible);
      }

      if (shouldPersist) saveData();
    }

    // 讀不到（隱私模式、封鎖網站資料）就當作沒有存檔，絕不能讓盤面因此載不出來
    function removeSavedData() {
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch (error) {
        console.warn('Unable to clear Nonogram save', error);
      }
    }

    function readSavedData() {
      let data = null;
      try {
        data = localStorage.getItem(SAVE_KEY);
      } catch (error) {
        console.warn('Unable to read Nonogram save', error);
        return null;
      }
      if (!data) return null;

      try {
        const parsed = JSON.parse(data);
        const validatedData = validateSavedData(parsed);
        if (!validatedData) {
          removeSavedData();
          return null;
        }

        return validatedData;
      } catch (e) {
        console.error('localStorage parsing error', e);
        removeSavedData();
        return null;
      }
    }

    function loadData() {
      const validatedData = readSavedData();
      if (!validatedData) return false;

      applySavedData(validatedData, true);
      return true;
    }

    function syncStateFromStorage() {
      const storedData = readSavedData();
      // 用版本號而非時間戳判斷新舊：舊文件寫得再晚，版本號也不會超前。
      if (!storedData || (storedData.revision || 0) <= saveRevision) return false;

      const runtimeSnapshot = createRuntimeSnapshot();
      const resolvedData = mergeSavedData(runtimeSnapshot, storedData, { liveSide: 'base' });
      if (!resolvedData) return false;

      const shouldPersistResolved = hasGameStateDifference(storedData, resolvedData);
      resolvedData.revision = Math.max(Number(storedData.revision) || 0, Number(runtimeSnapshot?.revision) || 0);
      resolvedData.savedAt = Math.max(Number(storedData.savedAt) || 0, Number(runtimeSnapshot?.savedAt) || 0);

      applySavedData(resolvedData, shouldPersistResolved);
      renderBoard();

      if (!getCurrentState() || !getCurrentState().isGameOver) {
        resetUI();
      }

      return true;
    }

    function persistCurrentState() {
      if (!Object.keys(gameStates).length) return;

      if (isDragging) {
        handlePointerUp();
        return;
      }

      saveData();
    }

    // --- 綁定事件 (Event Listeners) ---
    // 按鈕的 active 狀態交給 switchSlot 內的 updateSlotButtons 回寫，
    // 生題失敗需要回滾時畫面才不會停在按不到的槽位上。
    sizeSelect.addEventListener('change', (e) => {
      const nextSize = parseInt(e.target.value, 10);
      if (!ALLOWED_SIZES.includes(nextSize)) {
        sizeSelect.value = String(size);
        return;
      }
      switchSlot(nextSize, difficulty);
    });

    difficultySelect.addEventListener('change', (e) => {
      lastRandomDifficulty = normalizeDifficultyChoice(e.target.value);
      switchSlot(size, lastRandomDifficulty);
    });

    modeBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const nextMode = e.currentTarget.dataset.mode === PICTURE_MODE ? PICTURE_MODE : lastRandomDifficulty;
        if (nextMode === difficulty) return;
        switchSlot(size, nextMode);
      });
    });

    function setCurrentAction(action) {
      currentAction = action === 'mark' ? 'mark' : 'fill';
      actionBtns.forEach(b => {
        const isActive = b.dataset.action === currentAction;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
    }

    actionBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        setCurrentAction(e.currentTarget.dataset.action);
      });
    });

    // 收起標記工具時順便切回塗黑：工具列看不到，就不能停在看不見的「標記」模式。
    // 用 body 上的 class 控制而不是 .hidden，因為 resetUI／結算畫面會自己增減 action-toggle 的 .hidden。
    function setMarkToolVisible(visible) {
      isMarkToolVisible = Boolean(visible);
      markToolCheckbox.checked = isMarkToolVisible;
      document.body.classList.toggle('mark-tool-off', !isMarkToolVisible);
      if (!isMarkToolVisible) setCurrentAction('fill');
    }

    markToolCheckbox.addEventListener('change', (e) => {
      setMarkToolVisible(e.target.checked);
      saveData();
    });

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    menuPanel.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    paletteBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        applyThemeColor(e.currentTarget.dataset.color);
        showSeedFeedback('顏色已更新。');
        saveData();
      });
    });

    customColorInput.addEventListener('input', (e) => {
      applyThemeColor(e.target.value);
      showSeedFeedback('顏色已更新。');
      saveData();
    });

    darkModeToggle.addEventListener('click', toggleTheme);

    rulesBtn.addEventListener('click', () => openDialog(rulesDialog, rulesCloseBtn));
    rulesCloseBtn.addEventListener('click', () => rulesDialog.close());

    copySeedBtn.addEventListener('click', copyCurrentSeed);
    loadSeedBtn.addEventListener('click', loadSeedFromInput);
    seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadSeedFromInput();
    });

    checkBtn.addEventListener('click', checkAnswer);
    hintBtn.addEventListener('click', showNextHint);
    newGameBtn.addEventListener('click', () => { confirmStartNewGame(size, difficulty); });
    undoBtn.addEventListener('click', undoLastAction);
    clearBoardBtn.addEventListener('click', clearBoard);

    boardLockBtn.addEventListener('click', toggleBoardLock);
    wakeLockCheckbox.addEventListener('change', (e) => {
      handleWakeLockChange(e.target.checked);
    });

    document.addEventListener('click', () => {
      closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu(menuPanel.contains(document.activeElement));
    });

    // 盤面互動一律走事件委派：這幾個監聽器取代原本每格各掛四個的做法，
    // 盤面重繪時也不必重新掛載
    boardEl.addEventListener('mousedown', handlePointerDown);
    boardEl.addEventListener('mouseover', handlePointerEnter);
    boardEl.addEventListener('touchstart', handlePointerDown, { passive: false });
    boardEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    boardEl.addEventListener('keydown', handleBoardKeydown);
    boardEl.addEventListener('focusin', (e) => {
      const cell = e.target.closest('.cell');
      if (cell) setFocusCell(Number(cell.dataset.r), Number(cell.dataset.c), false);
    });

    document.addEventListener('mouseup', handlePointerUp);
    document.addEventListener('touchend', handlePointerUp);
    document.addEventListener('touchcancel', handlePointerUp);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentState();
        return;
      }

      if (isWakeLockEnabled && !wakeLockSentinel) {
        requestWakeLock();
      }

      syncStateFromStorage();
    });

    window.addEventListener('pagehide', persistCurrentState);
    window.addEventListener('pageshow', syncStateFromStorage);
    window.addEventListener('focus', syncStateFromStorage);
    window.addEventListener('storage', (event) => {
      if (event.key === SAVE_KEY) syncStateFromStorage();
    });

    // --- 盤面鎖定與螢幕防休眠 (Board Lock & Wake Lock) ---
    function setBoardLockState(locked) {
      isBoardLocked = Boolean(locked);
      boardLockBtn.classList.toggle('locked', isBoardLocked);
      boardLockBtn.setAttribute('aria-pressed', String(isBoardLocked));
      boardLockBtn.title = isBoardLocked ? '盤面已鎖定，按一下解鎖' : '鎖定盤面（防誤觸）';
      boardEl.classList.toggle('board-locked', isBoardLocked);
      if (isBoardLocked && isDragging) {
        handlePointerUp();
      }
    }

    function toggleBoardLock() {
      setBoardLockState(!isBoardLocked);
      saveData();
    }

    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) {
        wakeLockNote.textContent = '此瀏覽器不支援螢幕防休眠功能。';
        wakeLockNote.style.color = 'var(--error-color)';
        return false;
      }
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
        wakeLockNote.textContent = '已啟用螢幕常亮防休眠。';
        wakeLockNote.style.color = 'var(--text-muted)';
        return true;
      } catch (err) {
        console.warn('Wake Lock error:', err);
        wakeLockNote.textContent = '無法取得螢幕鎖，可能處於省電模式。';
        wakeLockNote.style.color = 'var(--error-color)';
        return false;
      }
    }

    async function releaseWakeLock() {
      if (wakeLockSentinel) {
        try {
          await wakeLockSentinel.release();
        } catch (err) {
          console.warn('Release Wake Lock error:', err);
        }
        wakeLockSentinel = null;
      }
      wakeLockNote.textContent = '防止遊戲進行期間螢幕自動變暗或休眠熄屏。';
      wakeLockNote.style.color = 'var(--text-muted)';
    }

    async function handleWakeLockChange(enabled, shouldSave = true) {
      isWakeLockEnabled = Boolean(enabled);
      wakeLockCheckbox.checked = isWakeLockEnabled;
      if (isWakeLockEnabled) {
        await requestWakeLock();
      } else {
        await releaseWakeLock();
      }
      if (shouldSave) saveData();
    }

    function validateSavedGameState(savedState, targetSize) {
      if (!savedState || typeof savedState !== 'object') return null;
      if (!isValidMatrix(savedState.solution, targetSize, value => value === 0 || value === 1)) return null;
      if (!isValidMatrix(savedState.playerState, targetSize, value => value === 0 || value === 1 || value === 2)) return null;
      if (!isValidClueSet(savedState.globalRowClues, targetSize)) return null;
      if (!isValidClueSet(savedState.globalColClues, targetSize)) return null;

      const derivedClues = buildCluesFromSolution(savedState.solution);
      const isClueMismatch = derivedClues.rowClues.some((clues, index) => !areClueLinesEqual(clues, savedState.globalRowClues[index])) ||
        derivedClues.colClues.some((clues, index) => !areClueLinesEqual(clues, savedState.globalColClues[index]));

      if (isClueMismatch) return null;

      const isGameOver = Boolean(savedState.isGameOver);
      const resultState = isGameOver && (savedState.resultState === RESULT_STATE.WIN || savedState.resultState === RESULT_STATE.REVEALED)
        ? savedState.resultState
        : (isGameOver ? RESULT_STATE.COMPLETED : RESULT_STATE.IN_PROGRESS);

      return {
        solution: cloneGrid(savedState.solution),
        playerState: cloneGrid(savedState.playerState),
        globalRowClues: savedState.globalRowClues.map(line => line.slice()),
        globalColClues: savedState.globalColClues.map(line => line.slice()),
        isGameOver: isGameOver,
        resultState: resultState,
        hintsUsed: normalizeHintsUsed(savedState.hintsUsed),
        stateRevision: getStateRevision(savedState)
      };
    }

    function validateSavedData(parsed) {
      if (!parsed || typeof parsed !== 'object' || !parsed.gameStates || typeof parsed.gameStates !== 'object') {
        return null;
      }

      const validatedStates = {};

      ALLOWED_SLOTS.forEach(slot => {
        const validatedState = validateSavedGameState(parsed.gameStates[slot.key], slot.size);
        if (validatedState) validatedStates[slot.key] = validatedState;
      });

      // 舊存檔以「盤面尺寸」當 key，沒有難度概念；把它們視為中等難度搬進對應槽位。
      // 這裡不動任何版本號，首次載入後的正常回寫就會把格式落地。
      ALLOWED_SIZES.forEach(allowedSize => {
        const legacyState = validateSavedGameState(parsed.gameStates[allowedSize], allowedSize);
        if (!legacyState) return;

        const targetKey = getSlotKey(allowedSize, DEFAULT_DIFFICULTY);
        validatedStates[targetKey] = validatedStates[targetKey]
          ? resolveGameStateConflict(validatedStates[targetKey], legacyState, false)
          : legacyState;
      });

      const availableKeys = Object.keys(validatedStates);
      if (!availableKeys.length) return null;

      const candidateKey = getSlotKey(parsed.size, normalizeSlotChoice(parsed.difficulty));
      const validatedKey = validatedStates[candidateKey] ? candidateKey : availableKeys[0];
      const validatedSlot = parseSlotKey(validatedKey);
      const validatedSize = validatedSlot.size;

      // 退到別的槽位時 undo 歷史必定不屬於那一局，直接丟棄。
      const validHistory = validatedKey === candidateKey && Array.isArray(parsed.actionHistory)
        ? parsed.actionHistory.filter(snapshot => isValidMatrix(snapshot, validatedSize, value => value === 0 || value === 1 || value === 2))
        : [];

      return {
        size: validatedSize,
        difficulty: validatedSlot.difficulty,
        themeColor: normalizeThemeColor(parsed.themeColor),
        // 舊存檔沒有這個欄位時，從當時所在的難度推回來
        randomDifficulty: normalizeDifficultyChoice(parsed.randomDifficulty ?? parsed.difficulty),
        isBoardLocked: Boolean(parsed.isBoardLocked),
        isWakeLockEnabled: Boolean(parsed.isWakeLockEnabled),
        isMarkToolVisible: typeof parsed.isMarkToolVisible === 'boolean' ? parsed.isMarkToolVisible : true,
        gameStates: validatedStates,
        actionHistory: validHistory.map(snapshot => cloneGrid(snapshot)),
        revision: Number.isInteger(parsed.revision) && parsed.revision > 0 ? parsed.revision : 0,
        savedAt: Number.isFinite(parsed.savedAt) && parsed.savedAt > 0 ? parsed.savedAt : 0
      };
    }

    function createPuzzleForSlot(targetSize, targetDifficulty) {
      if (targetDifficulty !== PICTURE_MODE) {
        return NonogramCore.generatePuzzle(targetSize, targetDifficulty);
      }
      // 圖案模式：依序出還沒解過的圖，並記住這一張，下一局才不會重複
      const stats = readStats();
      const picture = NonogramCore.pickNextPicture(targetSize, stats.solvedPictures, stats.lastPicture[targetSize]);
      if (!picture) throw new Error(`No picture puzzles for ${targetSize}x${targetSize}.`);
      stats.lastPicture[targetSize] = picture.id;
      writeStats(stats);
      return NonogramCore.createPicturePuzzle(picture);
    }

    function initGameData(targetSize, targetDifficulty) {
      // 隨機槽位每開一局都由核心重新抽一次難度，題目仍存回隨機槽位本身。
      const { solution, rowClues, colClues } = createPuzzleForSlot(targetSize, targetDifficulty);
      const slotKey = getSlotKey(targetSize, targetDifficulty);

      gameStates[slotKey] = {
        solution: solution,
        playerState: createEmptyPlayerState(targetSize),
        globalRowClues: rowClues,
        globalColClues: colClues,
        isGameOver: false
        , resultState: RESULT_STATE.IN_PROGRESS
        , hintsUsed: 0
        , stateRevision: getStateRevision(gameStates[slotKey])
      };
      markStateDirty(slotKey);
    }

    // 切換盤面尺寸或難度都走這裡：每個槽位各自保存一局，切過去若還沒有題目就現生一題。
    function switchSlot(nextSize, nextDifficulty) {
      const previousSize = size;
      const previousDifficulty = difficulty;
      const previousKey = getCurrentSlotKey();

      size = nextSize;
      difficulty = normalizeSlotChoice(nextDifficulty);

      if (!getCurrentState()) {
        try {
          initGameData(size, difficulty);
        } catch (error) {
          console.error(error);
          size = previousSize;
          difficulty = previousDifficulty;
          updateSlotButtons();
          showGenerationFailure();
          return;
        }
      }

      // undo 歷史只屬於原本那一局，換槽位後必須清空，否則會套到別的題目上。
      if (getCurrentSlotKey() !== previousKey) actionHistory = [];

      updateSlotButtons();
      renderBoard();
      resetUI();
      saveData();
    }

    function createNewGameButton() {
      const ngBtn = document.createElement('button');
      ngBtn.className = 'primary-btn';
      ngBtn.type = 'button';
      ngBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7"></path>
          <path d="M21 3v6h-6"></path>
        </svg>
        <span>再來一局</span>`;
      ngBtn.onclick = () => confirmStartNewGame(size, difficulty);
      return ngBtn;
    }

    // 隨機槽位作答期間不透露抽到哪個難度，結算時才揭曉。
    // 難度是盤面的純函式，直接從線索重算，存檔就不必多存一個欄位。
    function getDifficultyRevealText(state) {
      if (isPictureMode()) {
        const picture = NonogramCore.findPictureBySolution(state.solution);
        return picture ? `圖案：${picture.name}` : '';
      }
      if (difficulty !== RANDOM_DIFFICULTY) return '';
      const revealed = NonogramCore.ratePuzzle(state.globalRowClues, state.globalColClues).difficulty;
      return revealed ? `本題難度：${DIFFICULTY_LABELS[revealed]}` : '';
    }

    function renderFinishedUI(state) {
      actionToggle.classList.add('hidden');
      topMsg.classList.remove('hidden');
      mainActions.classList.add('hidden');
      resultBox.classList.remove('hidden');
      resultBtns.innerHTML = '';
      resultBtns.appendChild(createNewGameButton());

      const revealText = getDifficultyRevealText(state);

      if (state.resultState === RESULT_STATE.WIN) {
        topMsg.style.color = 'var(--primary-display)';
        topMsg.innerText = revealText ? `答對了！${revealText}` : '答對了！';
        return;
      }

      topMsg.style.color = 'var(--text-secondary)';
      const baseText = state.resultState === RESULT_STATE.REVEALED ? '答案已顯示' : '本局已結束';
      topMsg.innerText = revealText ? `${baseText}・${revealText}` : baseText;
    }

    function isPlayerSolutionCorrect(state) {
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const isFilled = state.playerState[r][c] === 1;
          const shouldFill = state.solution[r][c] === 1;
          if (isFilled !== shouldFill) return false;
        }
      }
      return true;
    }

    function isBoardEmpty(playerState) {
      return playerState.every(row => row.every(cell => cell === 0));
    }

    function updateClearBoardButtonState() {
      const state = getCurrentState();
      const isEmpty = state ? isBoardEmpty(state.playerState) : true;
      const shouldDisable = !state || state.isGameOver || isEmpty;
      clearBoardBtn.disabled = shouldDisable;
      clearBoardBtn.setAttribute('aria-disabled', String(shouldDisable));
    }

    function updateUndoButtonState() {
      const shouldDisable = !actionHistory.length || !getCurrentState() || getCurrentState().isGameOver;
      undoBtn.disabled = shouldDisable;
      undoBtn.setAttribute('aria-disabled', String(shouldDisable));
    }

    function doesPlayerLineMatchClues(lineValues, targetClues) {
      const filledLine = lineValues.map(value => value === 1 ? 1 : 0);
      return areClueLinesEqual(getClues(filledLine), targetClues);
    }

    function isRowCompleted(state, rowIndex) {
      return doesPlayerLineMatchClues(state.playerState[rowIndex], state.globalRowClues[rowIndex]);
    }

    function isColumnCompleted(state, colIndex) {
      const columnValues = state.playerState.map(row => row[colIndex]);
      return doesPlayerLineMatchClues(columnValues, state.globalColClues[colIndex]);
    }

    // rowClueEls[r] / colClueEls[c] → 該列／欄的線索格
    let rowClueEls = [];
    let colClueEls = [];

    function updateCompletedClueStatus(state) {
      for (let r = 0; r < size; r++) {
        if (rowClueEls[r]) rowClueEls[r].classList.toggle('completed', isRowCompleted(state, r));
      }
      for (let c = 0; c < size; c++) {
        if (colClueEls[c]) colClueEls[c].classList.toggle('completed', isColumnCompleted(state, c));
      }
    }

    function clearLineErrors() {
      rowClueEls.concat(colClueEls).forEach(el => el && el.classList.remove('line-error'));
    }

    const CELL_STATE_LABELS = { 0: '空白', 1: '塗黑', 2: '標記 Ｏ' };

    // 依格子數值套用外觀與無障礙名稱。單格更新與整盤重建共用同一套規則
    function paintCell(cell, value) {
      if (!cell) return;
      cell.classList.remove('error-wrong', 'error-miss');
      cell.classList.toggle('filled', value === 1);
      cell.classList.toggle('marked', value === 2);
      const r = Number(cell.dataset.r) + 1;
      const c = Number(cell.dataset.c) + 1;
      cell.setAttribute('aria-label', `第 ${r} 列第 ${c} 欄，${CELL_STATE_LABELS[value] || '空白'}`);
    }

    // cellEls[r][c] → 該格的 DOM 節點，讓單格更新不必每次查詢 DOM
    let cellEls = [];
    // 鍵盤焦點所在格（roving tabindex：整個盤面只有這一格可被 Tab 到）
    let focusR = 0;
    let focusC = 0;

    function setFocusCell(r, c, moveFocus = true) {
      if (!cellEls.length) return;
      const nextR = Math.min(size - 1, Math.max(0, r));
      const nextC = Math.min(size - 1, Math.max(0, c));
      const previous = cellEls[focusR] && cellEls[focusR][focusC];
      if (previous) previous.tabIndex = -1;
      focusR = nextR;
      focusC = nextC;
      const next = cellEls[focusR][focusC];
      next.tabIndex = 0;
      if (moveFocus) next.focus();
    }

    function clearHint() {
      boardEl.querySelectorAll('.hint-cell').forEach(cell => cell.classList.remove('hint-cell', 'hint-mistake'));
      hintMsg.textContent = '';
    }

    function updateHintButtonState() {
      const state = getCurrentState();
      const remaining = state ? HINT_LIMIT - normalizeHintsUsed(state.hintsUsed) : 0;
      const shouldDisable = !state || state.isGameOver || remaining <= 0;
      hintCount.textContent = String(remaining);
      hintBtn.disabled = shouldDisable;
      hintBtn.setAttribute('aria-disabled', String(shouldDisable));
      hintBtn.setAttribute('aria-label', `提示（剩 ${remaining} 次）`);
      hintBtn.title = `提示（剩 ${remaining} 次）`;
    }

    function showNextHint() {
      const state = getCurrentState();
      if (!state || state.isGameOver) return;
      // 上一個提示還亮著（盤面沒動過）就不重複扣次數
      if (boardEl.querySelector('.hint-cell')) return;
      if (normalizeHintsUsed(state.hintsUsed) >= HINT_LIMIT) return;
      clearHint();
      const hint = NonogramCore.getNextHint(state.globalRowClues, state.globalColClues, state.playerState, state.solution);
      if (hint.status === 'complete') {
        hintMsg.textContent = '都完成了，按「對答案」確認';
        announce(hintMsg.textContent);
        return;
      }

      state.hintsUsed = normalizeHintsUsed(state.hintsUsed) + 1;
      markStateDirty();
      saveData();
      updateHintButtonState();

      cellEls[hint.row][hint.col].classList.add('hint-cell');
      const where = `第 ${hint.row + 1} 列第 ${hint.col + 1} 欄`;
      if (hint.status === 'mistake') {
        cellEls[hint.row][hint.col].classList.add('hint-mistake');
        hintMsg.textContent = `${where}填錯了`;
      } else {
        const source = hint.axis ? `看第 ${hint.lineIndex + 1} ${hint.axis === 'row' ? '列' : '欄'}：` : '';
        hintMsg.textContent = `${source}${where}要塗黑`;
      }
      announce(hintMsg.textContent);
    }

    function renderBoard() {
      clearHint();
      const state = getCurrentState();
      const hadFocus = boardEl.contains(document.activeElement);
      boardEl.style.setProperty('--board-size', String(size));
      boardEl.innerHTML = '';
      cellEls = Array.from({ length: size }, () => new Array(size));
      rowClueEls = new Array(size);
      colClueEls = new Array(size);
      if (focusR >= size || focusC >= size) {
        focusR = 0;
        focusC = 0;
      }

      // 每一列用 display: contents 的 row 包起來：視覺上仍是同一個 CSS grid，
      // 輔助科技則看得到「列 → 欄標題／列標題／格子」的表格結構。
      const headerRow = document.createElement('div');
      headerRow.className = 'board-row';
      headerRow.setAttribute('role', 'row');
      const emptyCorner = document.createElement('div');
      emptyCorner.className = 'clue-cell clue-corner';
      emptyCorner.setAttribute('role', 'columnheader');
      emptyCorner.setAttribute('aria-label', '線索');
      headerRow.appendChild(emptyCorner);

      for (let c = 0; c < size; c++) {
        const el = document.createElement('div');
        el.className = 'clue-cell col-clue';
        el.setAttribute('role', 'columnheader');
        el.setAttribute('aria-label', `第 ${c + 1} 欄：${state.globalColClues[c].join(' ')}`);
        el.innerHTML = state.globalColClues[c].map(n => `<span aria-hidden="true">${n}</span>`).join('');
        colClueEls[c] = el;
        headerRow.appendChild(el);
      }
      boardEl.appendChild(headerRow);

      for (let r = 0; r < size; r++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'board-row';
        rowEl.setAttribute('role', 'row');

        const rClue = document.createElement('div');
        rClue.className = 'clue-cell row-clue';
        rClue.setAttribute('role', 'rowheader');
        rClue.setAttribute('aria-label', `第 ${r + 1} 列：${state.globalRowClues[r].join(' ')}`);
        rClue.innerHTML = state.globalRowClues[r].map(n => `<span aria-hidden="true">${n}</span>`).join('');
        rowClueEls[r] = rClue;
        rowEl.appendChild(rClue);

        for (let c = 0; c < size; c++) {
          const cell = document.createElement('div');
          cell.className = 'cell';
          cell.dataset.r = r;
          cell.dataset.c = c;
          cell.setAttribute('role', 'gridcell');
          cell.tabIndex = (r === focusR && c === focusC) ? 0 : -1;

          paintCell(cell, state.playerState[r][c]);
          cellEls[r][c] = cell;

          // 互動事件統一委派給 boardEl，這裡不逐格掛載
          rowEl.appendChild(cell);
        }
        boardEl.appendChild(rowEl);
      }

      updateCompletedClueStatus(state);
      boardEl.setAttribute('aria-disabled', String(Boolean(state.isGameOver)));

      if (state.isGameOver) {
        renderFinishedUI(state);
      }

      updateCurrentSeedDisplay();
      updateClearBoardButtonState();
      updateUndoButtonState();
      updateHintButtonState();
      updatePictureProgress();

      // 重繪後把焦點放回原本那一格，鍵盤玩家不會被丟回頁首
      if (hadFocus) setFocusCell(focusR, focusC, true);
    }

    function startNewGame(targetSize = size, targetDifficulty = difficulty) {
      actionHistory = [];
      try {
        initGameData(targetSize, targetDifficulty);
      } catch (error) {
        console.error(error);
        showGenerationFailure();
        return;
      }

      renderBoard();
      resetUI();
      saveData();
    }

    async function confirmStartNewGame(targetSize = size, targetDifficulty = difficulty) {
      const state = gameStates[getSlotKey(targetSize, targetDifficulty)];
      if (state && state.isGameOver) {
        startNewGame(targetSize, targetDifficulty);
        return;
      }

      const confirmed = await showConfirmDialog('新的一局', '確定要開始新的一局嗎？目前進度會遺失。', '開始新局');
      if (confirmed) {
        startNewGame(targetSize, targetDifficulty);
      }
    }

    // 原生 <dialog>：showModal() 自帶背景 inert、Esc 關閉與焦點困在對話框內；
    // 關閉後把焦點還給開啟它的按鈕
    function openDialog(dialog, initialFocus) {
      const opener = document.activeElement;
      closeMenu();
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      if (initialFocus) initialFocus.focus();
      dialog.addEventListener('close', () => {
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
      }, { once: true });
    }

    function showConfirmDialog(title, message, confirmLabel) {
      return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmOkBtn.textContent = confirmLabel;
        let result = false;

        const onClose = () => {
          confirmCancelBtn.onclick = null;
          confirmOkBtn.onclick = null;
          resolve(result);
        };
        confirmDialog.addEventListener('close', onClose, { once: true });

        confirmCancelBtn.onclick = () => { result = false; confirmDialog.close(); };
        confirmOkBtn.onclick = () => { result = true; confirmDialog.close(); };
        // 會清掉進度的確認一律先停在「取消」，避免連按 Enter 誤刪
        openDialog(confirmDialog, confirmCancelBtn);
      });
    }

    function undoLastAction() {
      const state = getCurrentState();
      if (!state || state.isGameOver || !actionHistory.length) return;

      const previous = state.playerState;
      const restored = actionHistory.pop();
      state.playerState = restored;
      state.resultState = RESULT_STATE.IN_PROGRESS;
      markStateDirty();

      // 只更新真正改變的格子，不重建整個盤面。
      // 盤面結構若還沒建立（例如剛切換尺寸）才退回完整重繪
      const canPatch = cellEls.length === size && restored.length === size;
      if (canPatch) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (previous[r][c] !== restored[r][c]) {
              paintCell(cellEls[r][c], restored[r][c]);
            }
          }
        }
        updateCompletedClueStatus(state);
        updateClearBoardButtonState();
      } else {
        renderBoard();
      }

      resetUI();
      saveData();
      updateUndoButtonState();
    }

    async function clearBoard() {
      const state = getCurrentState();
      if (!state || state.isGameOver) return;

      const confirmed = await showConfirmDialog('清空盤面', '確定要清空整個盤面嗎？這會移除目前所有塗黑與標記。', '確認清空');
      if (!confirmed) return;

      actionHistory.push(cloneGrid(state.playerState));
      state.playerState = createEmptyPlayerState(size);
      state.resultState = RESULT_STATE.IN_PROGRESS;
      markStateDirty();
      renderBoard();
      resetUI();
      saveData();
    }

    function handlePointerDown(e) {
      if (isBoardLocked || getCurrentState().isGameOver) return;
      if (e.type === 'touchstart') {
        // 兩指以上是捏合縮放，不當作塗格
        if (e.touches && e.touches.length > 1) return;
        e.preventDefault();
      }

      const cell = e.target.closest('.cell');
      if (!cell) return;

      isDragging = true;
      lastHoveredCell = cell;
      dragSnapshot = cloneGrid(getCurrentState().playerState);
      dragHistoryCommitted = false;
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      const currentState = getCurrentState().playerState[r][c];
      setFocusCell(r, c, false);

      if (currentAction === 'fill') {
        dragAction = (currentState === 1) ? 'unfill' : 'fill';
      } else {
        dragAction = (currentState === 2) ? 'unmark' : 'mark';
      }

      applyAction(cell, r, c);
    }

    // 註：使用會冒泡的 mouseover 以便委派（mouseenter 不冒泡）。
    // 在同一格內移動會重複觸發，因此記住上一格避免多餘工作
    let lastHoveredCell = null;

    // 手指或滑鼠移動很快時，兩次事件之間可能跳過好幾格；
    // 用直線插值把中間經過的格子補上（做法同 meowdoku）
    function applyAlongPath(fromCell, toCell) {
      const r0 = Number(fromCell.dataset.r);
      const c0 = Number(fromCell.dataset.c);
      const r1 = Number(toCell.dataset.r);
      const c1 = Number(toCell.dataset.c);
      const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
      for (let i = 1; i <= steps; i++) {
        const r = Math.round(r0 + (r1 - r0) * (i / steps));
        const c = Math.round(c0 + (c1 - c0) * (i / steps));
        if (cellEls[r] && cellEls[r][c]) applyAction(cellEls[r][c], r, c);
      }
    }

    function dragTo(cell) {
      if (!cell || cell === lastHoveredCell) return;
      if (lastHoveredCell) {
        applyAlongPath(lastHoveredCell, cell);
      } else {
        applyAction(cell, Number(cell.dataset.r), Number(cell.dataset.c));
      }
      lastHoveredCell = cell;
    }

    function handlePointerEnter(e) {
      if (isBoardLocked || !isDragging || getCurrentState().isGameOver) return;
      dragTo(e.target.closest('.cell'));
    }

    function handleTouchMove(e) {
      if (isBoardLocked || !isDragging || getCurrentState().isGameOver) return;
      e.preventDefault();

      const touch = e.touches[0];
      const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);
      const cell = targetElement && targetElement.closest ? targetElement.closest('.cell') : null;
      if (cell && boardEl.contains(cell)) dragTo(cell);
    }

    function handlePointerUp() {
      lastHoveredCell = null;
      if (isDragging) {
        isDragging = false;
        dragAction = null;
        dragSnapshot = null;
        dragHistoryCommitted = false;
        saveData(); // 拖曳結束後存檔
      }
    }

    // 鍵盤單格操作：等同按一下該格（各自是一步，可單獨復原）
    function toggleCellByKeyboard(r, c, action) {
      const state = getCurrentState();
      if (!state || state.isGameOver) return;
      if (isBoardLocked) {
        announce('盤面已鎖定，先按鎖頭解鎖');
        return;
      }
      const current = state.playerState[r][c];
      dragSnapshot = cloneGrid(state.playerState);
      dragHistoryCommitted = false;
      if (action === 'fill') {
        dragAction = current === 1 ? 'unfill' : 'fill';
      } else {
        dragAction = current === 2 ? 'unmark' : 'mark';
      }
      applyAction(cellEls[r][c], r, c);
      dragAction = null;
      dragSnapshot = null;
      dragHistoryCommitted = false;
      saveData();
    }

    function handleBoardKeydown(e) {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      const moves = {
        ArrowUp: [r - 1, c],
        ArrowDown: [r + 1, c],
        ArrowLeft: [r, c - 1],
        ArrowRight: [r, c + 1],
        Home: [r, 0],
        End: [r, size - 1]
      };
      if (moves[e.key]) {
        e.preventDefault();
        setFocusCell(moves[e.key][0], moves[e.key][1], true);
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggleCellByKeyboard(r, c, currentAction);
        return;
      }
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        toggleCellByKeyboard(r, c, 'mark');
      }
    }

    function applyAction(cell, r, c) {
      let state = getCurrentState();
      const currentValue = state.playerState[r][c];
      cell.classList.remove('error-wrong', 'error-miss');

      let nextValue = currentValue;
      if (dragAction === 'fill') {
        nextValue = 1;
        cell.classList.add('filled');
        cell.classList.remove('marked');
      } else if (dragAction === 'unfill') {
        nextValue = 0;
        cell.classList.remove('filled');
      } else if (dragAction === 'mark') {
        nextValue = 2;
        cell.classList.add('marked');
        cell.classList.remove('filled');
      } else if (dragAction === 'unmark') {
        nextValue = 0;
        cell.classList.remove('marked');
      }

      // 數值沒變就不必重掃線索與重算按鈕狀態（掃描是 O(size²)）
      if (currentValue === nextValue) return;
      clearHint();

      if (!dragHistoryCommitted && dragSnapshot) {
        actionHistory.push(dragSnapshot);
        dragHistoryCommitted = true;
      }
      state.playerState[r][c] = nextValue;
      paintCell(cell, nextValue);
      clearLineErrors();
      markStateDirty();

      updateCompletedClueStatus(state);
      updateClearBoardButtonState();
      updateUndoButtonState();
    }

    function checkAnswer() {
      let state = getCurrentState();
      if (state.isGameOver) return;
      showResult(isPlayerSolutionCorrect(state));
    }

    // 對不上線索的列與欄：拿來告訴玩家錯在哪裡，而不是只說「再想想」
    function findMismatchedLines(state) {
      const rows = [];
      const cols = [];
      for (let r = 0; r < size; r++) if (!isRowCompleted(state, r)) rows.push(r);
      for (let c = 0; c < size; c++) if (!isColumnCompleted(state, c)) cols.push(c);
      return { rows, cols };
    }

    function describeLines(indexes, unit) {
      if (!indexes.length) return '';
      const shown = indexes.slice(0, 4).map(i => i + 1).join('、');
      return indexes.length > 4 ? `共 ${indexes.length} ${unit}（第 ${shown}…${unit}）` : `第 ${shown} ${unit}`;
    }

    // 過關卡片裡的完成圖；animate=true 時已塗的格子依序填上（減少動態效果時由 CSS 直接顯示）
    function buildResultPicture(solution, label, animate) {
      const targetSize = solution.length;
      const picture = document.createElement('div');
      picture.className = animate ? 'result-picture is-revealing' : 'result-picture';
      picture.setAttribute('role', 'img');
      picture.setAttribute('aria-label', label);
      picture.style.setProperty('--picture-size', String(targetSize));
      const filled = solution.reduce((n, row) => n + row.filter(v => v === 1).length, 0);
      // 不管格子多少，整張圖都在約 0.9 秒內畫完
      picture.style.setProperty('--step', `${Math.max(6, Math.round(900 / Math.max(1, filled)))}ms`);
      let order = 0;
      solution.forEach(row => row.forEach(value => {
        const cell = document.createElement('span');
        if (value === 1) {
          cell.className = 'on';
          cell.style.setProperty('--i', String(order++));
        }
        picture.appendChild(cell);
      }));
      return picture;
    }

    function recordWin(state) {
      const stats = readStats();
      stats.wins += 1;
      const picture = isPictureMode() ? NonogramCore.findPictureBySolution(state.solution) : null;
      const isNewPicture = Boolean(picture && !stats.solvedPictures.includes(picture.id));
      if (isNewPicture) stats.solvedPictures.push(picture.id);
      writeStats(stats);
      return { stats, picture, isNewPicture };
    }

    function showWinDialog(state, info) {
      const { stats, picture, isNewPicture } = info;
      const hintsUsed = normalizeHintsUsed(state.hintsUsed);
      const hintText = hintsUsed ? `用了 ${hintsUsed} 次提示` : '沒用提示';
      const accent = (getComputedStyle(document.documentElement).getPropertyValue('--primary-display') || '').trim() || undefined;
      let options;
      if (picture) {
        const pool = NonogramCore.getPictures(size);
        const solvedCount = pool.filter(p => stats.solvedPictures.includes(p.id)).length;
        options = {
          title: `完成！是「${picture.name}」`,
          subtitle: isNewPicture ? `收集到新圖案，${hintText}。` : `這張之前解過，${hintText}。`,
          stats: [
            { label: `${size}×${size} 圖案`, value: `${solvedCount}／${pool.length}`, isBest: isNewPicture },
            { label: '累計過關', value: `${stats.wins} 次` }
          ],
          extra: buildResultPicture(state.solution, `解開的圖案：${picture.name}`, true)
        };
      } else {
        const revealText = getDifficultyRevealText(state);
        options = {
          title: '答對了！',
          subtitle: [hintText, revealText].filter(Boolean).join('，') + '。',
          stats: [
            { label: '盤面', value: `${size}×${size}` },
            { label: '累計過關', value: `${stats.wins} 次` }
          ],
          extra: buildResultPicture(state.solution, '完成的盤面', false)
        };
      }
      updatePictureProgress();
      const celebrate = (typeof BoboCelebrate !== 'undefined') ? BoboCelebrate : null;
      if (celebrate) {
        celebrate.show(Object.assign({
          outcome: 'win',
          gameName: 'Nonogram 數織',
          accent,
          accentDark: accent,
          // 過關後「對答案」等按鈕會收起來，焦點一律交還給盤面上的格子
          primary: { label: '再來一局', onClick: () => { startNewGame(size, difficulty); setFocusCell(focusR, focusC, true); } },
          secondary: { label: '看盤面' },
          onClose: (reason) => { if (reason !== 'primary') setFocusCell(focusR, focusC, true); }
        }, options));
      } else {
        announce(`${options.title}。${options.subtitle}`);
      }
    }

    function showResult(isWin) {
      clearHint();
      clearLineErrors();
      mainActions.classList.add('hidden');
      resultBox.classList.remove('hidden');
      resultBtns.innerHTML = '';

      actionToggle.classList.add('hidden');
      topMsg.classList.remove('hidden');

      isDragging = false;
      dragAction = null;
      dragSnapshot = null;
      dragHistoryCommitted = false;

      const state = getCurrentState();

      if (isWin) {
        state.playerState = cloneGrid(state.solution);
        state.isGameOver = true;
        state.resultState = RESULT_STATE.WIN;
        actionHistory = [];
        markStateDirty();
        renderBoard();
        saveData();
        showWinDialog(state, recordWin(state));
      } else {
        state.resultState = RESULT_STATE.IN_PROGRESS;
        const { rows, cols } = findMismatchedLines(state);
        rows.forEach(r => rowClueEls[r] && rowClueEls[r].classList.add('line-error'));
        cols.forEach(c => colClueEls[c] && colClueEls[c].classList.add('line-error'));
        const parts = [describeLines(rows, '列'), describeLines(cols, '欄')].filter(Boolean);
        topMsg.style.color = 'var(--error-color)';
        topMsg.innerText = parts.length
          ? `還沒對：${parts.join('，')}和數字對不上（已標成紅色）`
          : '你再想想看';
        announce(topMsg.innerText);

        const answerBtn = document.createElement('button');
        answerBtn.className = 'secondary-btn';
        answerBtn.type = 'button';
        answerBtn.innerText = '直接看答案';
        answerBtn.addEventListener('click', showSolution);

        const retryBtn = document.createElement('button');
        retryBtn.className = 'primary-btn';
        retryBtn.type = 'button';
        retryBtn.innerText = '繼續作答';
        retryBtn.addEventListener('click', () => {
          resetUI({ keepLineErrors: true });
          setFocusCell(focusR, focusC, true);
        });

        resultBtns.appendChild(answerBtn);
        resultBtns.appendChild(retryBtn);
        retryBtn.focus();
      }
    }

    function showSolution() {
      let state = getCurrentState();
      state.playerState = cloneGrid(state.solution);
      state.isGameOver = true;
      state.resultState = RESULT_STATE.REVEALED;
      markStateDirty();
      renderBoard();

      saveData();
      announce('答案已顯示');
    }

    function resetUI(options = {}) {
      clearHint();
      if (!options.keepLineErrors) clearLineErrors();
      if (getCurrentState() && getCurrentState().isGameOver) return; // 避免結束後還原按鈕

      actionToggle.classList.remove('hidden');
      topMsg.classList.add('hidden');
      mainActions.classList.remove('hidden');
      resultBox.classList.add('hidden');
      updateClearBoardButtonState();
      document.querySelectorAll('.cell.error-wrong, .cell.error-miss').forEach(el => {
        el.classList.remove('error-wrong', 'error-miss');
      });
    }

    // --- 初始化啟動 (Initialization) ---
    // 主題跟著全站偏好走：BoboTheme.init() 只套用、不寫入；之後系統主題改變時也會跟著換
    applyDarkMode(themeKit ? themeKit.init() === 'dark' : readDomTheme());
    new MutationObserver(() => {
      if (readDomTheme() !== darkMode) applyDarkMode(readDomTheme());
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    if (!loadData()) {
      switchSlot(size, difficulty); // 如果沒有 cookie/localStorage 記錄，載入預設 8x8 中等
    } else {
      renderBoard(); // 如果有記錄，直接繪製盤面
    }
