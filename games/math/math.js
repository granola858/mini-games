// 算術遊戲
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
    function closeDialog(dialog) {
        if (typeof dialog.close === 'function' && dialog.open) dialog.close();
        else dialog.removeAttribute('open');
    }
    document.querySelectorAll('dialog').forEach(dialog => {
        dialog.addEventListener('close', () => {
            const opener = dialog._opener;
            dialog._opener = null;
            if (dialog._skipRestore) { dialog._skipRestore = false; return; }
            // 開啟者若已被停用（例如過關後的送出鈕），改把焦點交給備援元素
            const usable = opener && document.contains(opener) && !opener.disabled && typeof opener.focus === 'function';
            const target = usable ? opener : dialog._fallback;
            if (target && typeof target.focus === 'function') target.focus();
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

    // 打破最佳連對時用全站共用的過關卡片慶祝（每題都跳視窗會打斷節奏，所以只在里程碑出現）
    const celebrate = (expr) => {
        if (typeof BoboCelebrate === 'undefined') return;
        BoboCelebrate.show({
            outcome: 'win',
            gameName: '算術遊戲',
            title: `連對 ${stats.streak} 題！`,
            subtitle: `${expr} ＝ ${target}，打破了你的最佳連對紀錄。`,
            stats: [
                { label: '連對', value: `${stats.streak} 題`, isBest: true },
                { label: '答對題數', value: `${stats.solved} 題` }
            ],
            accent: '#0b7362',
            accentDark: '#63e6be',
            primary: { label: '下一題', onClick: () => newPuzzle() },
            secondary: { label: '看算式' },
            returnFocus: nextBtn
        });
    };

    // ======================================================================
    // 遊戲狀態
    // ======================================================================
    const STATE_KEY = 'math_state';
    const STATS_KEY = 'math_stats';
    const NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const OPS = ['+', '-', '*', '/'];
    const OP_TEXT = { '+': '＋', '-': '−', '*': '×', '/': '÷' };
    const OP_SPEECH = { '+': '加', '-': '減', '*': '乘', '/': '除' };

    let mode = 'random';      // 3 | 5 | 'random'
    let length = 5;
    let target = 0;
    let steps = [];           // 依序填入的值：數字或運算符號
    let solved = false;
    let stats = { streak: 0, best: 0, solved: 0 };

    const slotsEl = document.getElementById('slots');
    const liveValueEl = document.getElementById('live-value');
    const targetEl = document.getElementById('target-num');
    const statusEl = document.getElementById('status');
    const lockEl = document.getElementById('lock');
    const lockStateEl = document.getElementById('lock-state');
    const keys = Array.from(document.querySelectorAll('.key'));
    const modeBtns = Array.from(document.querySelectorAll('.seg-btn[data-mode]'));
    const undoBtn = document.getElementById('undo-btn');
    const clearBtn = document.getElementById('clear-btn');
    const nextBtn = document.getElementById('next-btn');

    function setStatus(text, tone) {
        statusEl.textContent = text;
        if (tone) statusEl.dataset.tone = tone;
        else delete statusEl.dataset.tone;
    }

    // --- 計算：自己實作先乘除後加減，不用 eval／new Function ---
    function evaluate(tokens) {
        // 結尾是運算符號時先忽略它，讓「填到一半」也能顯示目前結果
        const t = tokens.slice();
        if (t.length && typeof t[t.length - 1] !== 'number') t.pop();
        if (!t.length) return null;
        const terms = [t[0]];
        const signs = [];
        for (let i = 1; i < t.length; i += 2) {
            const op = t[i];
            const n = t[i + 1];
            if (op === '*') terms[terms.length - 1] *= n;
            else if (op === '/') terms[terms.length - 1] /= n;
            else {
                signs.push(op);
                terms.push(n);
            }
        }
        let result = terms[0];
        signs.forEach((op, i) => {
            result = op === '+' ? result + terms[i + 1] : result - terms[i + 1];
        });
        return result;
    }

    // 小數最多兩位，去掉多餘的 0（-1.2222222222222223 → -1.22）
    function formatNumber(n) {
        if (n === null || !Number.isFinite(n)) return '—';
        const rounded = Math.round(n * 100) / 100;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }

    const tokenText = v => (typeof v === 'number' ? String(v) : OP_TEXT[v]);
    const isClose = (a, b) => Math.abs(a - b) < 1e-9;

    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function generateTarget(len) {
        for (let tries = 0; tries < 5000; tries++) {
            const nums = shuffle(NUMS);
            const ops = shuffle(OPS);
            const tokens = [];
            for (let i = 0; i < len; i++) tokens.push(i % 2 === 0 ? nums[i / 2] : ops[(i - 1) / 2]);
            const value = evaluate(tokens);
            if (Number.isInteger(value) && value > 0 && value <= 100) return value;
        }
        return 3; // 理論上不會走到這裡
    }

    // --- 存檔 ---
    function saveGameState() {
        writeJSON(STATE_KEY, { mode, length, target, steps, solved });
    }
    function clearGameState() {
        store.remove(STATE_KEY);
    }
    function loadGameState() {
        const s = readJSON(STATE_KEY, null);
        if (!s) return false;
        if (![3, 5, 'random'].includes(s.mode) || ![3, 5].includes(s.length)) return false;
        if (!Number.isInteger(s.target) || s.target <= 0) return false;
        if (!Array.isArray(s.steps) || s.steps.length > s.length) return false;
        const validStep = (v, i) => (i % 2 === 0 ? NUMS.includes(v) : OPS.includes(v));
        if (!s.steps.every(validStep)) return false;
        if (new Set(s.steps).size !== s.steps.length) return false;
        mode = s.mode;
        length = s.length;
        target = s.target;
        steps = s.steps;
        solved = !!s.solved;
        return true;
    }
    function loadStats() {
        const saved = readJSON(STATS_KEY, {});
        ['streak', 'best', 'solved'].forEach(k => {
            stats[k] = Number.isInteger(saved[k]) && saved[k] >= 0 ? saved[k] : 0;
        });
    }
    const saveStats = () => writeJSON(STATS_KEY, stats);

    // --- 畫面 ---
    function render() {
        targetEl.textContent = target;
        slotsEl.style.setProperty('--slots', length);
        slotsEl.innerHTML = '';
        for (let i = 0; i < length; i++) {
            const slot = document.createElement('span');
            slot.className = 'slot';
            const v = steps[i];
            if (v !== undefined) {
                slot.classList.add('is-filled');
                slot.textContent = tokenText(v);
            } else if (i === steps.length && !solved) {
                slot.classList.add('is-next');
            }
            slotsEl.appendChild(slot);
        }
        const spoken = steps.map(v => (typeof v === 'number' ? v : OP_SPEECH[v])).join(' ');
        slotsEl.setAttribute('aria-label', steps.length ? `你的算式：${spoken}` : '你的算式：還沒填');

        const value = evaluate(steps);
        liveValueEl.textContent = `目前算出：${formatNumber(value)}`;
        liveValueEl.classList.toggle('is-match', solved);
        lockEl.classList.toggle('is-open', solved);
        lockStateEl.textContent = solved ? '已解鎖' : '上鎖中';

        const full = steps.length >= length;
        const nextIsNumber = steps.length % 2 === 0;
        keys.forEach(key => {
            const v = key.classList.contains('num') ? Number(key.dataset.val) : key.dataset.val;
            const used = steps.includes(v);
            const wrongKind = key.classList.contains('num') ? !nextIsNumber : nextIsNumber;
            key.disabled = solved || full || used || wrongKind;
            key.classList.toggle('is-used', used);
        });
        undoBtn.disabled = solved || steps.length === 0;
        clearBtn.disabled = solved || steps.length === 0;
        nextBtn.classList.toggle('btn-primary', solved);
        nextBtn.textContent = solved ? '下一題 →' : '跳過這題';
        modeBtns.forEach(btn => btn.setAttribute('aria-pressed', btn.dataset.mode === String(mode) ? 'true' : 'false'));

        document.getElementById('streak').textContent = stats.streak;
        document.getElementById('best-streak').textContent = stats.best;
        document.getElementById('total-solved').textContent = stats.solved;
    }

    // --- 流程 ---
    function newPuzzle() {
        length = mode === 'random' ? (Math.random() < 0.5 ? 3 : 5) : mode;
        target = generateTarget(length);
        steps = [];
        solved = false;
        saveGameState();
        render();
        setStatus(`新題目：用 ${length === 3 ? '2 個數字、1 個符號' : '3 個數字、2 個符號'} 算出 ${target}。`);
    }

    function checkResult() {
        const value = evaluate(steps);
        const expr = steps.map(tokenText).join(' ');
        if (isClose(value, target)) {
            solved = true;
            stats.streak++;
            stats.solved++;
            const newBest = stats.streak > stats.best;
            if (newBest) stats.best = stats.streak;
            saveStats();
            saveGameState();
            render();
            setStatus(`解鎖成功！${expr} ＝ ${target}，連對 ${stats.streak} 題。按「下一題」繼續。`, 'success');
            nextBtn.focus();
            if (newBest && stats.streak >= 3) celebrate(expr);
        } else {
            const hadStreak = stats.streak > 0;
            stats.streak = 0;
            saveStats();
            saveGameState();
            render();
            setStatus(`${expr} ＝ ${formatNumber(value)}，不是 ${target}。按「復原」改改看${hadStreak ? '（連對歸零）' : ''}。`, 'error');
            undoBtn.focus();
        }
    }

    function input(v) {
        if (solved || steps.length >= length) return;
        const nextIsNumber = steps.length % 2 === 0;
        if ((typeof v === 'number') !== nextIsNumber) return;
        if (steps.includes(v)) return;
        steps.push(v);
        saveGameState();
        if (steps.length === length) {
            checkResult();
        } else {
            render();
            setStatus('');
        }
    }

    function undo() {
        if (solved || !steps.length) return;
        steps.pop();
        saveGameState();
        render();
        setStatus('');
    }

    function clearAll() {
        if (solved || !steps.length) return;
        steps = [];
        saveGameState();
        render();
        setStatus('已清空，重新排排看。');
    }

    async function skipOrNext() {
        if (!solved && stats.streak > 0) {
            const ok = await askConfirm(`跳過這題會讓連對（${stats.streak} 題）歸零，確定嗎？`, '跳過');
            if (!ok) return;
        }
        if (!solved && stats.streak > 0) {
            stats.streak = 0;
            saveStats();
        }
        newPuzzle();
    }

    // --- 事件 ---
    document.getElementById('keypad').addEventListener('click', (e) => {
        const key = e.target.closest('.key');
        if (!key || key.disabled) return;
        input(key.classList.contains('num') ? Number(key.dataset.val) : key.dataset.val);
        // 按下的鍵會被停用，焦點留在鍵盤區下一個可用的鍵
        if (document.activeElement === key || document.activeElement === document.body) {
            const firstEnabled = keys.find(k => !k.disabled);
            if (firstEnabled) firstEnabled.focus();
        }
    });

    undoBtn.addEventListener('click', undo);
    clearBtn.addEventListener('click', clearAll);
    nextBtn.addEventListener('click', skipOrNext);

    modeBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const next = btn.dataset.mode === 'random' ? 'random' : Number(btn.dataset.mode);
            if (next === mode) return;
            if (!solved && steps.length > 0) {
                const ok = await askConfirm('換難度會放棄目前這題，確定嗎？', '換難度');
                if (!ok) return;
            }
            mode = next;
            newPuzzle();
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (document.querySelector('dialog[open]')) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        let handled = true;
        if (/^[1-9]$/.test(e.key)) input(Number(e.key));
        else if (e.key === '0') input(10);
        else if (e.key === '+') input('+');
        else if (e.key === '-') input('-');
        else if (e.key === '*' || e.key === 'x' || e.key === 'X') input('*');
        else if (e.key === '/') input('/');
        else if (e.key === 'Backspace') undo();
        else if (e.key === 'Escape') clearAll();
        else if (e.key === 'Enter' && solved && e.target === document.body) newPuzzle();
        else handled = false;
        if (handled) e.preventDefault();
    });

    // --- 啟動 ---
    loadStats();
    if (loadGameState()) {
        render();
        setStatus(solved ? '上一題已答對，按「下一題」繼續。' : (steps.length ? '接續上一題。' : ''));
    } else {
        newPuzzle();
    }
})();
