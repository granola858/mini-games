// 顏色文字遊戲
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

    const MODE_LABELS = { easy: '簡單', medium: '中等', hard: '困難' };
    const DOT_COLORS = ['var(--c-red)', 'var(--c-blue)', 'var(--c-green)', 'var(--c-yellow)', 'var(--c-black)'];

    // 連對紀錄：每答對一題一顆彩色字點（最多畫 30 顆），給共用過關卡片當個性內容
    function buildStreakDots(count, still) {
        const list = document.createElement('ul');
        list.className = still ? 'streak-dots streak-dots--still' : 'streak-dots';
        list.setAttribute('role', 'img');
        list.setAttribute('aria-label', `連對 ${count} 題`);
        for (let i = 0; i < Math.min(count, 30); i++) {
            const dot = document.createElement('li');
            dot.style.setProperty('--dot', DOT_COLORS[i % DOT_COLORS.length]);
            dot.style.setProperty('--i', String(i));
            list.appendChild(dot);
        }
        return list;
    }

    // 只在值得的時刻跳出過關卡片：剛打破最佳紀錄（連對 3 題以上），
    // 或一段 3 題以上的連對剛結束。其他每一題照常用狀態列回饋，不打斷節奏。
    function showStreakCard(kind, count, answerLine) {
        const kit = (typeof BoboCelebrate !== 'undefined') ? BoboCelebrate : null;
        if (!kit) return false;
        const win = kind === 'record';
        kit.show({
            outcome: win ? 'win' : 'lose',
            gameName: '顏色文字遊戲',
            title: win ? `新紀錄！連對 ${count} 題` : `連對 ${count} 題，在這題停下`,
            subtitle: win
                ? '記憶力正在升溫，繼續挑戰還能往上加。'
                : `${answerLine}${count >= stats.best ? '這段就是你的最佳紀錄。' : `最佳紀錄是 ${stats.best} 題。`}`,
            stats: [
                { label: '連對', value: `${count} 題`, isBest: win },
                { label: '累計答對', value: `${stats.correct} 題` },
                { label: '難度', value: MODE_LABELS[prefs.mode] || '簡單' }
            ],
            extra: buildStreakDots(count, !win),
            accent: '#1864ab',
            accentDark: '#74c0fc',
            returnFocus: startBtn,
            primary: { label: win ? '繼續挑戰' : '再來一題', onClick: () => startRound() },
            secondary: { label: '看卡片' }
        });
        return true;
    }

    // ======================================================================
    // 遊戲設定
    // ======================================================================
    const PREFS_KEY = 'colortext_prefs';
    const STATS_KEY = 'colortext_stats';
    const ANSWER_SECONDS = 8;

    const MODES = {
        easy: { count: 4, seconds: 3, cols: 2 },
        medium: { count: 6, seconds: 6, cols: 3 },
        hard: { count: 9, seconds: 10, cols: 3 }
    };

    // 五種字／五種顏色；mark 是色盲輔助記號
    const ITEMS = [
        { key: 'red', text: '紅', name: '紅色', mark: '●' },
        { key: 'blue', text: '藍', name: '藍色', mark: '■' },
        { key: 'green', text: '綠', name: '綠色', mark: '▲' },
        { key: 'yellow', text: '黃', name: '黃色', mark: '★' },
        { key: 'black', text: '黑', name: '黑色', mark: '◆' }
    ];

    const reduceMotion = () => {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    };

    let prefs = { mode: 'easy', timer: false, marks: false };
    let stats = { streak: 0, best: 0, correct: 0, plays: 0 };
    let phase = 'idle';      // idle → memorize → question → result
    let cards = [];          // { text, color(key) }
    let question = null;     // { type: 'color'|'text', item, answer }
    let answered = false;
    let phaseTimer = null;
    let rafId = null;

    const gridEl = document.getElementById('grid');
    const phaseBar = document.getElementById('phase-bar');
    const phaseText = document.getElementById('phase-text');
    const meterFill = document.getElementById('meter-fill');
    const questionEl = document.getElementById('question');
    const questionText = document.getElementById('question-text');
    const numpad = document.getElementById('numpad');
    const statusEl = document.getElementById('status');
    const startBtn = document.getElementById('start-btn');
    const modeBtns = Array.from(document.querySelectorAll('.seg-btn[data-mode]'));
    const timerCheck = document.getElementById('timer-check');
    const marksCheck = document.getElementById('marks-check');

    function setStatus(text, tone) {
        statusEl.textContent = text;
        if (tone) statusEl.dataset.tone = tone;
        else delete statusEl.dataset.tone;
    }

    // --- 存檔 ---
    function loadPrefs() {
        const saved = readJSON(PREFS_KEY, {});
        prefs.mode = MODES[saved.mode] ? saved.mode : 'easy';
        prefs.timer = saved.timer === true;
        prefs.marks = saved.marks === true;
    }
    const savePrefs = () => writeJSON(PREFS_KEY, prefs);

    function loadStats() {
        const saved = readJSON(STATS_KEY, {});
        ['streak', 'best', 'correct', 'plays'].forEach(k => {
            stats[k] = Number.isInteger(saved[k]) && saved[k] >= 0 ? saved[k] : 0;
        });
    }
    const saveStats = () => writeJSON(STATS_KEY, stats);

    // --- 畫面 ---
    function renderStats() {
        document.getElementById('streak').textContent = stats.streak;
        document.getElementById('best-streak').textContent = stats.best;
        document.getElementById('total-correct').textContent = stats.correct;
    }

    function renderSettings() {
        modeBtns.forEach(btn => {
            btn.setAttribute('aria-pressed', btn.dataset.mode === prefs.mode ? 'true' : 'false');
            btn.disabled = phase === 'memorize' || phase === 'question';
        });
        timerCheck.checked = prefs.timer;
        marksCheck.checked = prefs.marks;
        document.body.classList.toggle('show-marks', prefs.marks);
        // 記憶與作答是限時階段：在 body 標記目前階段，CSS 會收起設定區、縮小蓋住的卡片，
        // 讓整個遊戲區（9 張卡片或整排答案鈕）落在同一個畫面裡，不必邊計時邊捲動
        document.body.dataset.phase = phase;
    }

    // 限時階段開始時把要看的區塊捲進畫面；減少動態效果時直接跳過去，不做平滑捲動
    function bringIntoView(el, block) {
        if (!el || typeof el.scrollIntoView !== 'function') return;
        try {
            el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: block || 'nearest' });
        } catch (_) {
            el.scrollIntoView();
        }
    }

    const itemOf = key => ITEMS.find(it => it.key === key);

    function cardLabel(card, idx) {
        return `第 ${idx + 1} 張：${itemOf(card.color).name}的「${card.text}」字`;
    }

    function renderCards({ covered, highlight } = {}) {
        const mode = MODES[prefs.mode];
        gridEl.style.setProperty('--cols', mode.cols);
        gridEl.style.setProperty('--rows', Math.ceil(mode.count / mode.cols));
        gridEl.innerHTML = '';
        cards.forEach((card, idx) => {
            const el = document.createElement('div');
            el.className = 'card';
            el.setAttribute('role', 'img');
            if (covered) {
                el.classList.add('is-covered');
                el.textContent = '?';
                el.setAttribute('aria-label', `第 ${idx + 1} 張：已蓋起來`);
            } else {
                el.classList.add(`c-${card.color}`);
                el.dataset.mark = itemOf(card.color).mark;
                el.textContent = card.text;
                el.setAttribute('aria-label', cardLabel(card, idx));
                if (highlight && highlight(card)) el.classList.add('is-match');
            }
            gridEl.appendChild(el);
        });
    }

    function stopTimers() {
        if (phaseTimer) clearTimeout(phaseTimer);
        if (rafId) cancelAnimationFrame(rafId);
        phaseTimer = null;
        rafId = null;
    }

    // 倒數：文字每秒更新，進度條每幀更新（倒數是遊戲資訊，減少動態效果時照樣顯示）
    function runCountdown(seconds, label, onDone) {
        stopTimers();
        phaseBar.hidden = false;
        const start = performance.now();
        const total = seconds * 1000;
        let lastShown = -1;
        const tick = (now) => {
            const left = Math.max(0, total - (now - start));
            const secs = Math.ceil(left / 1000);
            if (secs !== lastShown) {
                phaseText.textContent = `${label}：還剩 ${secs} 秒`;
                lastShown = secs;
            }
            meterFill.style.transform = `scaleX(${left / total})`;
            if (left > 0) rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        phaseTimer = setTimeout(() => {
            stopTimers();
            onDone();
        }, total);
    }

    // --- 流程 ---
    function startRound() {
        stopTimers();
        const mode = MODES[prefs.mode];
        cards = Array.from({ length: mode.count }, () => ({
            text: ITEMS[Math.floor(Math.random() * ITEMS.length)].text,
            color: ITEMS[Math.floor(Math.random() * ITEMS.length)].key
        }));
        phase = 'memorize';
        answered = false;
        questionEl.hidden = true;
        startBtn.hidden = true;
        renderSettings();
        renderCards();
        setStatus(`記住這 ${mode.count} 張卡片的字和顏色，${mode.seconds} 秒後蓋牌。`);
        gridEl.focus({ preventScroll: true });
        bringIntoView(document.querySelector('.play-area'), 'start');
        runCountdown(mode.seconds, '記住它們', askQuestion);
    }

    function makeQuestion() {
        const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
        if (Math.random() < 0.5) {
            return { type: 'color', item, answer: cards.filter(c => c.color === item.key).length };
        }
        return { type: 'text', item, answer: cards.filter(c => c.text === item.text).length };
    }

    function askQuestion() {
        phase = 'question';
        question = makeQuestion();
        renderCards({ covered: true });
        const it = question.item;
        if (question.type === 'color') {
            questionText.innerHTML = `剛剛<strong>字體顏色</strong>是 <span class="q-swatch c-${it.key}" data-mark="${it.mark}">${it.name}</span> 的卡片有幾張？`;
        } else {
            questionText.innerHTML = `剛剛<strong>寫著「${it.text}」</strong>的卡片有幾張？（不管顏色）`;
        }
        numpad.innerHTML = '';
        for (let n = 0; n <= cards.length; n++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'num-btn';
            btn.textContent = n;
            btn.dataset.n = n;
            btn.setAttribute('aria-label', `${n} 張`);
            numpad.appendChild(btn);
        }
        questionEl.hidden = false;
        renderSettings();
        setStatus('卡片蓋起來了，請作答。');
        questionText.focus({ preventScroll: true });
        bringIntoView(questionEl, 'end');
        if (prefs.timer) {
            runCountdown(ANSWER_SECONDS, '作答倒數', () => checkAnswer(null));
        } else {
            phaseBar.hidden = true;
        }
    }

    function checkAnswer(n) {
        // 防連點：同一題只接受第一次作答，避免連對被灌
        if (phase !== 'question' || answered) return;
        answered = true;
        stopTimers();
        phaseBar.hidden = true;
        numpad.querySelectorAll('button').forEach(btn => { btn.disabled = true; });

        const correct = n === question.answer;
        const prevBest = stats.best;
        const endedStreak = stats.streak;
        stats.plays++;
        let tone;
        let line;
        let newBest = false;
        if (n === null) {
            stats.streak = 0;
            tone = 'error';
            line = `時間到！正確答案是 ${question.answer} 張。`;
        } else if (correct) {
            stats.streak++;
            stats.correct++;
            if (stats.streak > stats.best) {
                stats.best = stats.streak;
                newBest = true;
            }
            tone = 'success';
            line = newBest && stats.streak >= 3
                ? `答對了！連對 ${stats.streak} 題，新紀錄！`
                : `答對了！連對 ${stats.streak} 題。`;
        } else {
            stats.streak = 0;
            tone = 'error';
            line = `答錯囉，你選 ${n} 張，正確是 ${question.answer} 張。`;
        }
        saveStats();
        renderStats();

        // 翻回卡片，把符合題目的卡片框起來，讓玩家知道錯在哪
        const it = question.item;
        renderCards({
            highlight: question.type === 'color' ? (c => c.color === it.key) : (c => c.text === it.text)
        });

        phase = 'result';
        startBtn.textContent = '再來一題';
        startBtn.hidden = false;
        renderSettings();
        setStatus(line, tone);
        const answerLine = n === null ? `時間到，正確是 ${question.answer} 張。` : `正確是 ${question.answer} 張。`;
        let carded = false;
        if (correct && newBest && stats.streak === prevBest + 1 && stats.streak >= 3) {
            carded = showStreakCard('record', stats.streak, '');
        } else if (!correct && endedStreak >= 3) {
            carded = showStreakCard('ended', endedStreak, answerLine);
        }
        if (!carded) startBtn.focus();
    }

    // --- 事件 ---
    startBtn.addEventListener('click', startRound);

    numpad.addEventListener('click', (e) => {
        const btn = e.target.closest('.num-btn');
        if (btn) checkAnswer(Number(btn.dataset.n));
    });

    // 作答時可直接按數字鍵
    document.addEventListener('keydown', (e) => {
        if (phase !== 'question' || e.altKey || e.ctrlKey || e.metaKey) return;
        if (document.querySelector('dialog[open]')) return;
        if (/^[0-9]$/.test(e.key)) {
            const n = Number(e.key);
            if (n <= cards.length) {
                e.preventDefault();
                checkAnswer(n);
            }
        }
    });

    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.mode === prefs.mode) return;
            prefs.mode = btn.dataset.mode;
            savePrefs();
            const hadStreak = stats.streak > 0;
            stats.streak = 0;
            saveStats();
            renderStats();
            renderSettings();
            const mode = MODES[prefs.mode];
            setStatus(`已切換為 ${mode.count} 張、記憶 ${mode.seconds} 秒${hadStreak ? '，連對重新計算' : ''}。`);
        });
    });

    timerCheck.addEventListener('change', () => {
        prefs.timer = timerCheck.checked;
        savePrefs();
    });
    marksCheck.addEventListener('change', () => {
        prefs.marks = marksCheck.checked;
        savePrefs();
        renderSettings();
    });

    // --- 啟動 ---
    loadPrefs();
    loadStats();
    renderStats();
    renderSettings();
    gridEl.style.setProperty('--cols', MODES[prefs.mode].cols);
    gridEl.style.setProperty('--rows', Math.ceil(MODES[prefs.mode].count / MODES[prefs.mode].cols));
    if (stats.streak > 0) setStatus(`目前連對 ${stats.streak} 題，按「開始記憶」繼續。`);
})();
