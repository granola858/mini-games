const catAssetPaths = {
            1: 'assets/images/meowdoku/1.svg',
            2: 'assets/images/meowdoku/2.svg',
            3: 'assets/images/meowdoku/3.svg',
            4: 'assets/images/meowdoku/4.svg',
            5: 'assets/images/meowdoku/5.svg',
            6: 'assets/images/meowdoku/6.svg',
            7: 'assets/images/meowdoku/7.svg',
            8: 'assets/images/meowdoku/8.svg'
        };
        const LEGACY_CAT_STYLE_ID_MAP = {
            3: 1,
            4: 2,
            5: 3,
            6: 4,
            7: 5,
            8: 6,
            9: 7,
            10: 8
        };

        const boardEl = document.getElementById('board');
        const livesEl = document.getElementById('livesDisplay');
        const toastEl = document.getElementById('toast');
        const modeBtns = document.querySelectorAll('.mode-btn');
        const darkModeToggle = document.getElementById('darkModeToggle');
        const resetBtn = document.getElementById('resetBtn');
        const clearBtn = document.getElementById('clearBtn');
        const helpBtn = document.getElementById('helpBtn');
        const helpOverlay = document.getElementById('helpOverlay');
        const helpCloseBtn = document.getElementById('helpCloseBtn');
        const confirmOverlay = document.getElementById('confirmOverlay');
        const confirmTitleEl = document.getElementById('confirmTitle');
        const confirmMessageEl = document.getElementById('confirmMessage');
        const confirmCancelBtn = document.getElementById('confirmCancelBtn');
        const confirmOkBtn = document.getElementById('confirmOkBtn');
        let pendingConfirmAction = null;

        const SAVE_KEY = 'meowdoku-game-states-v1';
        const SAVE_VERSION = 1;
        const DARK_MODE_KEY = 'meowdoku-dark-mode-v1';
        const VALID_SIZES = [6, 7, 8];
        const CAT_STYLE_KEYS = Object.keys(catAssetPaths).map(Number).sort((a, b) => a - b);
        const savedGameData = loadSavedGameData();

        let currentSize = savedGameData.currentSize;
        let isDrawingPaw = false;
        let pawDrawValue = false;
        let darkMode = loadDarkModePreference();
        let toastTimer = null;
        let gameStates = savedGameData.states;

        const palette = [
            '#F6C6D5', '#A8D8EA', '#A6D8A8', '#FFD6A5', '#CDB4DB',
            '#BDE0FE', '#F7D6E0', '#D8F3DC', '#FFE5D9', '#B8E0D2',
            '#F9E2AE', '#CFA8FF', '#8EC5FC', '#F4C2C2', '#D4A373', '#B8C0FF'
        ];
        const softPurple = '#E9D7F8';

        preloadCatAssets();

        function shuffle(array) {
            const copy = [...array];
            for (let i = copy.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            return copy;
        }

        function preloadCatAssets() {
            for (const src of Object.values(catAssetPaths)) {
                const image = new Image();
                image.decoding = 'async';
                image.src = src;
            }
        }

        function createCatSvg(style = 1) {
            const src = catAssetPaths[style] || catAssetPaths[1];
            return `<div class="cat-face"><img src="${src}" alt="" draggable="false"></div>`;
        }

        function normalizeCatStyleId(style) {
            const numericStyle = Number(style) || 0;
            if (CAT_STYLE_KEYS.includes(numericStyle)) return numericStyle;
            return LEGACY_CAT_STYLE_ID_MAP[numericStyle] || 0;
        }

        function createPawSvg() {
            return `<div class="paw-mark">🐾</div>`;
        }

        function createEmptyCellState() {
            return { cat: false, paw: false, catStyle: 0 };
        }

        function createEmptyCellStates(size) {
            return Array.from({ length: size }, () => Array.from({ length: size }, createEmptyCellState));
        }

        function loadSavedGameData() {
            const fallback = { currentSize: 6, states: {} };
            try {
                const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
                if (!saved || saved.version !== SAVE_VERSION || typeof saved.states !== 'object') return fallback;

                const states = {};
                for (const size of VALID_SIZES) {
                    const normalized = normalizeSavedState(saved.states[String(size)], size);
                    if (normalized) states[size] = normalized;
                }

                return {
                    currentSize: VALID_SIZES.includes(saved.currentSize) ? saved.currentSize : 6,
                    states
                };
            } catch (error) {
                console.warn('Meowdoku saved state could not be loaded:', error);
                return fallback;
            }
        }

        function saveGameStates() {
            try {
                const states = {};
                for (const size of VALID_SIZES) {
                    if (gameStates[size]) states[size] = serializeState(gameStates[size]);
                }
                localStorage.setItem(SAVE_KEY, JSON.stringify({
                    version: SAVE_VERSION,
                    currentSize,
                    states
                }));
            } catch (error) {
                console.warn('Meowdoku saved state could not be written:', error);
            }
        }

        function serializeState(state) {
            return {
                size: state.size,
                solution: state.solution,
                regions: state.regions,
                regionColors: state.regionColors,
                regionCatStyles: state.regionCatStyles,
                lives: clampLives(state.lives),
                status: state.status,
                cellStates: state.cellStates,
                savedAt: Date.now()
            };
        }

        function normalizeSavedState(saved, size) {
            if (!saved || saved.size !== size) return null;
            if (!isNumberMatrix(saved.solution, size, (value) => value === 0 || value === 1)) return null;
            if (!isNumberMatrix(saved.regions, size, (value) => Number.isInteger(value) && value >= 1 && value <= size)) return null;
            if (!saved.regionColors || typeof saved.regionColors !== 'object') return null;
            for (let id = 1; id <= size; id++) {
                if (typeof saved.regionColors[id] !== 'string') return null;
            }
            const regionCatStyles = normalizeRegionCatStyles(saved.regionCatStyles, size);
            if (!regionCatStyles) return null;
            if (!Array.isArray(saved.cellStates) || saved.cellStates.length !== size) return null;

            const cellStates = [];
            for (let r = 0; r < size; r++) {
                if (!Array.isArray(saved.cellStates[r]) || saved.cellStates[r].length !== size) return null;
                const row = [];
                for (let c = 0; c < size; c++) {
                    const cell = saved.cellStates[r][c] || {};
                    const catStyle = normalizeCatStyleId(cell.catStyle);
                    row.push({
                        cat: Boolean(cell.cat),
                        paw: Boolean(cell.paw) && !cell.cat,
                        catStyle
                    });
                }
                cellStates.push(row);
            }

            const status = ['playing', 'won', 'lost'].includes(saved.status) ? saved.status : 'playing';
            return {
                size,
                solution: saved.solution,
                regions: saved.regions,
                regionColors: saved.regionColors,
                regionCatStyles,
                lives: clampLives(saved.lives),
                status,
                cellStates,
                savedAt: Number(saved.savedAt) || Date.now()
            };
        }

        function isNumberMatrix(matrix, size, validator) {
            return Array.isArray(matrix)
                && matrix.length === size
                && matrix.every((row) => Array.isArray(row) && row.length === size && row.every(validator));
        }

        function clampLives(lives) {
            return Math.max(0, Math.min(3, Number(lives) || 0));
        }

        function buildUniqueRegionCatStyles(size) {
            const shuffledStyles = shuffle(CAT_STYLE_KEYS).slice(0, size);
            const regionCatStyles = {};
            for (let id = 1; id <= size; id++) {
                regionCatStyles[id] = shuffledStyles[id - 1] || CAT_STYLE_KEYS[(id - 1) % CAT_STYLE_KEYS.length];
            }
            return regionCatStyles;
        }

        function normalizeRegionCatStyles(regionCatStyles, size) {
            if (!regionCatStyles || typeof regionCatStyles !== 'object') {
                return buildDefaultRegionCatStyles(size);
            }

            const usedStyles = new Set();
            const normalized = {};
            for (let id = 1; id <= size; id++) {
                const style = normalizeCatStyleId(regionCatStyles[id]);
                if (!CAT_STYLE_KEYS.includes(style) || usedStyles.has(style)) {
                    return buildDefaultRegionCatStyles(size);
                }
                usedStyles.add(style);
                normalized[id] = style;
            }
            return normalized;
        }

        function buildDefaultRegionCatStyles(size) {
            const regionCatStyles = {};
            for (let id = 1; id <= size; id++) {
                regionCatStyles[id] = CAT_STYLE_KEYS[(id - 1) % CAT_STYLE_KEYS.length];
            }
            return regionCatStyles;
        }

        function getState(size) {
            if (!gameStates[size]) {
                gameStates[size] = createFreshState(size);
                saveGameStates();
            }
            return gameStates[size];
        }

        function createFreshState(size) {
            const state = {
                size,
                solution: [],
                regions: [],
                regionColors: {},
                regionCatStyles: {},
                lives: 3,
                status: 'playing',
                cellStates: []
            };
            generatePuzzle(state, size);
            return state;
        }

        function loadDarkModePreference() {
            try {
                return localStorage.getItem(DARK_MODE_KEY) === 'true';
            } catch (error) {
                return false;
            }
        }

        function applyDarkMode(nextMode) {
            darkMode = Boolean(nextMode);
            document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
            document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';
            darkModeToggle.classList.toggle('active', darkMode);
            darkModeToggle.setAttribute('aria-checked', String(darkMode));
            const toggleLabel = darkMode ? '切換為淺色模式' : '切換為深色模式';
            darkModeToggle.setAttribute('aria-label', toggleLabel);
            darkModeToggle.title = toggleLabel;
            try {
                localStorage.setItem(DARK_MODE_KEY, String(darkMode));
            } catch (error) {
                console.warn('Meowdoku dark mode preference could not be saved:', error);
            }
        }

        function openHelp() {
            helpOverlay.classList.remove('hidden');
        }

        function closeHelp() {
            helpOverlay.classList.add('hidden');
        }

        function openConfirm(action) {
            pendingConfirmAction = action;
            if (action === 'clear') {
                confirmTitleEl.textContent = '清空盤面';
                confirmMessageEl.textContent = '確定要清空目前的標記與貓咪嗎？此動作無法復原。';
                confirmOkBtn.textContent = '清空';
            } else {
                confirmTitleEl.textContent = '重置盤面';
                confirmMessageEl.textContent = '確定要重置目前盤面嗎？進度將會消失。';
                confirmOkBtn.textContent = '重置';
            }
            confirmOverlay.classList.remove('hidden');
        }

        function closeConfirm() {
            confirmOverlay.classList.add('hidden');
            pendingConfirmAction = null;
        }

        function updateModeButtons() {
            modeBtns.forEach((btn) => {
                btn.classList.toggle('active', Number(btn.dataset.size) === currentSize);
            });
        }

        function initGame(size) {
            currentSize = size;
            resetPointerState();
            const state = getState(size);
            updateModeButtons();
            updateLives(state.lives);

            boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
            boardEl.style.gridTemplateRows = `repeat(${size}, 1fr)`;
            boardEl.innerHTML = '';

            renderBoard(state);
            updateGameOverUI(state);
            updateClearButtonState(state);
            saveGameStates();
        }

        function isBoardEmpty(state) {
            return state.cellStates.every((row) => row.every((cellState) => !cellState.cat && !cellState.paw));
        }

        function updateClearButtonState(state) {
            const empty = isBoardEmpty(state);
            clearBtn.disabled = empty;
            clearBtn.classList.toggle('disabled', empty);
        }

        function updateGameOverUI(state) {
            const isOver = state.status !== 'playing';
            boardEl.classList.toggle('frozen', isOver);
            resetBtn.classList.toggle('highlight', isOver);
        }

        function performReset() {
            gameStates[currentSize] = createFreshState(currentSize);
            saveGameStates();
            initGame(currentSize);
        }

        function performClear() {
            const state = getState(currentSize);
            state.cellStates = createEmptyCellStates(state.size);
            saveGameStates();
            initGame(currentSize);
        }

        function updateLives(lives) {
            const safeLives = clampLives(lives);
            livesEl.textContent = '❤️'.repeat(safeLives) + '🖤'.repeat(3 - safeLives);
        }

        function showToast(message, type = 'info') {
            if (!toastEl) return;
            toastEl.textContent = message;
            toastEl.className = `message-toast show ${type}`;
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                toastEl.className = 'message-toast';
            }, 2000);
        }

        function generatePuzzle(state, size) {
            const maxAttempts = 120;
            let fallback = null;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const candidate = buildPuzzleCandidate(size);
                if (!candidate) continue;
                if (!fallback) fallback = candidate;

                const testState = {
                    ...candidate,
                    size,
                    lives: 3,
                    status: 'playing',
                    cellStates: createEmptyCellStates(size)
                };

                if (countSolutions(testState, 2) === 1) {
                    applyPuzzleCandidate(state, candidate, size);
                    return;
                }
            }

            if (!fallback) throw new Error(`Unable to generate a ${size}x${size} Meowdoku puzzle.`);
            console.warn('Meowdoku puzzle generator fell back to a candidate with multiple solutions.');
            applyPuzzleCandidate(state, fallback, size);
        }

        function buildPuzzleCandidate(size) {
            const solution = Array.from({ length: size }, () => Array(size).fill(0));

            function solve(row) {
                if (row === size) return true;
                const cols = shuffle(Array.from({ length: size }, (_, i) => i));
                for (const col of cols) {
                    if (isValid(solution, row, col, size)) {
                        solution[row][col] = 1;
                        if (solve(row + 1)) return true;
                        solution[row][col] = 0;
                    }
                }
                return false;
            }

            if (!solve(0)) return null;

            const regions = Array.from({ length: size }, () => Array(size).fill(0));
            const catQueue = [];
            let regionId = 1;
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    if (solution[r][c] === 1) {
                        regions[r][c] = regionId;
                        catQueue.push({ r, c, id: regionId });
                        regionId++;
                    }
                }
            }

            while (catQueue.length > 0) {
                const idx = Math.floor(Math.random() * catQueue.length);
                const { r, c, id } = catQueue.splice(idx, 1)[0];
                const directions = shuffle([[-1, 0], [1, 0], [0, -1], [0, 1]]);

                for (const [dr, dc] of directions) {
                    const nr = r + dr;
                    const nc = c + dc;
                    if (nr >= 0 && nr < size && nc >= 0 && nc < size && regions[nr][nc] === 0) {
                        regions[nr][nc] = id;
                        catQueue.push({ r: nr, c: nc, id });
                    }
                }
            }

            const regionColors = {};
            const colors = shuffle(palette).filter((color) => color !== softPurple).slice(0, size - 1);
            regionColors[1] = softPurple;
            for (let i = 2; i <= size; i++) {
                regionColors[i] = colors[i - 2];
            }

            return {
                solution,
                regions,
                regionColors,
                regionCatStyles: buildUniqueRegionCatStyles(size)
            };
        }

        function applyPuzzleCandidate(state, candidate, size) {
            state.size = size;
            state.solution = candidate.solution;
            state.regions = candidate.regions;
            state.regionColors = candidate.regionColors;
            state.regionCatStyles = candidate.regionCatStyles;
            state.cellStates = createEmptyCellStates(size);
            state.lives = 3;
            state.status = 'playing';
            state.savedAt = Date.now();
        }

        function isValid(board, r, c, size) {
            for (let i = 0; i < size; i++) {
                if (board[i][c] === 1) return false;
            }
            for (let i = -1; i <= 1; i++) {
                for (let j = -1; j <= 1; j++) {
                    const nr = r + i;
                    const nc = c + j;
                    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === 1) return false;
                }
            }
            return true;
        }

        function renderBoard(state) {
            const fragment = document.createDocumentFragment();
            for (let r = 0; r < state.size; r++) {
                for (let c = 0; c < state.size; c++) {
                    const cell = document.createElement('div');
                    const cellState = state.cellStates[r][c];
                    cell.className = 'cell';
                    cell.style.backgroundColor = state.regionColors[state.regions[r][c]];
                    cell.dataset.r = r;
                    cell.dataset.c = c;
                    updateCellData(cell, cellState);

                    cell.addEventListener('pointerdown', (event) => {
                        event.preventDefault();
                        if (state.status !== 'playing' || cell.dataset.cat === 'true') return;
                        const now = Date.now();
                        const cellKey = `${r}-${c}`;
                        if (now - lastTapTime < 220 && lastTapCellKey === cellKey) {
                            if (state.solution[r][c] === 1) {
                                const styleIndex = state.cellStates[r][c].catStyle || getCatStyle(state, r, c);
                                state.cellStates[r][c] = { cat: true, paw: false, catStyle: styleIndex };
                                updateCellData(cell, state.cellStates[r][c]);
                                updateCellView(cell);
                                checkWin(state);
                                updateGameOverUI(state);
                                updateClearButtonState(state);
                            } else {
                                state.lives = clampLives(state.lives - 1);
                                updateLives(state.lives);
                                state.cellStates[r][c] = { cat: false, paw: false, catStyle: 0 };
                                updateCellData(cell, state.cellStates[r][c]);
                                updateCellView(cell);
                                cell.classList.add('error');
                                setTimeout(() => cell.classList.remove('error'), 400);
                                if (state.lives === 0) {
                                    state.status = 'lost';
                                    saveGameStates();
                                    showToast('遊戲結束！可重置盤面重新開始。', 'error');
                                    updateGameOverUI(state);
                                } else {
                                    saveGameStates();
                                    showToast(`那裡沒有貓咪，還剩 ${state.lives} 顆心。`, 'error');
                                }
                                updateClearButtonState(state);
                            }
                            lastTapTime = 0;
                            lastTapCellKey = '';
                            return;
                        }

                        isDrawingPaw = true;
                        pawDrawValue = !state.cellStates[r][c].paw;
                        applyPawState(state, r, c, cell, pawDrawValue);
                        lastTapTime = now;
                        lastTapCellKey = cellKey;
                    });

                    cell.addEventListener('pointerenter', () => {
                        if (isDrawingPaw && state.status === 'playing' && cell.dataset.cat !== 'true') {
                            applyPawState(state, r, c, cell, pawDrawValue);
                        }
                    });

                    fragment.appendChild(cell);
                    updateCellView(cell);
                }
            }
            boardEl.appendChild(fragment);
        }

        function getCatStyle(state, r, c) {
            const regionId = state.regions[r][c];
            return state.regionCatStyles?.[regionId] || CAT_STYLE_KEYS[(regionId - 1) % CAT_STYLE_KEYS.length];
        }

        function updateCellData(cell, cellState) {
            cell.dataset.cat = String(Boolean(cellState.cat));
            cell.dataset.paw = String(Boolean(cellState.paw));
            cell.dataset.catStyle = String(cellState.catStyle || 0);
        }

        function applyPawState(state, r, c, cell, paw) {
            state.cellStates[r][c].paw = paw;
            state.cellStates[r][c].cat = false;
            updateCellData(cell, state.cellStates[r][c]);
            updateCellView(cell);
            updateClearButtonState(state);
            saveGameStates();
        }

        function updateCellView(cell) {
            if (cell.dataset.cat === 'true') {
                const styleIndex = normalizeCatStyleId(cell.dataset.catStyle || '1');
                cell.innerHTML = createCatSvg(styleIndex);
            } else if (cell.dataset.paw === 'true') {
                cell.innerHTML = createPawSvg();
            } else {
                cell.innerHTML = '';
            }
        }

        function getCorrectCats(state) {
            let correct = 0;
            for (let r = 0; r < state.size; r++) {
                for (let c = 0; c < state.size; c++) {
                    if (state.solution[r][c] === 1 && state.cellStates[r][c].cat) correct++;
                }
            }
            return correct;
        }

        let lastTapTime = 0;
        let lastTapCellKey = '';

        function checkWin(state) {
            if (state.status !== 'playing') return;
            const complete = state.cellStates.every((row, r) => row.every((cellState, c) => {
                const shouldHaveCat = state.solution[r][c] === 1;
                return (shouldHaveCat && cellState.cat) || (!shouldHaveCat && !cellState.cat);
            }));

            // 從實際答案比對正確放置的貓咪數，而不是只信賴計數變數
            let correctCats = 0;
            for (let r = 0; r < state.size; r++) {
                for (let c = 0; c < state.size; c++) {
                    if (state.solution[r][c] === 1 && state.cellStates[r][c].cat) correctCats++;
                }
            }

            if (correctCats === state.size && complete) {
                state.status = 'won';
                saveGameStates();
                showToast('恭喜幫貓咪們都放回家中！', 'success');
            } else {
                saveGameStates();
            }
        }

        // 計算在目前玩家已固定放置（貓或標記為無貓）的情況下，符合規則的解答數量
        function countSolutions(state, maxCount = 2) {
            const size = state.size;
            const fixedCatInRow = Array(size).fill(-1);
            const fixedNoCat = Array.from({ length: size }, () => Array(size).fill(false));

            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    const cellState = state.cellStates[r][c];
                    if (cellState.cat && cellState.paw) return 0;
                    if (cellState.cat) {
                        if (fixedCatInRow[r] !== -1 && fixedCatInRow[r] !== c) return 0;
                        fixedCatInRow[r] = c;
                    }
                    if (cellState.paw) fixedNoCat[r][c] = true;
                }
            }

            let count = 0;
            const placedCols = Array(size).fill(-1);
            const colsUsed = Array(size).fill(false);
            const regionsUsed = Array(size + 1).fill(false);

            function tryPlace(row, c) {
                const regionId = state.regions[row][c];
                if (fixedNoCat[row][c]) return;
                if (colsUsed[c]) return;
                if (regionsUsed[regionId]) return;
                for (let rr = 0; rr < row; rr++) {
                    const pc = placedCols[rr];
                    if (pc === -1) continue;
                    if (Math.abs(rr - row) <= 1 && Math.abs(pc - c) <= 1) return;
                }

                colsUsed[c] = true;
                regionsUsed[regionId] = true;
                placedCols[row] = c;
                backtrack(row + 1);
                placedCols[row] = -1;
                regionsUsed[regionId] = false;
                colsUsed[c] = false;
            }

            function backtrack(row) {
                if (count >= maxCount) return;
                if (row === size) {
                    count++;
                    return;
                }

                if (fixedCatInRow[row] !== -1) {
                    const c = fixedCatInRow[row];
                    tryPlace(row, c);
                    return;
                }

                for (let c = 0; c < size; c++) {
                    tryPlace(row, c);
                    if (count >= maxCount) return;
                }
            }

            backtrack(0);
            return count;
        }

        // 在 Console 呼叫： checkPlayerSolutionUnique()，會輸出是否正確與是否唯一
        function checkPlayerSolutionUnique() {
            const state = getState(currentSize);
            // 檢查玩家目前放的貓是否與答案相符
            let playerMatches = true;
            for (let r = 0; r < state.size; r++) {
                for (let c = 0; c < state.size; c++) {
                    const shouldHave = state.solution[r][c] === 1;
                    const hasCat = state.cellStates[r][c].cat;
                    if ((shouldHave && !hasCat) || (!shouldHave && hasCat)) {
                        playerMatches = false;
                        break;
                    }
                }
                if (!playerMatches) break;
            }

            const sols = countSolutions(state, 2);
            console.log('Player matches generated solution:', playerMatches);
            if (sols === 0) console.log('No valid solutions given current fixed placements.');
            else if (sols === 1) console.log('Unique solution exists.');
            else console.log('Multiple solutions exist (>=2).');
            return { playerMatches, solutions: sols };
        }

        window.checkPlayerSolutionUnique = checkPlayerSolutionUnique;

        modeBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                const size = Number(btn.dataset.size);
                if (size === currentSize) return;
                currentSize = size;
                updateModeButtons();
                initGame(size);
            });
        });

        resetBtn.addEventListener('click', () => {
            const state = getState(currentSize);
            if (state.status !== 'playing') {
                performReset();
            } else {
                openConfirm('reset');
            }
        });
        clearBtn.addEventListener('click', () => {
            const state = getState(currentSize);
            if (isBoardEmpty(state)) return;
            openConfirm('clear');
        });
        confirmCancelBtn.addEventListener('click', closeConfirm);
        confirmOkBtn.addEventListener('click', () => {
            if (pendingConfirmAction === 'clear') {
                performClear();
            } else {
                performReset();
            }
            closeConfirm();
        });
        confirmOverlay.addEventListener('click', (event) => {
            if (event.target === confirmOverlay) closeConfirm();
        });

        helpBtn.addEventListener('click', openHelp);
        helpCloseBtn.addEventListener('click', closeHelp);
        helpOverlay.addEventListener('click', (event) => {
            if (event.target === helpOverlay) closeHelp();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeHelp();
                closeConfirm();
            }
        });

        darkModeToggle.addEventListener('click', () => {
            applyDarkMode(!darkMode);
        });

        function resetPointerState() {
            isDrawingPaw = false;
            pawDrawValue = false;
            lastTapTime = 0;
            lastTapCellKey = '';
        }

        // 觸控輸入時，pointer 會被瀏覽器隱性鎖定在按下的格子上，
        // 移動到其他格子不會觸發該格子的 pointerenter，因此改用座標判斷實際所在格子，
        // 讓觸控也能像滑鼠拖曳一樣連續標記爪子記號。
        boardEl.addEventListener('pointermove', (event) => {
            if (!isDrawingPaw) return;
            const state = getState(currentSize);
            if (state.status !== 'playing') return;
            const target = document.elementFromPoint(event.clientX, event.clientY);
            const cell = target && target.closest('.cell');
            if (!cell || cell.dataset.cat === 'true') return;
            const r = Number(cell.dataset.r);
            const c = Number(cell.dataset.c);
            if (state.cellStates[r][c].paw === pawDrawValue) return;
            applyPawState(state, r, c, cell, pawDrawValue);
        });

        // 部分行動瀏覽器（尤其 iOS Safari）即使設定 touch-action/user-scalable，
        // 仍可能在同一格快速點兩下時觸發原生「雙擊放大」手勢。棋盤互動由
        // pointer events 處理，因此在 touch 事件層直接取消預設手勢最穩定。
        function preventBoardTouchGesture(event) {
            event.preventDefault();
        }

        boardEl.addEventListener('touchstart', preventBoardTouchGesture, { passive: false });
        boardEl.addEventListener('touchmove', preventBoardTouchGesture, { passive: false });
        boardEl.addEventListener('touchend', preventBoardTouchGesture, { passive: false });
        boardEl.addEventListener('touchcancel', preventBoardTouchGesture, { passive: false });

        document.addEventListener('pointerup', () => {
            isDrawingPaw = false;
        });
        document.addEventListener('pointercancel', resetPointerState);
        window.addEventListener('blur', resetPointerState);
        window.addEventListener('pagehide', saveGameStates);

        applyDarkMode(darkMode);
        initGame(currentSize);
