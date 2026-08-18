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

        const SAVE_KEY = 'color_nonogram_save_data';
        const DEFAULT_SIZE = 8;
        const DEFAULT_PALETTE_SIZE = 4;
        const ALLOWED_SIZES = [8, 10, 12];
        const ALLOWED_PALETTE_SIZES = [2, 3, 4];
        const RESULT_STATE = {
            IN_PROGRESS: 'in-progress',
            WIN: 'win'
        };
        const COLOR_OPTIONS = [
            { id: 1, label: '紅', color: '#F87171' },
            { id: 2, label: '青', color: '#2DD4BF' },
            { id: 3, label: '黃', color: '#FBBF24' },
            { id: 4, label: '藍', color: '#60A5FA' }
        ];
        const MAX_GENERATION_ATTEMPTS = 120;
        const linePatternCache = new Map();

        const sizeBtns = document.querySelectorAll('#size-toggle .mode-btn');
        const paletteCountBtns = document.querySelectorAll('#palette-count-toggle .mode-btn');
        const containerEl = document.querySelector('.container');
        const topBarEl = document.querySelector('.top-bar');
        const titleWrapEl = document.querySelector('.title-wrap');
        const controlStackEl = document.querySelector('.control-stack');
        const actionMsgContainerEl = document.querySelector('.action-msg-container');
        const boardWrapperEl = document.querySelector('.game-board-wrapper');
        const statusAreaEl = document.querySelector('.status-area');
        const paletteRow = document.getElementById('palette-row');
        const topMsg = document.getElementById('top-msg');
        const boardEl = document.getElementById('board');
        const undoBtn = document.getElementById('undo-btn');
        const newGameBtn = document.getElementById('new-game-btn');
        const clearBoardBtn = document.getElementById('clear-board-btn');
        const checkBtn = document.getElementById('check-btn');
        const confirmOverlay = document.getElementById('confirm-overlay');
        const confirmTitle = document.getElementById('confirm-title');
        const confirmMessage = document.getElementById('confirm-message');
        const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
        const confirmOkBtn = document.getElementById('confirm-ok-btn');
        const boardLockBtn = document.getElementById('board-lock-btn');

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

        function getColorValue(colorId) {
            return COLOR_OPTIONS.find(option => option.id === colorId)?.color || '#E0E0E0';
        }

        function getStyleNumber(element, propertyName) {
            if (!element) return 0;
            return Number.parseFloat(window.getComputedStyle(element)[propertyName]) || 0;
        }

        function getDefaultCellSize(targetSize) {
            if (targetSize === 12) return 26;
            if (targetSize === 10) return 30;
            return 36;
        }

        function getMinimumCellSize(targetSize) {
            if (targetSize === 12) return 14;
            if (targetSize === 10) return 17;
            return 19;
        }

        function getRowClueWidth() {
            if (window.innerHeight <= 760) return 48;
            if (window.innerWidth <= 480) return 52;
            return 58;
        }

        function getCellSize(targetSize) {
            const defaultCellSize = getDefaultCellSize(targetSize);
            const minimumCellSize = getMinimumCellSize(targetSize);
            const viewportWidth = window.innerWidth || 0;
            const viewportHeight = window.innerHeight || 0;

            if (!viewportWidth || !viewportHeight) return defaultCellSize;

            const bodyPaddingX = getStyleNumber(document.body, 'padding-left') + getStyleNumber(document.body, 'padding-right');
            const bodyPaddingY = getStyleNumber(document.body, 'padding-top') + getStyleNumber(document.body, 'padding-bottom');
            const containerGap = getStyleNumber(containerEl, 'gap');
            const boardWrapperPaddingX = getStyleNumber(boardWrapperEl, 'padding-left') + getStyleNumber(boardWrapperEl, 'padding-right');
            const boardWrapperPaddingY = getStyleNumber(boardWrapperEl, 'padding-top') + getStyleNumber(boardWrapperEl, 'padding-bottom');
            const reservedHeight =
                bodyPaddingY +
                (topBarEl?.offsetHeight || 0) +
                (titleWrapEl?.offsetHeight || 0) +
                (controlStackEl?.offsetHeight || 0) +
                (actionMsgContainerEl?.offsetHeight || 0) +
                (statusAreaEl?.offsetHeight || 0) +
                boardWrapperPaddingY +
                (containerGap * 5) +
                8;
            const availableBoardHeight = viewportHeight - reservedHeight;
            const heightLimitedCellSize = Math.floor((availableBoardHeight - 2) / (targetSize + 1));

            const reservedWidth = bodyPaddingX + boardWrapperPaddingX + getRowClueWidth() + 4;
            const availableBoardWidth = viewportWidth - reservedWidth;
            const widthLimitedCellSize = Math.floor(availableBoardWidth / targetSize);

            const computedCellSize = Math.min(
                defaultCellSize,
                heightLimitedCellSize > 0 ? heightLimitedCellSize : defaultCellSize,
                widthLimitedCellSize > 0 ? widthLimitedCellSize : defaultCellSize
            );

            return Math.max(minimumCellSize, computedCellSize);
        }

        // 盤面未縮放時的高度。盤面重建時失效，其餘情況（例如顯示提示訊息）可重複使用，
        // 省去「先還原成 scale(1) 再量測」那一輪寫入與強制排版
        let naturalBoardHeight = 0;

        function invalidateBoardMetrics() {
            naturalBoardHeight = 0;
        }

        function fitBoardToViewport() {
            if (!gameState) return;

            const viewportHeight = window.innerHeight || 0;
            if (!viewportHeight) return;

            // ── 量測階段：只讀不寫 ──
            if (!naturalBoardHeight) {
                // 尚未量過原始高度，得先還原縮放才能取得正確值
                boardEl.style.transform = 'scale(1)';
                boardEl.style.transformOrigin = 'top center';
                boardWrapperEl.style.height = 'auto';
                naturalBoardHeight = boardEl.getBoundingClientRect().height;
            }

            const boardHeight = naturalBoardHeight;
            if (!boardHeight) return;

            const renderedHeight = boardEl.getBoundingClientRect().height;
            const nonBoardHeight = document.documentElement.scrollHeight - renderedHeight;
            const availableBoardHeight = viewportHeight - nonBoardHeight;
            const wrapperPaddingY = getStyleNumber(boardWrapperEl, 'padding-top') + getStyleNumber(boardWrapperEl, 'padding-bottom');

            const scale = availableBoardHeight >= boardHeight
                ? 1
                : Math.max(0.58, Math.min(1, availableBoardHeight / boardHeight));

            // ── 套用階段：量測全部完成後才寫入 ──
            boardEl.style.transformOrigin = 'top center';
            boardEl.style.transform = `scale(${scale})`;
            boardWrapperEl.style.height = scale === 1
                ? 'auto'
                : `${Math.ceil((boardHeight * scale) + wrapperPaddingY)}px`;
        }

        // 同一幀內只重算一次縮放，避免 resize 連續觸發時反覆排版
        let fitFrame = 0;
        function scheduleFitBoardToViewport() {
            if (fitFrame) return;
            fitFrame = requestAnimationFrame(() => {
                fitFrame = 0;
                fitBoardToViewport();
            });
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

        function saveData() {
            if (!gameState) return;

            const configKey = getConfigKey(gameState.size, gameState.paletteSize);
            savedSessions.activeConfigKey = configKey;
            savedSessions.states[configKey] = createSavedSlot();

            try {
                localStorage.setItem(SAVE_KEY, JSON.stringify({
                    activeConfigKey: savedSessions.activeConfigKey,
                    isBoardLocked: Boolean(isBoardLocked),
                    states: savedSessions.states
                }));
            } catch (error) {
                console.warn('Unable to save Color Nonogram state to localStorage', error);
            }
        }

        function loadData() {
            const rawData = localStorage.getItem(SAVE_KEY);
            if (!rawData) return false;

            try {
                const parsed = JSON.parse(rawData);
                const validatedStore = validateSavedStore(parsed);
                if (!validatedStore) {
                    localStorage.removeItem(SAVE_KEY);
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
                updateSelectedColorIndicator();

                if (gameState.isGameOver && gameState.resultState === RESULT_STATE.WIN) {
                    showTopMessage('答對了！', 'success');
                } else {
                    hideTopMessage();
                }

                saveData();

                return true;
            } catch (error) {
                console.error('localStorage parsing error', error);
                localStorage.removeItem(SAVE_KEY);
                savedSessions = createEmptySaveStore();
                return false;
            }
        }

        function syncControls() {
            sizeBtns.forEach(btn => {
                btn.classList.toggle('active', Number(btn.dataset.size) === size);
            });

            paletteCountBtns.forEach(btn => {
                btn.classList.toggle('active', Number(btn.dataset.count) === paletteSize);
            });
            updatePaletteButtons();
        }

        function updateSelectedColorIndicator() {
            return;
        }

        function updatePaletteButtons() {
            paletteRow.innerHTML = '';

            COLOR_OPTIONS.forEach(option => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'palette-btn';
                button.style.setProperty('--swatch-color', option.color);
                button.setAttribute('aria-label', `選擇 ${option.label} 色`);

                if (option.id === currentColor) {
                    button.classList.add('active');
                }

                if (option.id > paletteSize) {
                    button.disabled = true;
                    button.classList.add('disabled');
                }

                button.addEventListener('click', () => {
                    if (option.id > paletteSize) return;
                    currentColor = option.id;
                    updatePaletteButtons();
                    updateSelectedColorIndicator();
                    if (!gameState || !gameState.isGameOver) hideTopMessage();
                    saveData();
                });

                paletteRow.appendChild(button);
            });
        }

        function renderClueLine(clues) {
            return clues.map(item => {
                if (item.length === 0) {
                    return '<span class="clue-number empty">0</span>';
                }

                return `<span class="clue-number" style="color:${getColorValue(item.color)};">${item.length}</span>`;
            }).join('');
        }

        function renderCellValue(cell, value) {
            cell.classList.toggle('filled', value > 0);
            if (value > 0) {
                cell.style.setProperty('--fill-color', getColorValue(value));
            } else {
                cell.style.removeProperty('--fill-color');
            }
        }

        function renderBoard() {
            if (!gameState) return;

            const cellSize = `${getCellSize(size)}px`;
            boardEl.style.setProperty('--cell-size', cellSize);
            boardEl.style.gridTemplateColumns = `max-content repeat(${size}, ${cellSize})`;
            boardEl.innerHTML = '';

            const emptyCorner = document.createElement('div');
            emptyCorner.className = 'clue-cell';
            boardEl.appendChild(emptyCorner);

            for (let colIndex = 0; colIndex < size; colIndex++) {
                const clueCell = document.createElement('div');
                clueCell.className = 'clue-cell';
                clueCell.innerHTML = renderClueLine(gameState.colClues[colIndex]);
                boardEl.appendChild(clueCell);
            }

            for (let rowIndex = 0; rowIndex < size; rowIndex++) {
                const rowClue = document.createElement('div');
                rowClue.className = 'clue-cell row-clue';
                rowClue.innerHTML = renderClueLine(gameState.rowClues[rowIndex]);
                boardEl.appendChild(rowClue);

                for (let colIndex = 0; colIndex < size; colIndex++) {
                    const cell = document.createElement('div');
                    cell.className = 'cell';
                    cell.dataset.r = rowIndex;
                    cell.dataset.c = colIndex;

                    renderCellValue(cell, gameState.playerState[rowIndex][colIndex]);

                    // 互動事件統一委派給 boardEl，這裡不逐格掛載
                    boardEl.appendChild(cell);
                }
            }

            updateActionButtons();
            invalidateBoardMetrics();
            fitBoardToViewport();
        }

        function showTopMessage(message, tone = '') {
            topMsg.textContent = message;
            topMsg.classList.remove('hidden', 'success', 'error');
            if (tone) topMsg.classList.add(tone);
            fitBoardToViewport();
        }

        function hideTopMessage() {
            topMsg.textContent = '';
            topMsg.classList.add('hidden');
            topMsg.classList.remove('success', 'error');
            fitBoardToViewport();
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

            undoBtn.setAttribute('aria-disabled', String(shouldDisableUndo));
            clearBoardBtn.setAttribute('aria-disabled', String(shouldDisableClear));
            checkBtn.setAttribute('aria-disabled', String(shouldDisableCheck));
        }

        function showGenerationFailure() {
            showTopMessage('題目生成失敗，請再試一次。', 'error');
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
                updateSelectedColorIndicator();
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

        function showConfirmDialog(title, message, confirmLabel) {
            return new Promise(resolve => {
                confirmTitle.textContent = title;
                confirmMessage.textContent = message;
                confirmOkBtn.textContent = confirmLabel;
                confirmOverlay.classList.remove('hidden');
                confirmOverlay.setAttribute('aria-hidden', 'false');

                const finish = (result) => {
                    confirmOverlay.classList.add('hidden');
                    confirmOverlay.setAttribute('aria-hidden', 'true');
                    confirmCancelBtn.onclick = null;
                    confirmOkBtn.onclick = null;
                    resolve(result);
                };

                confirmCancelBtn.onclick = () => finish(false);
                confirmOkBtn.onclick = () => finish(true);
            });
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
                updateSelectedColorIndicator();

                if (gameState.isGameOver && gameState.resultState === RESULT_STATE.WIN) {
                    showTopMessage('答對了！', 'success');
                } else {
                    hideTopMessage();
                }

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
            boardLockBtn.setAttribute('aria-label', isBoardLocked ? '解鎖盤面' : '鎖定盤面 (防誤觸)');
            boardLockBtn.title = isBoardLocked ? '解鎖盤面' : '鎖定盤面 (防誤觸)';
            boardEl.classList.toggle('board-locked', isBoardLocked);
            if (isBoardLocked && isDragging) {
                handlePointerUp();
            }
        }

        function toggleBoardLock() {
            setBoardLockState(!isBoardLocked);
            saveData();
        }

        function handlePointerDown(event) {
            if (isBoardLocked || !gameState || gameState.isGameOver) return;
            if (event.type === 'touchstart') event.preventDefault();

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

            applyAction(cell, rowIndex, colIndex);
        }

        // 註：使用會冒泡的 mouseover 以便委派（mouseenter 不冒泡）。
        // 在同一格內移動會重複觸發，因此記住上一格避免多餘工作
        let lastHoveredCell = null;

        function handlePointerEnter(event) {
            if (isBoardLocked || !isDragging || !gameState || gameState.isGameOver) return;

            const cell = event.target.closest('.cell');
            if (!cell || cell === lastHoveredCell) return;
            lastHoveredCell = cell;

            applyAction(cell, Number(cell.dataset.r), Number(cell.dataset.c));
        }

        function handleTouchMove(event) {
            if (isBoardLocked || !isDragging || !gameState || gameState.isGameOver) return;

            event.preventDefault();
            const touch = event.touches[0];
            const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);

            if (targetElement && targetElement.classList.contains('cell')) {
                applyAction(targetElement, Number(targetElement.dataset.r), Number(targetElement.dataset.c));
            }
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
            }

            if (currentValue === nextValue) return;

            if (!dragHistoryCommitted && dragSnapshot) {
                actionHistory.push(dragSnapshot);
                dragHistoryCommitted = true;
            }
            gameState.playerState[rowIndex][colIndex] = nextValue;
            renderCellValue(cell, nextValue);
            updateActionButtons();

            if (!gameState.isGameOver) hideTopMessage();
            saveData();
        }

        function isPlayerSolutionCorrect() {
            return gameState.playerState.every((row, rowIndex) => {
                return row.every((value, colIndex) => value === gameState.solution[rowIndex][colIndex]);
            });
        }

        function checkAnswer() {
            if (!gameState || gameState.isGameOver) return;

            isDragging = false;
            dragAction = null;
            dragSnapshot = null;
            dragHistoryCommitted = false;

            if (isPlayerSolutionCorrect()) {
                gameState.isGameOver = true;
                gameState.resultState = RESULT_STATE.WIN;
                actionHistory = [];
                renderBoard();
                showTopMessage('答對了！', 'success');
                saveData();
                return;
            }

            showTopMessage('你再想想看', 'error');
        }

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

        boardLockBtn.addEventListener('click', toggleBoardLock);
        newGameBtn.addEventListener('click', confirmStartNewGame);
        undoBtn.addEventListener('click', undoLastAction);
        clearBoardBtn.addEventListener('click', clearBoard);
        checkBtn.addEventListener('click', checkAnswer);

        // 盤面互動一律走事件委派：這四個監聽器取代原本每格各掛四個的做法，
        // 盤面重繪時也不必重新掛載
        boardEl.addEventListener('mousedown', handlePointerDown);
        boardEl.addEventListener('mouseover', handlePointerEnter);
        boardEl.addEventListener('touchstart', handlePointerDown, { passive: false });
        boardEl.addEventListener('touchmove', handleTouchMove, { passive: false });

        document.addEventListener('mouseup', handlePointerUp);
        document.addEventListener('touchend', handlePointerUp);
        document.addEventListener('touchcancel', handlePointerUp);
        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                undoLastAction();
            }
        });
        // resize 只會改變可用高度，格子數與內容都沒變，
        // 因此重算縮放即可，不需要重建整個盤面
        window.addEventListener('resize', () => {
            if (!gameState) return;
            invalidateBoardMetrics();
            scheduleFitBoardToViewport();
        });

        if (!loadData()) {
            try {
                initGameData(size, paletteSize);
                syncControls();
                renderBoard();
                updateSelectedColorIndicator();
            } catch (error) {
                console.error(error);
                syncControls();
                updateSelectedColorIndicator();
                showGenerationFailure();
            }
        }
