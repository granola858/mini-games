// 配對遊戲（翻牌記憶）
// 規則：每次翻兩張，圖形與顏色都一樣就留著，不一樣自動蓋回；全部配完過關。
// 盤面是 role="grid" + roving tabindex：整個盤面只有一個 Tab 停點，方向鍵移動、Enter／空白鍵翻牌。
(() => {
    'use strict';

    const CONFIG = Object.freeze({
        easy: { rows: 5, cols: 4 },
        medium: { rows: 6, cols: 5 },
        hard: { rows: 7, cols: 6 }
    });
    const LEVEL_NAMES = Object.freeze({ easy: '簡單', medium: '中等', hard: '困難' });

    // 圖形與顏色池：顏色都在白色卡面上 ≥ 4.5:1，圖形本身是關鍵資訊（WCAG 1.4.11 至少 3:1）
    const SHAPES = Object.freeze([
        { id: 'circle', name: '圓形' },
        { id: 'rect', name: '方形' },
        { id: 'triangle', name: '三角形' },
        { id: 'diamond', name: '菱形' },
        { id: 'cross', name: '叉叉' },
        { id: 'star', name: '星形' },
        { id: 'hexagon', name: '六角形' }
    ]);
    const COLORS = Object.freeze([
        { hex: '#9C27B0', name: '紫色' },
        { hex: '#D32F2F', name: '紅色' },
        { hex: '#1976D2', name: '藍色' },
        { hex: '#2E7D32', name: '綠色' },
        { hex: '#E65100', name: '橘色' },
        { hex: '#6D4C41', name: '棕色' },
        { hex: '#546E7A', name: '灰藍色' },
        { hex: '#C2185B', name: '桃紅色' }
    ]);

    const STATE_KEY = 'pair_state_v1';
    const STATS_KEY = 'pair_stats_v1';
    const PREFS_KEY = 'pair_prefs_v1';
    const UNFLIP_DELAY = 800;

    // ---------------------------------------------------------------------
    // 存取（所有 localStorage 操作一律包 try/catch：隱私模式或被封鎖時遊戲照常可玩）
    // ---------------------------------------------------------------------
    function readJSON(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) { /* 存不了就算了，不影響這一局 */ }
    }

    function removeKey(key) {
        try {
            localStorage.removeItem(key);
        } catch (_) { /* 同上 */ }
    }

    // ---------------------------------------------------------------------
    // 狀態
    // ---------------------------------------------------------------------
    const game = {
        level: 'easy',
        deck: [],          // [{ s: 圖形索引, c: 顏色索引 }]
        matched: new Set(),
        revealed: [],      // 目前翻開、尚未判定的牌（最多兩張）
        moves: 0,
        elapsedMs: 0,
        runningSince: null,
        locked: false,
        won: false,
        focusIndex: 0,
        lastFlipped: null
    };
    let stats = {};
    let unflipTimer = null;
    let tickTimer = null;
    let pendingLevel = null; // 確認框按下「放棄並重來」時要開的難度

    // ---------------------------------------------------------------------
    // DOM
    // ---------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const board = $('game-container');
    const movesEl = $('moves');
    const pairsEl = $('pairs');
    const timerEl = $('timer');
    const bestEl = $('best');
    const statusEl = $('game-status');
    const restartBtn = $('restart-btn');
    const themeBtn = $('theme-btn');
    const rulesBtn = $('rules-btn');
    const confirmDialog = $('confirm-dialog');
    const rulesDialog = $('rules-dialog');
    const levelButtons = Array.from(document.querySelectorAll('.mode-btn[data-level]'));
    let cardButtons = [];

    // 全站共用過關卡片（彩帶也由它放）；沒載入時遊戲照常可玩，只是少了卡片
    const celebrate = (typeof BoboCelebrate !== 'undefined') ? BoboCelebrate : null;

    // 卡背圖騰：四種盤面圖形排成一枚徽記，像紙牌背面的花紋（只是裝飾，不帶資訊）
    const CARD_BACK_EMBLEM = `<svg class="card-emblem" viewBox="0 0 40 40" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="5" />
        <polygon points="28,6.5 33.5,17 22.5,17" />
        <rect x="7" y="23" width="10" height="10" rx="1.5" />
        <polygon points="28,22.5 33.5,28 28,33.5 22.5,28" />
    </svg>`;

    // ---------------------------------------------------------------------
    // 小工具
    // ---------------------------------------------------------------------
    const totalPairs = (level = game.level) => (CONFIG[level].rows * CONFIG[level].cols) / 2;
    const cardName = (card) => `${COLORS[card.c].name}${SHAPES[card.s].name}`;

    function formatTime(ms) {
        const sec = Math.max(0, Math.floor(ms / 1000));
        return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }

    function announce(message) {
        // 清空再寫入，連續兩次同樣的訊息報讀器也會唸
        statusEl.textContent = '';
        window.setTimeout(() => { statusEl.textContent = message; }, 30);
    }

    function shuffle(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    function buildDeck(pairs) {
        const deck = [];
        for (let i = 0; i < pairs; i++) {
            const card = { s: i % SHAPES.length, c: Math.floor(i / SHAPES.length) % COLORS.length };
            deck.push({ ...card }, { ...card });
        }
        return shuffle(deck);
    }

    function svgFor(card) {
        const color = COLORS[card.c].hex;
        let shape = '';
        switch (SHAPES[card.s].id) {
            case 'circle': shape = '<circle cx="50" cy="50" r="38" />'; break;
            case 'rect': shape = '<rect x="15" y="15" width="70" height="70" rx="10" />'; break;
            case 'triangle': shape = '<polygon points="50,13 90,85 10,85" />'; break;
            case 'diamond': shape = '<polygon points="50,8 92,50 50,92 8,50" />'; break;
            case 'cross': shape = '<path d="M22,22 L78,78 M78,22 L22,78" stroke-width="15" stroke-linecap="round" />'; break;
            case 'star': shape = '<polygon points="50,8 62,36 92,36 68,56 77,88 50,68 23,88 32,56 8,36 38,36" />'; break;
            case 'hexagon': shape = '<polygon points="50,8 87,29 87,71 50,92 13,71 13,29" />'; break;
            default: break;
        }
        const paint = SHAPES[card.s].id === 'cross' ? `stroke="${color}" fill="none"` : `fill="${color}"`;
        return `<svg viewBox="0 0 100 100" class="shape-svg" ${paint} aria-hidden="true">${shape}</svg>`;
    }

    // ---------------------------------------------------------------------
    // 計時（第一次翻牌才開始；切到背景暫停）
    // ---------------------------------------------------------------------
    function currentElapsed() {
        return game.elapsedMs + (game.runningSince === null ? 0 : performance.now() - game.runningSince);
    }

    function startTimer() {
        if (game.runningSince !== null || game.won) return;
        game.runningSince = performance.now();
        if (!tickTimer) tickTimer = window.setInterval(renderTimer, 1000);
    }

    function stopTimer() {
        if (game.runningSince !== null) {
            game.elapsedMs = currentElapsed();
            game.runningSince = null;
        }
        if (tickTimer) {
            window.clearInterval(tickTimer);
            tickTimer = null;
        }
        renderTimer();
    }

    function renderTimer() {
        timerEl.textContent = formatTime(currentElapsed());
    }

    // ---------------------------------------------------------------------
    // 存檔（AGENTS.md：save／load／clear 三件組）
    // ---------------------------------------------------------------------
    function saveGameState() {
        if (game.won) return;
        writeJSON(STATE_KEY, {
            level: game.level,
            deck: game.deck,
            matched: Array.from(game.matched),
            moves: game.moves,
            elapsedMs: Math.round(currentElapsed())
        });
    }

    function clearGameState() {
        removeKey(STATE_KEY);
    }

    function loadGameState() {
        const saved = readJSON(STATE_KEY);
        if (!saved || !CONFIG[saved.level] || !Array.isArray(saved.deck)) return false;
        const size = CONFIG[saved.level].rows * CONFIG[saved.level].cols;
        if (saved.deck.length !== size) return false;
        const deckOk = saved.deck.every(card => card
            && Number.isInteger(card.s) && card.s >= 0 && card.s < SHAPES.length
            && Number.isInteger(card.c) && card.c >= 0 && card.c < COLORS.length);
        if (!deckOk) return false;
        const matched = Array.isArray(saved.matched)
            ? saved.matched.filter(i => Number.isInteger(i) && i >= 0 && i < size)
            : [];
        if (matched.length >= size) return false; // 已經過關的局不還原
        game.level = saved.level;
        game.deck = saved.deck.map(card => ({ s: card.s, c: card.c }));
        game.matched = new Set(matched);
        game.revealed = [];
        game.moves = Number.isInteger(saved.moves) && saved.moves >= 0 ? saved.moves : 0;
        game.elapsedMs = Number.isFinite(saved.elapsedMs) && saved.elapsedMs >= 0 ? saved.elapsedMs : 0;
        game.runningSince = null;
        game.locked = false;
        game.won = false;
        game.focusIndex = 0;
        return true;
    }

    function loadStats() {
        const saved = readJSON(STATS_KEY);
        stats = (saved && typeof saved === 'object') ? saved : {};
    }

    function levelStats(level = game.level) {
        const entry = stats[level];
        return (entry && typeof entry === 'object') ? entry : {};
    }

    // ---------------------------------------------------------------------
    // 畫面
    // ---------------------------------------------------------------------
    function renderBoard() {
        const { rows, cols } = CONFIG[game.level];
        board.style.setProperty('--cols', cols);
        board.style.setProperty('--rows', rows);
        board.dataset.level = game.level;
        board.innerHTML = '';
        cardButtons = [];

        for (let r = 0; r < rows; r++) {
            // role="grid" 底下必須是 role="row"，否則 AT 數不到列
            const rowEl = document.createElement('div');
            rowEl.className = 'board-row';
            rowEl.setAttribute('role', 'row');
            for (let c = 0; c < cols; c++) {
                const index = r * cols + c;
                // gridcell 掛在外層，按鈕保留原生 button 語意
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.setAttribute('role', 'gridcell');

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'card';
                btn.dataset.index = String(index);
                btn.tabIndex = index === game.focusIndex ? 0 : -1;
                btn.innerHTML = `<span class="card-inner" aria-hidden="true">
                    <span class="face face-cover">${CARD_BACK_EMBLEM}</span>
                    <span class="face face-art">${svgFor(game.deck[index])}</span>
                </span>`;

                cell.appendChild(btn);
                rowEl.appendChild(cell);
                cardButtons.push(btn);
            }
            board.appendChild(rowEl);
        }
        cardButtons.forEach((_, i) => updateCard(i));
    }

    function updateCard(index) {
        const btn = cardButtons[index];
        if (!btn) return;
        const card = game.deck[index];
        const matched = game.matched.has(index);
        const revealed = matched || game.revealed.includes(index);
        btn.classList.toggle('flipped', revealed);
        btn.classList.toggle('matched', matched);
        let state = '未翻開';
        if (matched) state = `${cardName(card)}，已配對`;
        else if (revealed) state = cardName(card);
        btn.setAttribute('aria-label', `第 ${index + 1} 張，${state}`);
        if (matched) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
    }

    function renderStatus() {
        movesEl.textContent = String(game.moves);
        pairsEl.textContent = `${game.matched.size / 2} / ${totalPairs()}`;
        const best = levelStats().bestMoves;
        bestEl.textContent = Number.isInteger(best) ? `${best} 步` : '—';
        renderTimer();
        levelButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.level === game.level)));
    }

    function setFocusIndex(index, moveFocus) {
        const next = Math.max(0, Math.min(cardButtons.length - 1, index));
        if (cardButtons[game.focusIndex]) cardButtons[game.focusIndex].tabIndex = -1;
        game.focusIndex = next;
        if (cardButtons[next]) {
            cardButtons[next].tabIndex = 0;
            if (moveFocus) cardButtons[next].focus();
        }
    }

    // ---------------------------------------------------------------------
    // 遊戲流程
    // ---------------------------------------------------------------------
    function newGame(level) {
        window.clearTimeout(unflipTimer);
        stopTimer();
        game.level = CONFIG[level] ? level : game.level;
        game.deck = buildDeck(totalPairs());
        game.matched = new Set();
        game.revealed = [];
        game.moves = 0;
        game.elapsedMs = 0;
        game.runningSince = null;
        game.locked = false;
        game.won = false;
        game.focusIndex = 0;
        game.lastFlipped = null;
        writeJSON(PREFS_KEY, { level: game.level });
        renderBoard();
        renderStatus();
        saveGameState();
    }

    function hasProgress() {
        return !game.won && (game.moves > 0 || game.revealed.length > 0);
    }

    // 有進度時先確認，避免誤觸重開或切難度把整局洗掉
    function requestNewGame(level, opener) {
        if (!hasProgress()) {
            newGame(level);
            announce(`新的一局：${LEVEL_NAMES[game.level]}，共 ${totalPairs()} 對。`);
            return;
        }
        $('confirm-msg').textContent = level === game.level
            ? '目前的進度會清掉，重新洗牌。'
            : `目前的進度會清掉，改玩「${LEVEL_NAMES[level]}」。`;
        pendingLevel = level;
        openDialog(confirmDialog, opener);
    }

    function flip(index) {
        if (game.won || game.locked) return;
        if (game.matched.has(index)) {
            announce(`第 ${index + 1} 張已經配對了。`);
            return;
        }
        if (game.revealed.includes(index)) return;

        startTimer();
        game.revealed.push(index);
        game.lastFlipped = index;
        updateCard(index);

        if (game.revealed.length < 2) {
            announce(`翻開：${cardName(game.deck[index])}`);
            return;
        }

        game.moves++;
        const [a, b] = game.revealed;
        const cardA = game.deck[a];
        const cardB = game.deck[b];
        if (cardA.s === cardB.s && cardA.c === cardB.c) {
            game.matched.add(a);
            game.matched.add(b);
            game.revealed = [];
            updateCard(a);
            updateCard(b);
            renderStatus();
            if (game.matched.size === game.deck.length) {
                win();
            } else {
                announce(`配對成功：${cardName(cardA)}。已配 ${game.matched.size / 2} / ${totalPairs()} 對。`);
                saveGameState();
            }
            return;
        }

        // 不一樣：短暫標示後蓋回
        game.locked = true;
        cardButtons[a].classList.add('miss');
        cardButtons[b].classList.add('miss');
        renderStatus();
        announce(`不一樣：${cardName(cardA)}和${cardName(cardB)}，蓋回去。`);
        unflipTimer = window.setTimeout(() => {
            game.revealed = [];
            game.locked = false;
            [a, b].forEach(i => {
                cardButtons[i].classList.remove('miss');
                updateCard(i);
            });
            saveGameState();
        }, UNFLIP_DELAY);
    }

    function win() {
        stopTimer();
        game.won = true;
        clearGameState();

        const time = Math.round(game.elapsedMs);
        const prev = levelStats();
        const isRecord = !Number.isInteger(prev.bestMoves) || game.moves < prev.bestMoves;
        stats[game.level] = {
            wins: (Number.isInteger(prev.wins) ? prev.wins : 0) + 1,
            bestMoves: isRecord ? game.moves : prev.bestMoves,
            bestTime: Number.isFinite(prev.bestTime) ? Math.min(prev.bestTime, time) : time
        };
        writeJSON(STATS_KEY, stats);
        renderStatus();

        const level = game.level;
        const prevBest = Number.isInteger(prev.bestMoves) ? prev.bestMoves : null;
        let subtitle;
        if (prevBest === null) subtitle = `第一次完成「${LEVEL_NAMES[level]}」，記下 ${game.moves} 步。`;
        else if (isRecord) subtitle = `比之前的最佳紀錄少了 ${prevBest - game.moves} 步！`;
        else if (game.moves === prevBest) subtitle = `和最佳紀錄一樣是 ${prevBest} 步，再少一步就破紀錄。`;
        else subtitle = `最佳紀錄是 ${prevBest} 步，這局多了 ${game.moves - prevBest} 步。`;
        const timeRecord = Number.isFinite(prev.bestTime) && time < prev.bestTime;
        const lastCard = game.deck[Number.isInteger(game.lastFlipped) ? game.lastFlipped : 0];

        if (!celebrate) {
            announce(`全部配對完成！共 ${game.moves} 步，用時 ${formatTime(time)}${isRecord ? '，新紀錄' : ''}。`);
            return;
        }
        // 最後一對翻開的牌先停在桌上一下，再端出結果卡片
        window.setTimeout(() => {
            celebrate.show({
                outcome: 'win',
                gameName: '配對遊戲',
                title: '全部配對完成！',
                subtitle,
                stats: [
                    { label: '步數', value: `${game.moves} 步`, isBest: isRecord },
                    { label: '用時', value: celebrate.formatDuration(time / 1000), isBest: timeRecord },
                    { label: '難度', value: LEVEL_NAMES[level] }
                ],
                extra: buildFinalPair(lastCard),
                accent: '#8E24AA',
                accentDark: '#D69AE6',
                returnFocus: restartBtn,
                primary: {
                    label: '再來一局',
                    onClick: () => {
                        newGame(level);
                        setFocusIndex(0, true);
                        announce(`新的一局：${LEVEL_NAMES[game.level]}，共 ${totalPairs()} 對。`);
                    }
                },
                secondary: { label: '看盤面' }
            });
        }, 450);
    }

    // 結果卡片上的「最後一對」：兩張迷你紙牌扇形排開，就是剛剛配成的那一對
    function buildFinalPair(card) {
        const wrap = document.createElement('div');
        wrap.className = 'final-pair';
        wrap.setAttribute('aria-hidden', 'true');
        if (card) wrap.innerHTML = `<span class="mini-card">${svgFor(card)}</span><span class="mini-card">${svgFor(card)}</span>`;
        return wrap;
    }

    // ---------------------------------------------------------------------
    // 對話框：原生 <dialog> + showModal()，關閉後焦點回到開啟它的元素
    // ---------------------------------------------------------------------
    const dialogOpeners = new WeakMap();

    function openDialog(dialog, opener) {
        if (!dialog || dialog.open) return;
        dialogOpeners.set(dialog, opener || document.activeElement);
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    function closeDialog(dialog, focusTarget) {
        if (!dialog) return;
        if (focusTarget) dialogOpeners.set(dialog, focusTarget);
        if (typeof dialog.close === 'function') dialog.close();
        else {
            dialog.removeAttribute('open');
            dialog.dispatchEvent(new Event('close'));
        }
    }

    [confirmDialog, rulesDialog].forEach(dialog => {
        if (!dialog) return;
        dialog.addEventListener('close', () => {
            const target = dialogOpeners.get(dialog);
            if (target && document.contains(target) && typeof target.focus === 'function') target.focus();
        });
        // 點對話框外的遮罩關閉
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) closeDialog(dialog);
        });
    });

    // ---------------------------------------------------------------------
    // 主題（只在使用者按下時寫入偏好）
    // ---------------------------------------------------------------------
    function syncThemeButton() {
        const dark = document.documentElement.dataset.theme === 'dark';
        themeBtn.setAttribute('aria-pressed', String(dark));
    }

    function toggleTheme() {
        if (typeof BoboTheme !== 'undefined') {
            BoboTheme.toggle();
        } else {
            const root = document.documentElement;
            root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        }
        syncThemeButton();
    }

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------
    board.addEventListener('click', (event) => {
        const btn = event.target.closest('button.card');
        if (!btn) return;
        const index = Number(btn.dataset.index);
        setFocusIndex(index, false);
        flip(index);
    });

    board.addEventListener('keydown', (event) => {
        const btn = event.target.closest('button.card');
        if (!btn) return;
        const { cols } = CONFIG[game.level];
        const index = Number(btn.dataset.index);
        let next = null;
        switch (event.key) {
            case 'ArrowRight': next = index + 1; break;
            case 'ArrowLeft': next = index - 1; break;
            case 'ArrowDown': next = index + cols; break;
            case 'ArrowUp': next = index - cols; break;
            case 'Home': next = event.ctrlKey ? 0 : index - (index % cols); break;
            case 'End': next = event.ctrlKey ? cardButtons.length - 1 : index - (index % cols) + cols - 1; break;
            default: return;
        }
        event.preventDefault();
        if (next < 0 || next >= cardButtons.length) return;
        setFocusIndex(next, true);
    });

    levelButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.level === game.level && !hasProgress() && !game.won) return;
            requestNewGame(btn.dataset.level, btn);
        });
    });

    restartBtn.addEventListener('click', () => requestNewGame(game.level, restartBtn));

    $('confirm-yes').addEventListener('click', () => {
        const level = pendingLevel || game.level;
        pendingLevel = null;
        newGame(level);
        closeDialog(confirmDialog, cardButtons[0]);
        announce(`新的一局：${LEVEL_NAMES[game.level]}，共 ${totalPairs()} 對。`);
    });
    $('confirm-no').addEventListener('click', () => {
        pendingLevel = null;
        closeDialog(confirmDialog);
    });

    rulesBtn.addEventListener('click', () => openDialog(rulesDialog, rulesBtn));
    $('rules-close').addEventListener('click', () => closeDialog(rulesDialog));

    themeBtn.addEventListener('click', toggleTheme);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            if (game.runningSince !== null) {
                stopTimer();
                saveGameState();
                game.resumeOnShow = true;
            }
        } else if (game.resumeOnShow) {
            game.resumeOnShow = false;
            startTimer();
        }
    });
    window.addEventListener('pagehide', saveGameState);

    // ---------------------------------------------------------------------
    // 初始化
    // ---------------------------------------------------------------------
    if (typeof BoboTheme !== 'undefined') BoboTheme.init();
    syncThemeButton();
    // 沒有明確偏好時 BoboTheme 會跟隨系統主題切換，按鈕狀態跟著同步
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncThemeButton).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    loadStats();

    if (loadGameState()) {
        renderBoard();
        renderStatus();
        announce(`接續上次的「${LEVEL_NAMES[game.level]}」，已配 ${game.matched.size / 2} / ${totalPairs()} 對。`);
    } else {
        const prefs = readJSON(PREFS_KEY);
        newGame(prefs && CONFIG[prefs.level] ? prefs.level : 'easy');
    }
})();
