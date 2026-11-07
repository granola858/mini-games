        let size = 8;
        let paletteSize = 4;
        let currentColor = 1;
        let isDragging = false;
        let dragAction = null;
        let dragSnapshot = null;
        let dragHistoryCommitted = false;
        let actionHistory = [];
        let gameState = null;
        let savedSessions = createEmptySaveStore();
        let isBoardLocked = false;
        let patternAssist = false;

        const SAVE_KEY = 'color_nonogram_save_data';
        // 戰績與偏好另存，讀寫都包 try/catch，存取被封鎖時遊戲照樣能玩
        const STATS_KEY = 'color_nonogram_stats_v1';
        const PREFS_KEY = 'color_nonogram_prefs_v1';
        const DEFAULT_SIZE = 8;
        const DEFAULT_PALETTE_SIZE = 4;
        const ALLOWED_SIZES = [8, 10, 12];
        const ALLOWED_PALETTE_SIZES = [2, 3, 4];
        const RESULT_STATE = {
            IN_PROGRESS: 'in-progress',
            WIN: 'win',
            REVEALED: 'revealed',
            COMPLETED: 'completed'
        };
        // 顏色定義：fill 是格子底色，文字（線索數字）用 CSS 變數 --cN-ink（深淺主題各一組、皆 ≥ 4.5:1），
        // glyph 是「圖形輔助」打開時的非顏色辨識方式。
        const COLOR_OPTIONS = [
            { id: 1, label: '紅', glyph: '●' },
            { id: 2, label: '青', glyph: '▲' },
            { id: 3, label: '黃', glyph: '■' },
            { id: 4, label: '藍', glyph: '◆' }
        ];
        const MAX_GENERATION_ATTEMPTS = 120;
        const linePatternCache = new Map();

        const sizeBtns = document.querySelectorAll('#size-toggle .mode-btn');
        const paletteCountBtns = document.querySelectorAll('#palette-count-toggle .mode-btn');
        const paletteRow = document.getElementById('palette-row');
        const patternAssistInput = document.getElementById('pattern-assist');
        const topMsg = document.getElementById('top-msg');
        const boardEl = document.getElementById('board');
        const undoBtn = document.getElementById('undo-btn');
        const newGameBtn = document.getElementById('new-game-btn');
        const clearBoardBtn = document.getElementById('clear-board-btn');
        const checkBtn = document.getElementById('check-btn');
        const confirmDialog = document.getElementById('confirm-dialog');
        const confirmTitle = document.getElementById('confirm-title');
        const confirmMessage = document.getElementById('confirm-message');
        const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
        const confirmOkBtn = document.getElementById('confirm-ok-btn');
        const boardLockBtn = document.getElementById('board-lock-btn');
        const srStatus = document.getElementById('sr-status');
        const rulesBtn = document.getElementById('rules-btn');
        const rulesDialog = document.getElementById('rules-dialog');
        const rulesCloseBtn = document.getElementById('rules-close-btn');
        const themeBtn = document.getElementById('theme-btn');
        const themeKit = (typeof BoboTheme !== 'undefined') ? BoboTheme : null;

        function normalizeSize(value) {
            const normalized = Number(value);
            return ALLOWED_SIZES.includes(normalized) ? normalized : DEFAULT_SIZE;
        }

        function normalizePaletteSize(value) {
            const normalized = Number(value);
            return ALLOWED_PALETTE_SIZES.includes(normalized) ? normalized : DEFAULT_PALETTE_SIZE;
        }

        function normalizeColorId(value, maxPaletteSize = paletteSize) {
            const normalized = Number(value);
            return Number.isInteger(normalized) && normalized >= 1 && normalized <= maxPaletteSize ? normalized : 1;
        }

        function getConfigKey(targetSize = size, availablePaletteSize = paletteSize) {
            return `${normalizeSize(targetSize)}x${normalizePaletteSize(availablePaletteSize)}`;
        }

        function createEmptySaveStore() {
            return {
                activeConfigKey: '',
                states: {}
            };
        }

        function cloneGrid(grid) {
            return grid.map(row => row.slice());
        }

        function cloneClueSet(clues) {
            return clues.map(line => line.map(item => ({ color: item.color, length: item.length })));
        }

        function createEmptyPlayerState(targetSize) {
            return Array.from({ length: targetSize }, () => new Array(targetSize).fill(0));
        }

        function getColorOption(colorId) {
            return COLOR_OPTIONS.find(option => option.id === colorId) || null;
        }

        function isInsideBoard(rowIndex, colIndex, targetSize) {
            return rowIndex >= 0 && rowIndex < targetSize && colIndex >= 0 && colIndex < targetSize;
        }

        function hasSameColorNeighbor(board, rowIndex, colIndex, colorValue) {
            const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

            for (const [rowOffset, colOffset] of directions) {
                const nextRow = rowIndex + rowOffset;
                const nextCol = colIndex + colOffset;

                if (!isInsideBoard(nextRow, nextCol, board.length)) continue;
                if (board[nextRow][nextCol] === colorValue) return true;
            }

            return false;
        }

        function canPlaceSegment(board, startRow, startCol, direction, length, colorValue) {
            const cells = [];

            for (let index = 0; index < length; index++) {
                const rowIndex = startRow + direction.row * index;
                const colIndex = startCol + direction.col * index;

                if (!isInsideBoard(rowIndex, colIndex, board.length)) return false;
                if (board[rowIndex][colIndex] !== 0) return false;

                cells.push({ rowIndex, colIndex });
            }

            for (const cell of cells) {
                if (hasSameColorNeighbor(board, cell.rowIndex, cell.colIndex, colorValue)) return false;
            }

            return true;
        }

        function placeRandomSegment(board, targetSize, availablePaletteSize, forcedColorValue = null) {
            const directions = [
                { row: 0, col: 1 },
                { row: 1, col: 0 }
            ];

            for (let attempt = 0; attempt < 120; attempt++) {
                const length = 2 + Math.floor(Math.random() * 3);
                const direction = directions[Math.floor(Math.random() * directions.length)];
                const maxStartRow = direction.row === 1 ? targetSize - length : targetSize - 1;
                const maxStartCol = direction.col === 1 ? targetSize - length : targetSize - 1;
                const startRow = Math.floor(Math.random() * (maxStartRow + 1));
                const startCol = Math.floor(Math.random() * (maxStartCol + 1));
                const colorValue = forcedColorValue ?? (1 + Math.floor(Math.random() * availablePaletteSize));

                if (!canPlaceSegment(board, startRow, startCol, direction, length, colorValue)) continue;

                for (let index = 0; index < length; index++) {
                    const rowIndex = startRow + direction.row * index;
                    const colIndex = startCol + direction.col * index;
                    board[rowIndex][colIndex] = colorValue;
                }

                return true;
            }

            return false;
        }

        function getUsedColors(solution) {
            const usedColors = new Set();

            for (const row of solution) {
                for (const value of row) {
                    if (value > 0) usedColors.add(value);
                }
            }

            return usedColors;
        }

        function createRandomSolution(targetSize, availablePaletteSize) {
            const solution = Array.from({ length: targetSize }, () => new Array(targetSize).fill(0));
            const targetSegments = Math.max(4, Math.floor((targetSize * targetSize) / 10));

            for (let colorValue = 1; colorValue <= availablePaletteSize; colorValue++) {
                if (!placeRandomSegment(solution, targetSize, availablePaletteSize, colorValue)) {
                    return null;
                }
            }

            for (let index = availablePaletteSize; index < targetSegments; index++) {
                if (!placeRandomSegment(solution, targetSize, availablePaletteSize)) break;
            }

            return solution;
        }

        function getColorClues(line) {
            const clues = [];
            let count = 0;
            let currentLineColor = 0;

            for (let index = 0; index < line.length; index++) {
                const cellValue = line[index];

                if (cellValue > 0) {
                    if (cellValue !== currentLineColor) {
                        if (count > 0) clues.push({ color: currentLineColor, length: count });
                        currentLineColor = cellValue;
                        count = 1;
                    } else {
                        count += 1;
                    }
                } else if (count > 0) {
                    clues.push({ color: currentLineColor, length: count });
                    currentLineColor = 0;
                    count = 0;
                }
            }

            if (count > 0) clues.push({ color: currentLineColor, length: count });
            return clues.length ? clues : [{ color: 0, length: 0 }];
        }

        function buildCluesFromSolution(solution) {
            const rowClues = solution.map(getColorClues);
            const colClues = [];

            for (let colIndex = 0; colIndex < solution.length; colIndex++) {
                const column = [];
                for (let rowIndex = 0; rowIndex < solution.length; rowIndex++) {
                    column.push(solution[rowIndex][colIndex]);
                }
                colClues.push(getColorClues(column));
            }

            return { rowClues, colClues };
        }

        function getClueCacheKey(clues) {
            return clues.map(item => `${item.color}-${item.length}`).join('|');
        }

        function getMinimumRemainingLength(clues, clueIndex) {
            let total = 0;

            for (let index = clueIndex; index < clues.length; index++) {
                total += clues[index].length;
                if (index < clues.length - 1 && clues[index].color === clues[index + 1].color) {
                    total += 1;
                }
            }

            return total;
        }

        function generateLinePatterns(length, clues) {
            if (clues.length === 1 && clues[0].length === 0) {
                return [new Array(length).fill(0)];
            }

            const patterns = [];

            function backtrack(clueIndex, position, line) {
                if (clueIndex === clues.length) {
                    patterns.push(line.concat(new Array(length - line.length).fill(0)));
                    return;
                }

                const clue = clues[clueIndex];
                const minimumRemainingLength = getMinimumRemainingLength(clues, clueIndex);
                const maxStart = length - minimumRemainingLength;

                for (let start = position; start <= maxStart; start++) {
                    const nextLine = line.slice();

                    while (nextLine.length < start) nextLine.push(0);
                    for (let index = 0; index < clue.length; index++) nextLine.push(clue.color);

                    if (clueIndex < clues.length - 1 && clues[clueIndex + 1].color === clue.color) {
                        nextLine.push(0);
                    }

                    backtrack(clueIndex + 1, nextLine.length, nextLine);
                }
            }

            backtrack(0, 0, []);
            return patterns;
        }

        function getLinePatterns(length, clues) {
            const cacheKey = `${length}:${getClueCacheKey(clues)}`;
            if (!linePatternCache.has(cacheKey)) {
                linePatternCache.set(cacheKey, generateLinePatterns(length, clues));
            }
            return linePatternCache.get(cacheKey);
        }

        function getForcedLineValue(patterns, index) {
            const firstValue = patterns[0][index];
            for (let patternIndex = 1; patternIndex < patterns.length; patternIndex++) {
                if (patterns[patternIndex][index] !== firstValue) return -1;
            }
            return firstValue;
        }

        function cloneDomains(domains) {
            return domains.map(domain => domain.slice());
        }

        function propagateConstraints(board, rowDomains, colDomains) {
            const targetSize = board.length;
            let changed = true;

            while (changed) {
                changed = false;

                for (let rowIndex = 0; rowIndex < targetSize; rowIndex++) {
                    const filteredRowPatterns = rowDomains[rowIndex].filter(pattern => {
                        for (let colIndex = 0; colIndex < targetSize; colIndex++) {
                            if (board[rowIndex][colIndex] !== -1 && board[rowIndex][colIndex] !== pattern[colIndex]) {
                                return false;
                            }
                        }
                        return true;
                    });

                    if (!filteredRowPatterns.length) return false;
                    if (filteredRowPatterns.length !== rowDomains[rowIndex].length) {
                        rowDomains[rowIndex] = filteredRowPatterns;
                        changed = true;
                    }

                    for (let colIndex = 0; colIndex < targetSize; colIndex++) {
                        const forcedValue = getForcedLineValue(rowDomains[rowIndex], colIndex);
                        if (forcedValue === -1) continue;

                        if (board[rowIndex][colIndex] === -1) {
                            board[rowIndex][colIndex] = forcedValue;
                            changed = true;
                        } else if (board[rowIndex][colIndex] !== forcedValue) {
                            return false;
                        }
                    }
                }

                for (let colIndex = 0; colIndex < targetSize; colIndex++) {
                    const filteredColPatterns = colDomains[colIndex].filter(pattern => {
                        for (let rowIndex = 0; rowIndex < targetSize; rowIndex++) {
                            if (board[rowIndex][colIndex] !== -1 && board[rowIndex][colIndex] !== pattern[rowIndex]) {
                                return false;
                            }
                        }
                        return true;
                    });

                    if (!filteredColPatterns.length) return false;
                    if (filteredColPatterns.length !== colDomains[colIndex].length) {
                        colDomains[colIndex] = filteredColPatterns;
                        changed = true;
                    }

                    for (let rowIndex = 0; rowIndex < targetSize; rowIndex++) {
                        const forcedValue = getForcedLineValue(colDomains[colIndex], rowIndex);
                        if (forcedValue === -1) continue;

                        if (board[rowIndex][colIndex] === -1) {
                            board[rowIndex][colIndex] = forcedValue;
                            changed = true;
                        } else if (board[rowIndex][colIndex] !== forcedValue) {
                            return false;
                        }
                    }
                }
            }

            return true;
        }

        function isBoardSolved(board) {
            return board.every(row => row.every(cell => cell !== -1));
        }

        function searchSolutions(board, rowDomains, colDomains, limit, counter) {
            if (counter.count >= limit) return;
            if (!propagateConstraints(board, rowDomains, colDomains)) return;

            if (isBoardSolved(board)) {
                counter.count++;
                return;
            }

            let branch = null;

            for (let rowIndex = 0; rowIndex < rowDomains.length; rowIndex++) {
                if (rowDomains[rowIndex].length > 1 && (!branch || rowDomains[rowIndex].length < branch.domainSize)) {
                    branch = { type: 'row', index: rowIndex, domainSize: rowDomains[rowIndex].length };
                }
            }

            for (let colIndex = 0; colIndex < colDomains.length; colIndex++) {
                if (colDomains[colIndex].length > 1 && (!branch || colDomains[colIndex].length < branch.domainSize)) {
                    branch = { type: 'col', index: colIndex, domainSize: colDomains[colIndex].length };
                }
            }

            if (!branch) return;

            const patterns = branch.type === 'row' ? rowDomains[branch.index] : colDomains[branch.index];

            for (const pattern of patterns) {
                if (counter.count >= limit) return;

                const nextBoard = cloneGrid(board);
                const nextRowDomains = cloneDomains(rowDomains);
                const nextColDomains = cloneDomains(colDomains);
                let isContradiction = false;

                if (branch.type === 'row') {
                    nextRowDomains[branch.index] = [pattern];
                    for (let colIndex = 0; colIndex < pattern.length; colIndex++) {
                        if (nextBoard[branch.index][colIndex] !== -1 && nextBoard[branch.index][colIndex] !== pattern[colIndex]) {
                            isContradiction = true;
                            break;
                        }
                        nextBoard[branch.index][colIndex] = pattern[colIndex];
                    }
                } else {
                    nextColDomains[branch.index] = [pattern];
                    for (let rowIndex = 0; rowIndex < pattern.length; rowIndex++) {
                        if (nextBoard[rowIndex][branch.index] !== -1 && nextBoard[rowIndex][branch.index] !== pattern[rowIndex]) {
                            isContradiction = true;
                            break;
                        }
                        nextBoard[rowIndex][branch.index] = pattern[rowIndex];
                    }
                }

                if (isContradiction) continue;
                searchSolutions(nextBoard, nextRowDomains, nextColDomains, limit, counter);
            }
        }

        function countSolutions(rowClues, colClues, limit = 2) {
            const targetSize = rowClues.length;
            const board = Array.from({ length: targetSize }, () => new Array(targetSize).fill(-1));
            const rowDomains = rowClues.map(clues => getLinePatterns(targetSize, clues));
            const colDomains = colClues.map(clues => getLinePatterns(targetSize, clues));
            const counter = { count: 0 };

            searchSolutions(board, rowDomains, colDomains, limit, counter);
            return counter.count;
        }

        function createPuzzle(targetSize, availablePaletteSize) {
            for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
                const solution = createRandomSolution(targetSize, availablePaletteSize);
                if (!solution) continue;

                const { rowClues, colClues } = buildCluesFromSolution(solution);
                const usedColors = getUsedColors(solution);

                if (usedColors.size === availablePaletteSize && countSolutions(rowClues, colClues, 2) === 1) {
                    return { solution, rowClues, colClues };
                }
            }

            throw new Error(`Unable to generate a unique ${targetSize}x${targetSize} color puzzle.`);
        }

        function isValidMatrix(matrix, targetSize, validator) {
            return Array.isArray(matrix) &&
                matrix.length === targetSize &&
                matrix.every(row => Array.isArray(row) && row.length === targetSize && row.every(validator));
        }

        function isValidClueSet(clues, targetSize, availablePaletteSize) {
            return Array.isArray(clues) &&
                clues.length === targetSize &&
                clues.every(line => Array.isArray(line) && line.length > 0 && line.every(item =>
                    item &&
                    Number.isInteger(item.color) &&
                    item.color >= 0 &&
                    item.color <= availablePaletteSize &&
                    Number.isInteger(item.length) &&
                    item.length >= 0
                ));
        }

        function areClueLinesEqual(left, right) {
            return left.length === right.length && left.every((item, index) => {
                return item.color === right[index].color && item.length === right[index].length;
            });
        }

        function validateSavedGameState(savedState) {
            if (!savedState || typeof savedState !== 'object') return null;

            const targetSize = normalizeSize(savedState.size);
            const availablePaletteSize = normalizePaletteSize(savedState.paletteSize);

            if (!isValidMatrix(savedState.solution, targetSize, value => Number.isInteger(value) && value >= 0 && value <= availablePaletteSize)) {
                return null;
            }

            if (!isValidMatrix(savedState.playerState, targetSize, value => Number.isInteger(value) && value >= 0 && value <= availablePaletteSize)) {
                return null;
            }

            if (!isValidClueSet(savedState.rowClues, targetSize, availablePaletteSize)) return null;
            if (!isValidClueSet(savedState.colClues, targetSize, availablePaletteSize)) return null;

            const derivedClues = buildCluesFromSolution(savedState.solution);
            const hasRowMismatch = derivedClues.rowClues.some((line, index) => !areClueLinesEqual(line, savedState.rowClues[index]));
            const hasColMismatch = derivedClues.colClues.some((line, index) => !areClueLinesEqual(line, savedState.colClues[index]));
            const usedColors = getUsedColors(savedState.solution);

            if (hasRowMismatch || hasColMismatch || usedColors.size !== availablePaletteSize) return null;

            return {
                size: targetSize,
                paletteSize: availablePaletteSize,
                solution: cloneGrid(savedState.solution),
                playerState: cloneGrid(savedState.playerState),
                rowClues: savedState.rowClues.map(line => line.map(item => ({ color: item.color, length: item.length }))),
                colClues: savedState.colClues.map(line => line.map(item => ({ color: item.color, length: item.length }))),
                isGameOver: Boolean(savedState.isGameOver),
                resultState: (savedState.isGameOver && (savedState.resultState === RESULT_STATE.WIN || savedState.resultState === RESULT_STATE.REVEALED))
                    ? savedState.resultState
                    : (savedState.isGameOver ? RESULT_STATE.COMPLETED : RESULT_STATE.IN_PROGRESS)
            };
        }

        function validateSavedData(parsed) {
            if (!parsed || typeof parsed !== 'object') return null;

            const validatedState = validateSavedGameState(parsed.gameState);
            if (!validatedState) return null;

            const validHistory = Array.isArray(parsed.actionHistory)
                ? parsed.actionHistory.filter(snapshot => isValidMatrix(snapshot, validatedState.size, value => Number.isInteger(value) && value >= 0 && value <= validatedState.paletteSize))
                : [];

            return {
                currentColor: normalizeColorId(parsed.currentColor, validatedState.paletteSize),
                gameState: validatedState,
                actionHistory: validHistory.map(snapshot => cloneGrid(snapshot))
            };
        }

        function validateSavedStore(parsed) {
            if (!parsed || typeof parsed !== 'object') return null;

            const legacySlot = validateSavedData(parsed);
            if (legacySlot) {
                const legacyKey = getConfigKey(legacySlot.gameState.size, legacySlot.gameState.paletteSize);
                return {
                    activeConfigKey: legacyKey,
                    states: {
                        [legacyKey]: legacySlot
                    }
                };
            }

            if (!parsed.states || typeof parsed.states !== 'object') return null;

            const validatedStates = {};

            Object.values(parsed.states).forEach(slot => {
                const validatedSlot = validateSavedData(slot);
                if (!validatedSlot) return;

                const configKey = getConfigKey(validatedSlot.gameState.size, validatedSlot.gameState.paletteSize);
                validatedStates[configKey] = validatedSlot;
            });

            const availableKeys = Object.keys(validatedStates);
            if (!availableKeys.length) return null;

            const activeConfigKey = typeof parsed.activeConfigKey === 'string' && validatedStates[parsed.activeConfigKey]
                ? parsed.activeConfigKey
                : availableKeys[0];

            return {
                activeConfigKey,
                states: validatedStates
            };
        }

        function createSavedSlot() {
            return {
                currentColor: normalizeColorId(currentColor, gameState.paletteSize),
                gameState: {
                    size: gameState.size,
                    paletteSize: gameState.paletteSize,
                    solution: cloneGrid(gameState.solution),
                    playerState: cloneGrid(gameState.playerState),
                    rowClues: cloneClueSet(gameState.rowClues),
                    colClues: cloneClueSet(gameState.colClues),
                    isGameOver: gameState.isGameOver,
                    resultState: gameState.resultState
                },
                actionHistory: actionHistory.map(snapshot => cloneGrid(snapshot))
            };
        }

        function applySavedSlot(savedSlot) {
            size = savedSlot.gameState.size;
            paletteSize = savedSlot.gameState.paletteSize;
            currentColor = normalizeColorId(savedSlot.currentColor, paletteSize);
            gameState = savedSlot.gameState;
            actionHistory = savedSlot.actionHistory;
        }

        function restoreSession(targetSize, availablePaletteSize) {
            const configKey = getConfigKey(targetSize, availablePaletteSize);
            const savedSlot = savedSessions.states[configKey];

            if (!savedSlot) return false;

            const validatedSlot = validateSavedData(savedSlot);
            if (!validatedSlot) {
                delete savedSessions.states[configKey];
                return false;
            }

            savedSessions.activeConfigKey = configKey;
            applySavedSlot(validatedSlot);
            return true;
        }

        // --- 本地儲存 (Local Storage) ---
        function readJson(key) {
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : null;
            } catch (error) {
                return null;
            }
        }

        function writeJson(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (error) {
                console.warn(`Unable to save ${key}`, error);
            }
        }

        function removeKey(key) {
            try {
                localStorage.removeItem(key);
            } catch (error) {
                console.warn(`Unable to remove ${key}`, error);
            }
        }

        function readStats() {
            const parsed = readJson(STATS_KEY);
            const wins = parsed && typeof parsed.wins === 'object' && parsed.wins ? parsed.wins : {};
            return { wins };
        }

        function saveData() {
            if (!gameState) return;

            const configKey = getConfigKey(gameState.size, gameState.paletteSize);
            savedSessions.activeConfigKey = configKey;
            savedSessions.states[configKey] = createSavedSlot();

            writeJson(SAVE_KEY, {
                activeConfigKey: savedSessions.activeConfigKey,
                isBoardLocked: Boolean(isBoardLocked),
                states: savedSessions.states
            });
        }

        function loadData() {
            // 讀取失敗（隱私模式、封鎖網站資料）一律當作沒有存檔，不能讓盤面載不出來
            let rawData = null;
            try {
                rawData = localStorage.getItem(SAVE_KEY);
            } catch (error) {
                console.warn('Unable to read Color Nonogram save', error);
                return false;
            }
            if (!rawData) return false;

            try {
                const parsed = JSON.parse(rawData);
                const validatedStore = validateSavedStore(parsed);
                if (!validatedStore) {
                    removeKey(SAVE_KEY);
                    savedSessions = createEmptySaveStore();
                    return false;
                }

                savedSessions = validatedStore;
                applySavedSlot(validatedStore.states[validatedStore.activeConfigKey]);

                if (typeof parsed.isBoardLocked === 'boolean') {
                    setBoardLockState(parsed.isBoardLocked);
                }

                syncControls();
                renderBoard();
                showStateMessage();
                return true;
            } catch (error) {
                console.error('localStorage parsing error', error);
                removeKey(SAVE_KEY);
                savedSessions = createEmptySaveStore();
                return false;
            }
        }

        // --- 播報與對話框 (Announcements & Dialogs) ---
        function announce(message) {
            if (!srStatus) return;
            srStatus.textContent = '';
            window.setTimeout(() => { srStatus.textContent = message; }, 30);
        }

        // 原生 <dialog>：showModal() 自帶背景 inert、Esc 關閉與焦點困在對話框內；
        // 關閉後焦點回到開啟它的按鈕
        function openDialog(dialog, initialFocus) {
            const opener = document.activeElement;
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
                confirmDialog.addEventListener('close', () => {
                    confirmCancelBtn.onclick = null;
                    confirmOkBtn.onclick = null;
                    resolve(result);
                }, { once: true });
                confirmCancelBtn.onclick = () => { result = false; confirmDialog.close(); };
                confirmOkBtn.onclick = () => { result = true; confirmDialog.close(); };
                // 會清掉進度的確認一律先停在「取消」，避免連按 Enter 誤刪
                openDialog(confirmDialog, confirmCancelBtn);
            });
        }

        // --- 主題 (Theme) ---
        function syncThemeButton() {
            themeBtn.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
        }

        function toggleTheme() {
            if (themeKit) {
                themeKit.toggle();
            } else {
                // 共用模組載入失敗時的退路：只切換這一頁，不寫入偏好
                const root = document.documentElement;
                root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
            }
            syncThemeButton();
        }

        // --- 控制列 (Controls) ---
        function syncControls() {
            sizeBtns.forEach(btn => {
                const isActive = Number(btn.dataset.size) === size;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
            });

            paletteCountBtns.forEach(btn => {
                const isActive = Number(btn.dataset.count) === paletteSize;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
            });
            updatePaletteButtons();
        }

        function selectColor(colorId) {
            if (colorId < 1 || colorId > paletteSize) return;
            currentColor = colorId;
            updatePaletteButtons();
            saveData();
            announce(`畫筆：${getColorOption(colorId).label}色`);
        }

        function updatePaletteButtons() {
            paletteRow.innerHTML = '';

            COLOR_OPTIONS.forEach(option => {
                if (option.id > paletteSize) return;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `palette-btn color-${option.id}`;
                button.setAttribute('aria-pressed', String(option.id === currentColor));
                button.setAttribute('aria-label', `${option.label}色畫筆（數字鍵 ${option.id}）`);
                button.innerHTML = `<span class="swatch" aria-hidden="true"><span class="glyph">${option.glyph}</span></span><span class="palette-label" aria-hidden="true">${option.label}</span>`;
                if (option.id === currentColor) button.classList.add('active');
                button.addEventListener('click', () => selectColor(option.id));
                paletteRow.appendChild(button);
            });
        }

        function applyPatternAssist(enabled) {
            patternAssist = Boolean(enabled);
            document.body.classList.toggle('pattern-assist', patternAssist);
            patternAssistInput.checked = patternAssist;
        }

        // --- 盤面 (Board) ---
        let cellEls = [];
        let rowClueEls = [];
        let colClueEls = [];
        let focusR = 0;
        let focusC = 0;

        function renderClueLine(clues) {
            return clues.map(item => {
                if (item.length === 0) {
                    return '<span class="clue-number empty" aria-hidden="true">0</span>';
                }
                const option = getColorOption(item.color);
                return `<span class="clue-number color-${item.color}" aria-hidden="true"><span class="clue-glyph">${option.glyph}</span>${item.length}</span>`;
            }).join('');
        }

        function describeClueLine(clues) {
            if (clues.length === 1 && clues[0].length === 0) return '0';
            return clues.map(item => `${getColorOption(item.color).label}${item.length}`).join('、');
        }

        function renderCellValue(cell, value) {
            for (let id = 1; id <= COLOR_OPTIONS.length; id++) {
                cell.classList.toggle(`color-${id}`, value === id);
            }
            cell.classList.toggle('filled', value > 0);
            const r = Number(cell.dataset.r) + 1;
            const c = Number(cell.dataset.c) + 1;
            const state = value > 0 ? `${getColorOption(value).label}色` : '空白';
            cell.setAttribute('aria-label', `第 ${r} 列第 ${c} 欄，${state}`);
        }

        function setFocusCell(r, c, moveFocus = true) {
            if (!cellEls.length) return;
            const previous = cellEls[focusR] && cellEls[focusR][focusC];
            if (previous) previous.tabIndex = -1;
            focusR = Math.min(size - 1, Math.max(0, r));
            focusC = Math.min(size - 1, Math.max(0, c));
            const next = cellEls[focusR][focusC];
            next.tabIndex = 0;
            if (moveFocus) next.focus();
        }

        function renderBoard() {
            if (!gameState) return;

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

            // 每一列用 display: contents 的 row 包起來：視覺上是同一個 CSS grid，
            // 輔助科技看得到「列 → 欄標題／列標題／格子」的表格結構。
            const headerRow = document.createElement('div');
            headerRow.className = 'board-row';
            headerRow.setAttribute('role', 'row');
            const corner = document.createElement('div');
            corner.className = 'clue-cell clue-corner';
            corner.setAttribute('role', 'columnheader');
            corner.setAttribute('aria-label', '線索');
            headerRow.appendChild(corner);

            for (let colIndex = 0; colIndex < size; colIndex++) {
                const clueCell = document.createElement('div');
                clueCell.className = 'clue-cell col-clue';
                clueCell.setAttribute('role', 'columnheader');
                clueCell.setAttribute('aria-label', `第 ${colIndex + 1} 欄：${describeClueLine(gameState.colClues[colIndex])}`);
                clueCell.innerHTML = renderClueLine(gameState.colClues[colIndex]);
                colClueEls[colIndex] = clueCell;
                headerRow.appendChild(clueCell);
            }
            boardEl.appendChild(headerRow);

            for (let rowIndex = 0; rowIndex < size; rowIndex++) {
                const rowEl = document.createElement('div');
                rowEl.className = 'board-row';
                rowEl.setAttribute('role', 'row');

                const rowClue = document.createElement('div');
                rowClue.className = 'clue-cell row-clue';
                rowClue.setAttribute('role', 'rowheader');
                rowClue.setAttribute('aria-label', `第 ${rowIndex + 1} 列：${describeClueLine(gameState.rowClues[rowIndex])}`);
                rowClue.innerHTML = renderClueLine(gameState.rowClues[rowIndex]);
                rowClueEls[rowIndex] = rowClue;
                rowEl.appendChild(rowClue);

                for (let colIndex = 0; colIndex < size; colIndex++) {
                    const cell = document.createElement('div');
                    cell.className = 'cell';
                    cell.dataset.r = rowIndex;
                    cell.dataset.c = colIndex;
                    cell.setAttribute('role', 'gridcell');
                    cell.tabIndex = (rowIndex === focusR && colIndex === focusC) ? 0 : -1;
                    renderCellValue(cell, gameState.playerState[rowIndex][colIndex]);
                    cellEls[rowIndex][colIndex] = cell;
                    // 互動事件統一委派給 boardEl，這裡不逐格掛載
                    rowEl.appendChild(cell);
                }
                boardEl.appendChild(rowEl);
            }

            boardEl.setAttribute('aria-disabled', String(Boolean(gameState.isGameOver)));
            updateActionButtons();
            if (hadFocus) setFocusCell(focusR, focusC, true);
        }

        function showTopMessage(message, tone = '') {
            topMsg.textContent = message;
            topMsg.classList.remove('hidden', 'success', 'error');
            if (tone) topMsg.classList.add(tone);
        }

        function hideTopMessage() {
            topMsg.textContent = '';
            topMsg.classList.add('hidden');
            topMsg.classList.remove('success', 'error');
        }

        function showStateMessage() {
            if (gameState && gameState.isGameOver && gameState.resultState === RESULT_STATE.WIN) {
                showTopMessage('完成了！按「新局」再玩一題。', 'success');
            } else {
                hideTopMessage();
            }
        }

        function clearLineErrors() {
            rowClueEls.concat(colClueEls).forEach(el => el && el.classList.remove('line-error'));
        }

        function isBoardEmpty(playerState) {
            return playerState.every(row => row.every(cell => cell === 0));
        }

        function hasActiveProgress() {
            return gameState && !gameState.isGameOver && !isBoardEmpty(gameState.playerState);
        }

        function updateActionButtons() {
            const noState = !gameState;
            const shouldDisableUndo = noState || gameState.isGameOver || !actionHistory.length;
            const shouldDisableClear = noState || gameState.isGameOver || isBoardEmpty(gameState.playerState);
            const shouldDisableCheck = noState || gameState.isGameOver;

            undoBtn.disabled = shouldDisableUndo;
            clearBoardBtn.disabled = shouldDisableClear;
            checkBtn.disabled = shouldDisableCheck;
        }

        function showGenerationFailure() {
            showTopMessage('題目生成失敗，請再試一次。', 'error');
            announce('題目生成失敗，請再試一次。');
        }

        function initGameData(targetSize, availablePaletteSize) {
            const { solution, rowClues, colClues } = createPuzzle(targetSize, availablePaletteSize);

            gameState = {
                size: targetSize,
                paletteSize: availablePaletteSize,
                solution: solution,
                playerState: createEmptyPlayerState(targetSize),
                rowClues: rowClues,
                colClues: colClues,
                isGameOver: false,
                resultState: RESULT_STATE.IN_PROGRESS
            };

            actionHistory = [];
            saveData();
        }

        function startNewGame() {
            try {
                initGameData(size, paletteSize);
                renderBoard();
                hideTopMessage();
                saveData();
            } catch (error) {
                console.error(error);
                showGenerationFailure();
            }
        }

        async function confirmStartNewGame() {
            if (!hasActiveProgress()) {
                startNewGame();
                return;
            }

            const confirmed = await showConfirmDialog('新的一局', '確定要開始新的一局嗎？目前進度會遺失。', '開始新局');
            if (confirmed) startNewGame();
        }

        function switchSession(targetSize, availablePaletteSize) {
            const previousState = {
                size,
                paletteSize,
                currentColor,
                gameState,
                actionHistory
            };

            try {
                if (!restoreSession(targetSize, availablePaletteSize)) {
                    size = normalizeSize(targetSize);
                    paletteSize = normalizePaletteSize(availablePaletteSize);
                    currentColor = normalizeColorId(currentColor, paletteSize);
                    initGameData(size, paletteSize);
                }

                syncControls();
                renderBoard();
                showStateMessage();
                saveData();
                return true;
            } catch (error) {
                console.error(error);
                size = previousState.size;
                paletteSize = previousState.paletteSize;
                currentColor = previousState.currentColor;
                gameState = previousState.gameState;
                actionHistory = previousState.actionHistory;
                syncControls();
                if (gameState) renderBoard();
                showGenerationFailure();
                return false;
            }
        }

        function handleSizeChange(nextSize) {
            const normalizedSize = normalizeSize(nextSize);
            if (normalizedSize === size) return;
            switchSession(normalizedSize, paletteSize);
        }

        function handlePaletteSizeChange(nextPaletteSize) {
            const normalizedPaletteSize = normalizePaletteSize(nextPaletteSize);
            if (normalizedPaletteSize === paletteSize) return;
            switchSession(size, normalizedPaletteSize);
        }

        function undoLastAction() {
            if (!gameState || gameState.isGameOver || !actionHistory.length) return;

            gameState.playerState = actionHistory.pop();
            gameState.resultState = RESULT_STATE.IN_PROGRESS;
            renderBoard();
            hideTopMessage();
            saveData();
            announce('已復原上一步');
        }

        async function clearBoard() {
            if (!gameState || gameState.isGameOver || isBoardEmpty(gameState.playerState)) return;

            const confirmed = await showConfirmDialog('清空盤面', '確定要清空整個盤面嗎？這會移除目前所有填色。', '確認清空');
            if (!confirmed) return;

            actionHistory.push(cloneGrid(gameState.playerState));
            gameState.playerState = createEmptyPlayerState(size);
            gameState.resultState = RESULT_STATE.IN_PROGRESS;
            renderBoard();
            hideTopMessage();
            saveData();
        }

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

        // --- 指標與觸控 (Pointer & Touch) ---
        function handlePointerDown(event) {
            if (isBoardLocked || !gameState || gameState.isGameOver) return;
            if (event.type === 'touchstart') {
                if (event.touches && event.touches.length > 1) return;
                event.preventDefault();
            }

            const cell = event.target.closest('.cell');
            if (!cell) return;

            const rowIndex = Number(cell.dataset.r);
            const colIndex = Number(cell.dataset.c);
            const currentValue = gameState.playerState[rowIndex][colIndex];

            isDragging = true;
            lastHoveredCell = cell;
            dragSnapshot = cloneGrid(gameState.playerState);
            dragHistoryCommitted = false;
            dragAction = currentValue === currentColor
                ? { type: 'erase', color: currentColor }
                : { type: 'paint', color: currentColor };
            setFocusCell(rowIndex, colIndex, false);

            applyAction(cell, rowIndex, colIndex);
        }

        // 註：使用會冒泡的 mouseover 以便委派（mouseenter 不冒泡）。
        let lastHoveredCell = null;

        // 快速拖曳時兩次事件之間可能跳過好幾格，用直線插值補上中間經過的格子
        function dragTo(cell) {
            if (!cell || cell === lastHoveredCell) return;
            if (lastHoveredCell) {
                const r0 = Number(lastHoveredCell.dataset.r);
                const c0 = Number(lastHoveredCell.dataset.c);
                const r1 = Number(cell.dataset.r);
                const c1 = Number(cell.dataset.c);
                const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
                for (let i = 1; i <= steps; i++) {
                    const r = Math.round(r0 + (r1 - r0) * (i / steps));
                    const c = Math.round(c0 + (c1 - c0) * (i / steps));
                    if (cellEls[r] && cellEls[r][c]) applyAction(cellEls[r][c], r, c);
                }
            } else {
                applyAction(cell, Number(cell.dataset.r), Number(cell.dataset.c));
            }
            lastHoveredCell = cell;
        }

        function handlePointerEnter(event) {
            if (isBoardLocked || !isDragging || !gameState || gameState.isGameOver) return;
            dragTo(event.target.closest('.cell'));
        }

        function handleTouchMove(event) {
            if (isBoardLocked || !isDragging || !gameState || gameState.isGameOver) return;

            event.preventDefault();
            const touch = event.touches[0];
            const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);
            const cell = targetElement && targetElement.closest ? targetElement.closest('.cell') : null;
            if (cell && boardEl.contains(cell)) dragTo(cell);
        }

        function handlePointerUp() {
            if (!isDragging) return;

            isDragging = false;
            lastHoveredCell = null;
            dragAction = null;
            dragSnapshot = null;
            dragHistoryCommitted = false;
            saveData();
        }

        function applyAction(cell, rowIndex, colIndex) {
            if (!dragAction) return;

            const currentValue = gameState.playerState[rowIndex][colIndex];
            let nextValue = currentValue;

            if (dragAction.type === 'paint') {
                nextValue = dragAction.color;
            } else if (dragAction.type === 'erase' && currentValue === dragAction.color) {
                nextValue = 0;
            } else if (dragAction.type === 'clear') {
                nextValue = 0;
            }

            if (currentValue === nextValue) return;

            if (!dragHistoryCommitted && dragSnapshot) {
                actionHistory.push(dragSnapshot);
                dragHistoryCommitted = true;
            }
            gameState.playerState[rowIndex][colIndex] = nextValue;
            renderCellValue(cell, nextValue);
            clearLineErrors();
            updateActionButtons();

            if (!gameState.isGameOver) hideTopMessage();
        }

        // --- 鍵盤 (Keyboard) ---
        function editCellByKeyboard(rowIndex, colIndex, action) {
            if (!gameState || gameState.isGameOver) return;
            if (isBoardLocked) {
                announce('盤面已鎖定，先按鎖頭解鎖');
                return;
            }
            const currentValue = gameState.playerState[rowIndex][colIndex];
            dragSnapshot = cloneGrid(gameState.playerState);
            dragHistoryCommitted = false;
            if (action === 'clear') {
                dragAction = { type: 'clear' };
            } else {
                dragAction = currentValue === currentColor
                    ? { type: 'erase', color: currentColor }
                    : { type: 'paint', color: currentColor };
            }
            applyAction(cellEls[rowIndex][colIndex], rowIndex, colIndex);
            dragAction = null;
            dragSnapshot = null;
            dragHistoryCommitted = false;
            saveData();
        }

        function handleBoardKeydown(event) {
            const cell = event.target.closest('.cell');
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
            if (moves[event.key]) {
                event.preventDefault();
                setFocusCell(moves[event.key][0], moves[event.key][1], true);
            } else if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                editCellByKeyboard(r, c, 'paint');
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                editCellByKeyboard(r, c, 'clear');
            }
        }

        // --- 對答案 (Check) ---
        function isPlayerSolutionCorrect() {
            return gameState.playerState.every((row, rowIndex) => {
                return row.every((value, colIndex) => value === gameState.solution[rowIndex][colIndex]);
            });
        }

        function findMismatchedLines() {
            const rows = [];
            const cols = [];
            for (let r = 0; r < size; r++) {
                if (!areClueLinesEqual(getColorClues(gameState.playerState[r]), gameState.rowClues[r])) rows.push(r);
            }
            for (let c = 0; c < size; c++) {
                const column = gameState.playerState.map(row => row[c]);
                if (!areClueLinesEqual(getColorClues(column), gameState.colClues[c])) cols.push(c);
            }
            return { rows, cols };
        }

        function describeLines(indexes, unit) {
            if (!indexes.length) return '';
            const shown = indexes.slice(0, 4).map(i => i + 1).join('、');
            return indexes.length > 4 ? `共 ${indexes.length} ${unit}（第 ${shown}…${unit}）` : `第 ${shown} ${unit}`;
        }

        // 過關卡片裡的完成彩色圖，填色格依序塗上（減少動態效果時由 CSS 直接顯示）
        function buildResultPicture() {
            const picture = document.createElement('div');
            picture.className = 'result-picture is-revealing';
            picture.setAttribute('role', 'img');
            picture.setAttribute('aria-label', `完成的 ${size}×${size} 彩色圖`);
            picture.style.setProperty('--picture-size', String(size));
            const filled = gameState.solution.reduce((n, row) => n + row.filter(v => v > 0).length, 0);
            picture.style.setProperty('--step', `${Math.max(6, Math.round(900 / Math.max(1, filled)))}ms`);
            let order = 0;
            gameState.solution.forEach(row => row.forEach(value => {
                const cell = document.createElement('span');
                if (value > 0) {
                    cell.className = `on color-${value}`;
                    cell.style.setProperty('--i', String(order++));
                }
                picture.appendChild(cell);
            }));
            return picture;
        }

        function recordWin() {
            const stats = readStats();
            const key = getConfigKey();
            stats.wins[key] = (Number(stats.wins[key]) || 0) + 1;
            writeJson(STATS_KEY, stats);
            return stats.wins[key];
        }

        function checkAnswer() {
            if (!gameState || gameState.isGameOver) return;

            isDragging = false;
            dragAction = null;
            dragSnapshot = null;
            dragHistoryCommitted = false;
            clearLineErrors();

            if (isPlayerSolutionCorrect()) {
                gameState.isGameOver = true;
                gameState.resultState = RESULT_STATE.WIN;
                actionHistory = [];
                renderBoard();
                showStateMessage();
                saveData();

                const winCount = recordWin();
                const celebrate = (typeof BoboCelebrate !== 'undefined') ? BoboCelebrate : null;
                if (celebrate) {
                    celebrate.show({
                        outcome: 'win',
                        gameName: '彩色數織',
                        title: '完成了！',
                        subtitle: `${paletteSize} 種顏色全部推理到位，整幅圖都上色了。`,
                        stats: [
                            { label: '盤面', value: `${size}×${size}・${paletteSize} 色` },
                            { label: '這個設定已完成', value: `${winCount} 題` }
                        ],
                        extra: buildResultPicture(),
                        accent: '#1d4ed8',
                        accentDark: '#93c5fd',
                        // 過關後「對答案」等按鈕會收起來，焦點一律交還給盤面上的格子
                        primary: { label: '再來一局', onClick: () => { startNewGame(); setFocusCell(focusR, focusC, true); } },
                        secondary: { label: '看盤面' },
                        onClose: (reason) => { if (reason !== 'primary') setFocusCell(focusR, focusC, true); }
                    });
                } else {
                    announce(`完成了！${size}×${size}・${paletteSize} 色，這個設定已完成 ${winCount} 題`);
                }
                return;
            }

            const { rows, cols } = findMismatchedLines();
            rows.forEach(r => rowClueEls[r] && rowClueEls[r].classList.add('line-error'));
            cols.forEach(c => colClueEls[c] && colClueEls[c].classList.add('line-error'));
            const parts = [describeLines(rows, '列'), describeLines(cols, '欄')].filter(Boolean);
            const message = parts.length
                ? `還沒對：${parts.join('，')}和數字對不上（已標成紅框）`
                : '你再想想看';
            showTopMessage(message, 'error');
            announce(message);
        }

        // --- 事件綁定 (Events) ---
        sizeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                handleSizeChange(btn.dataset.size);
            });
        });

        paletteCountBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                handlePaletteSizeChange(btn.dataset.count);
            });
        });

        patternAssistInput.addEventListener('change', () => {
            applyPatternAssist(patternAssistInput.checked);
            writeJson(PREFS_KEY, { patternAssist });
        });

        boardLockBtn.addEventListener('click', toggleBoardLock);
        newGameBtn.addEventListener('click', confirmStartNewGame);
        undoBtn.addEventListener('click', undoLastAction);
        clearBoardBtn.addEventListener('click', clearBoard);
        checkBtn.addEventListener('click', checkAnswer);
        themeBtn.addEventListener('click', toggleTheme);
        rulesBtn.addEventListener('click', () => openDialog(rulesDialog, rulesCloseBtn));
        rulesCloseBtn.addEventListener('click', () => rulesDialog.close());

        // 盤面互動一律走事件委派，盤面重繪時也不必重新掛載
        boardEl.addEventListener('mousedown', handlePointerDown);
        boardEl.addEventListener('mouseover', handlePointerEnter);
        boardEl.addEventListener('touchstart', handlePointerDown, { passive: false });
        boardEl.addEventListener('touchmove', handleTouchMove, { passive: false });
        boardEl.addEventListener('keydown', handleBoardKeydown);
        boardEl.addEventListener('focusin', event => {
            const cell = event.target.closest('.cell');
            if (cell) setFocusCell(Number(cell.dataset.r), Number(cell.dataset.c), false);
        });

        document.addEventListener('mouseup', handlePointerUp);
        document.addEventListener('touchend', handlePointerUp);
        document.addEventListener('touchcancel', handlePointerUp);
        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                undoLastAction();
                return;
            }
            // 數字鍵換畫筆顏色（在輸入框以外、沒有開對話框時）
            if (/^[1-4]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey
                && !document.querySelector('dialog[open]')) {
                selectColor(Number(event.key));
            }
        });

        // --- 初始化 (Initialization) ---
        // 主題跟著全站偏好走：BoboTheme.init() 只套用、不寫入
        if (themeKit) themeKit.init();
        syncThemeButton();
        new MutationObserver(syncThemeButton)
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        applyPatternAssist(Boolean(readJson(PREFS_KEY)?.patternAssist));

        if (!loadData()) {
            try {
                initGameData(size, paletteSize);
                syncControls();
                renderBoard();
            } catch (error) {
                console.error(error);
                syncControls();
                showGenerationFailure();
            }
        }
