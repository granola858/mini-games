// 熄燈遊戲（Lights Out）
(() => {
    'use strict';

    // ======================================================================
    // 共用：安全存取 localStorage（隱私模式、封鎖網站資料時存取本身就會 throw）
    // ======================================================================
    const store = {
        get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
        set(key, value) { try { window.localStorage.setItem(key, value); } catch (_) {} },
        remove(key) { try { window.localStorage.removeItem(key); } catch (_) {} }
    };
    const readJSON = (key, fallback) => {
        const raw = store.get(key);
        if (!raw) return fallback;
        try {
            const value = JSON.parse(raw);
            return (value && typeof value === 'object') ? value : fallback;
        } catch (_) {
            return fallback;
        }
    };
    const writeJSON = (key, value) => {
        try { store.set(key, JSON.stringify(value)); } catch (_) {}
    };

    // ======================================================================
    // 共用：主題（只有按下按鈕才寫入偏好）
    // ======================================================================
    const themeBtn = document.getElementById('theme-btn');
    const syncThemeBtn = () => {
        const dark = document.documentElement.dataset.theme === 'dark';
        themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    };
    if (typeof BoboTheme !== 'undefined') BoboTheme.init();
    syncThemeBtn();
    new MutationObserver(syncThemeBtn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    themeBtn.addEventListener('click', () => {
        if (typeof BoboTheme !== 'undefined') {
            BoboTheme.toggle();
        } else {
            const root = document.documentElement;
            root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        }
    });

    // ======================================================================
    // 共用：對話框（原生 <dialog>，關閉後焦點回到開啟它的元素）
    // ======================================================================
    function openDialog(dialog, focusEl) {
        dialog._opener = document.activeElement;
        if (typeof dialog.showModal === 'function') {
            if (!dialog.open) dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
        if (focusEl) focusEl.focus();
    }
    document.querySelectorAll('dialog').forEach(dialog => {
        dialog.addEventListener('close', () => {
            const opener = dialog._opener;
            dialog._opener = null;
            const usable = opener && document.contains(opener) && !opener.disabled && typeof opener.focus === 'function';
            if (usable) opener.focus();
        });
    });

    const confirmDialog = document.getElementById('confirm-dialog');
    function askConfirm(text, okLabel) {
        document.getElementById('confirm-text').textContent = text;
        document.getElementById('confirm-ok').textContent = okLabel || '確定';
        confirmDialog.returnValue = '';
        openDialog(confirmDialog, document.getElementById('confirm-ok'));
        return new Promise(resolve => {
            confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
        });
    }

    const rulesDialog = document.getElementById('rules-dialog');
    document.getElementById('help-btn').addEventListener('click', () => {
        openDialog(rulesDialog, rulesDialog.querySelector('button'));
    });

    // ======================================================================
    // 遊戲狀態
    // ======================================================================
    const STATE_KEY = 'lightsout_state_v2';
    const STATS_KEY = 'lightsout_stats';
    const SIZES = [4, 5, 6, 7];
    const reduceMotion = () => {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    };

    let size = 4;
    let grid = [];        // grid[r][c] === true 代表亮
    let initial = [];     // 這盤的起始盤面，「重來這盤」用
    let moves = 0;
    let history = [];     // 按過的格子 [r, c]，「復原一步」用（同一格再按一次就還原）
    let solved = false;
    let focusR = 0;
    let focusC = 0;
    let stats = { wins: 0, best: {} };

    const board = document.getElementById('board');
    const sizeBtns = Array.from(document.querySelectorAll('.seg-btn[data-size]'));
    const moveEl = document.getElementById('move-count');
    const litEl = document.getElementById('lit-count');
    const bestEl = document.getElementById('best-moves');
    const statusEl = document.getElementById('status');
    const undoBtn = document.getElementById('undo-btn');
    const replayBtn = document.getElementById('replay-btn');
    const newBtn = document.getElementById('new-btn');

    const BULB_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<path class="bulb-glass" d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"/>'
        + '<path class="bulb-base" d="M9.5 18.5h5M10.5 21h3"/></svg>';

    function setStatus(text, tone) {
        statusEl.textContent = text;
        if (tone) statusEl.dataset.tone = tone;
        else delete statusEl.dataset.tone;
    }

    const cloneGrid = g => g.map(row => row.slice());
    const litCount = () => grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);

    // --- 存檔 ---
    function saveGameState() {
        writeJSON(STATE_KEY, {
            size,
            grid: grid.map(row => row.map(v => (v ? 1 : 0)).join('')),
            initial: initial.map(row => row.map(v => (v ? 1 : 0)).join('')),
            moves,
            history,
            solved
        });
    }

    function clearGameState() {
        store.remove(STATE_KEY);
    }

    function parseGrid(rows, n) {
        if (!Array.isArray(rows) || rows.length !== n) return null;
        if (!rows.every(row => typeof row === 'string' && row.length === n && /^[01]+$/.test(row))) return null;
        return rows.map(row => row.split('').map(ch => ch === '1'));
    }

    function loadGameState() {
        const state = readJSON(STATE_KEY, null);
        if (!state || !SIZES.includes(state.size)) return false;
        const g = parseGrid(state.grid, state.size);
        const init = parseGrid(state.initial, state.size);
        if (!g || !init) return false;
        size = state.size;
        grid = g;
        initial = init;
        moves = Number.isInteger(state.moves) && state.moves >= 0 ? state.moves : 0;
        history = Array.isArray(state.history)
            ? state.history.filter(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isInteger(v) && v >= 0 && v < size))
            : [];
        solved = !!state.solved;
        return true;
    }

    function loadStats() {
        const saved = readJSON(STATS_KEY, {});
        stats.wins = Number.isInteger(saved.wins) && saved.wins >= 0 ? saved.wins : 0;
        stats.best = {};
        if (saved.best && typeof saved.best === 'object') {
            SIZES.forEach(n => {
                const v = saved.best[n];
                if (Number.isInteger(v) && v > 0) stats.best[n] = v;
            });
        }
    }

    function saveStats() {
        writeJSON(STATS_KEY, stats);
    }

    // --- 規則 ---
    function flip(g, r, c) {
        [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].forEach(([rr, cc]) => {
            if (rr >= 0 && rr < size && cc >= 0 && cc < size) g[rr][cc] = !g[rr][cc];
        });
    }

    // 從全暗盤面隨機按若干下，倒推出來的盤面一定有解
    function generatePuzzle(n) {
        let g;
        do {
            g = Array.from({ length: n }, () => Array(n).fill(false));
            const presses = n * n;
            for (let i = 0; i < presses; i++) {
                if (Math.random() < 0.5) flip(g, Math.floor(Math.random() * n), Math.floor(Math.random() * n));
            }
        } while (g.every(row => row.every(v => !v)));
        return g;
    }

    // --- 畫面 ---
    function buildBoard() {
        board.innerHTML = '';
        board.style.setProperty('--grid-size', size);
        board.setAttribute('aria-label', `燈盤 ${size}×${size}`);
        for (let r = 0; r < size; r++) {
            const row = document.createElement('div');
            row.className = 'board-row';
            row.setAttribute('role', 'row');
            for (let c = 0; c < size; c++) {
                const cell = document.createElement('div');
                cell.setAttribute('role', 'gridcell');
                cell.className = 'cell';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'light';
                btn.dataset.r = r;
                btn.dataset.c = c;
                btn.tabIndex = -1;
                btn.innerHTML = BULB_SVG;
                cell.appendChild(btn);
                row.appendChild(cell);
            }
            board.appendChild(row);
        }
        focusR = Math.min(focusR, size - 1);
        focusC = Math.min(focusC, size - 1);
    }

    const lightAt = (r, c) => board.querySelector(`.light[data-r="${r}"][data-c="${c}"]`);

    function render() {
        board.querySelectorAll('.light').forEach(btn => {
            const r = Number(btn.dataset.r);
            const c = Number(btn.dataset.c);
            const on = grid[r][c];
            btn.classList.toggle('is-on', on);
            btn.setAttribute('aria-label', `第 ${r + 1} 列第 ${c + 1} 行，${on ? '亮' : '暗'}`);
            btn.tabIndex = (r === focusR && c === focusC) ? 0 : -1;
        });
        moveEl.textContent = moves;
        const lit = litCount();
        litEl.textContent = lit;
        if (lit === 0) litEl.dataset.zero = '';
        else delete litEl.dataset.zero;
        bestEl.textContent = stats.best[size] ?? '—';
        sizeBtns.forEach(btn => btn.setAttribute('aria-pressed', Number(btn.dataset.size) === size ? 'true' : 'false'));
        undoBtn.disabled = solved || history.length === 0;
        replayBtn.disabled = moves === 0 && !solved;
        board.classList.toggle('is-solved', solved);
    }

    // --- 流程 ---
    function startNew(n) {
        size = n;
        initial = generatePuzzle(n);
        grid = cloneGrid(initial);
        moves = 0;
        history = [];
        solved = false;
        focusR = 0;
        focusC = 0;
        buildBoard();
        saveGameState();
        render();
        setStatus(`新的 ${n}×${n} 盤面，有 ${litCount()} 盞燈亮著。`);
    }

    function replay() {
        grid = cloneGrid(initial);
        moves = 0;
        history = [];
        solved = false;
        saveGameState();
        render();
        setStatus('回到這盤的起點了。');
    }

    // 一盞迷你的「關好燈的夜晚」：n×n 全暗的小盤面加一彎月亮，放在過關卡片上
    function nightPicture(n) {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        const cell = 10;
        const gap = 3;
        const span = n * cell + (n - 1) * gap;
        const pad = 8;
        const w = span + pad * 2;
        svg.setAttribute('viewBox', `0 0 ${w} ${w + 18}`);
        svg.setAttribute('width', '96');
        svg.setAttribute('aria-hidden', 'true');
        const add = (tag, attrs) => {
            const el = document.createElementNS(NS, tag);
            Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            svg.appendChild(el);
            return el;
        };
        add('rect', { x: 0, y: 18, width: w, height: w, rx: 10, fill: '#1d2440' });
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                add('rect', { x: pad + c * (cell + gap), y: 18 + pad + r * (cell + gap), width: cell, height: cell, rx: 2.5, fill: '#3c4352', stroke: '#7b8396', 'stroke-width': 1 });
            }
        }
        // 月亮：兩個圓相減的彎月
        add('circle', { cx: w - 14, cy: 12, r: 9, fill: '#ffe08a' });
        // 用卡片底色挖出彎月（用 style 才能吃到 CSS 變數，深色主題也正確）
        add('circle', { cx: w - 9, cy: 8, r: 8 }).style.fill = 'var(--br-surface, #ffffff)';
        return svg;
    }

    function showWin(prevBest) {
        const isRecord = BoboCelebrate.isNewRecord(prevBest, moves, { lowerIsBetter: true });
        let subtitle;
        if (prevBest === undefined) subtitle = `晚安～第一次把 ${size}×${size} 的燈全部關好，用了 ${moves} 步。`;
        else if (isRecord) subtitle = `晚安～用了 ${moves} 步，比之前的紀錄少 ${prevBest - moves} 步！`;
        else subtitle = `晚安～用了 ${moves} 步。最少紀錄是 ${stats.best[size]} 步，下一盤再挑戰看看。`;
        BoboCelebrate.show({
            outcome: 'win',
            gameName: '熄燈遊戲',
            title: '全部熄滅！',
            subtitle,
            stats: [
                { label: '這盤步數', value: moves, isBest: isRecord },
                { label: `${size}×${size} 最少`, value: stats.best[size] },
                { label: '通關次數', value: stats.wins }
            ],
            extra: nightPicture(size),
            accent: '#8a5a00',
            accentDark: '#ffc93c',
            returnFocus: newBtn,
            primary: {
                label: '下一盤',
                onClick: () => {
                    startNew(size);
                    lightAt(0, 0).focus();
                }
            },
            secondary: { label: '看盤面' }
        });
    }

    function press(r, c) {
        if (solved) return;
        flip(grid, r, c);
        moves++;
        history.push([r, c]);
        focusR = r;
        focusC = c;
        const remaining = litCount();
        if (remaining === 0) {
            solved = true;
            stats.wins++;
            const prev = stats.best[size];
            if (prev === undefined || moves < prev) stats.best[size] = moves;
            saveStats();
            saveGameState();
            // 最後一下關掉的那幾盞燈慢慢暗下，盤面轉成月夜色，然後才跳出過關卡片
            const lastPressed = [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
                .filter(([rr, cc]) => rr >= 0 && rr < size && cc >= 0 && cc < size)
                .map(([rr, cc]) => lightAt(rr, cc));
            lastPressed.forEach(btn => btn.classList.add('is-dimming'));
            render();
            setStatus(`全部熄滅！用了 ${moves} 步。`, 'success');
            setTimeout(() => {
                lastPressed.forEach(btn => btn.classList.remove('is-dimming'));
                if (typeof BoboCelebrate !== 'undefined') showWin(prev);
            }, reduceMotion() ? 200 : 750);
            return;
        }
        saveGameState();
        render();
        setStatus(`第 ${moves} 步，還有 ${remaining} 盞亮著。`);
    }

    function undo() {
        if (solved || history.length === 0) return;
        const [r, c] = history.pop();
        flip(grid, r, c);
        moves = Math.max(0, moves - 1);
        focusR = r;
        focusC = c;
        saveGameState();
        render();
        setStatus(`已復原，還有 ${litCount()} 盞亮著。`);
    }

    async function confirmDiscard(text, okLabel) {
        if (solved || moves === 0) return true;
        return askConfirm(text, okLabel);
    }

    // --- 事件 ---
    board.addEventListener('click', (e) => {
        const btn = e.target.closest('.light');
        if (!btn) return;
        press(Number(btn.dataset.r), Number(btn.dataset.c));
        lightAt(focusR, focusC).focus();
    });

    // roving tabindex：整個燈盤只有一個 Tab 停點
    board.addEventListener('keydown', (e) => {
        const moveMap = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        let r = focusR;
        let c = focusC;
        if (moveMap[e.key]) {
            r = Math.min(size - 1, Math.max(0, r + moveMap[e.key][0]));
            c = Math.min(size - 1, Math.max(0, c + moveMap[e.key][1]));
        } else if (e.key === 'Home') {
            c = 0;
        } else if (e.key === 'End') {
            c = size - 1;
        } else {
            return;
        }
        e.preventDefault();
        focusR = r;
        focusC = c;
        render();
        lightAt(r, c).focus();
    });

    board.addEventListener('focusin', (e) => {
        const btn = e.target.closest('.light');
        if (!btn) return;
        focusR = Number(btn.dataset.r);
        focusC = Number(btn.dataset.c);
        board.querySelectorAll('.light').forEach(b => { b.tabIndex = b === btn ? 0 : -1; });
    });

    sizeBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const n = Number(btn.dataset.size);
            if (n === size) return;
            const ok = await confirmDiscard(`換成 ${n}×${n} 會放棄目前這一盤，確定嗎？`, '換盤面');
            if (!ok) return;
            startNew(n);
            btn.focus();
        });
    });

    undoBtn.addEventListener('click', undo);
    replayBtn.addEventListener('click', async () => {
        const ok = await confirmDiscard('回到這盤的起點，目前的步數會歸零，確定嗎？', '重來這盤');
        if (ok) replay();
    });
    newBtn.addEventListener('click', async () => {
        const ok = await confirmDiscard('放棄目前這一盤，換一盤新的？', '新的一盤');
        if (ok) startNew(size);
    });

    // --- 啟動 ---
    loadStats();
    if (loadGameState()) {
        buildBoard();
        render();
        setStatus(solved
            ? '上一盤已經全部熄滅，按「新的一盤」繼續。'
            : (moves > 0 ? `接續上一盤：第 ${moves} 步，還有 ${litCount()} 盞亮著。` : `${size}×${size} 盤面，有 ${litCount()} 盞燈亮著。`));
    } else {
        startNew(size);
    }
})();
