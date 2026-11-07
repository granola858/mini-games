// 聯想遊戲：隨機抽「開頭（注音／英文字母）＋題目」，大家輪流接詞。
(() => {
    'use strict';

    const ZHUYIN = ['ㄅ', 'ㄆ', 'ㄇ', 'ㄈ', 'ㄉ', 'ㄊ', 'ㄋ', 'ㄌ', 'ㄍ', 'ㄎ', 'ㄏ', 'ㄐ', 'ㄑ', 'ㄒ', 'ㄓ', 'ㄔ', 'ㄕ', 'ㄖ', 'ㄗ', 'ㄘ', 'ㄙ', 'ㄧ', 'ㄨ', 'ㄩ', 'ㄚ', 'ㄦ'];
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    // 題目中英對照：English 模式出英文題目，Google 查詢才會合理
    const CATEGORIES = Object.freeze([
        { zh: '動物', en: 'Animals' },
        { zh: '食物', en: 'Food' },
        { zh: '水果', en: 'Fruit' },
        { zh: '交通工具', en: 'Vehicles' },
        { zh: '地點', en: 'Places' },
        { zh: '身體部位', en: 'Body parts' },
        { zh: '生活用品', en: 'Household items' },
        { zh: '職業', en: 'Jobs' },
        { zh: '卡通人物', en: 'Cartoon characters' },
        { zh: '動作', en: 'Actions' },
        { zh: '形容詞', en: 'Adjectives' }
    ]);
    const PREFS_KEY = 'puzzle_prefs_v1';
    const STATE_KEY = 'puzzle_state_v1';
    const STATS_KEY = 'puzzle_stats_v1';

    // ---------------------------------------------------------------------
    // 存取（全部包 try/catch）
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
        } catch (_) { /* 存不了不影響遊戲 */ }
    }

    function removeKey(key) {
        try {
            localStorage.removeItem(key);
        } catch (_) { /* 同上 */ }
    }

    const state = {
        lang: 'zh',
        double: false,
        result: null,    // { s1, s2, cat }，cat 是 CATEGORIES 的索引
        rolling: false,
        rounds: 0
    };

    const $ = (id) => document.getElementById(id);
    const symbolDisplay = $('symbolDisplay');
    const categoryDisplay = $('categoryDisplay');
    const categorySub = $('categorySub');
    const symbolTitle = $('symbolTitle');
    const categoryTitle = $('categoryTitle');
    const gameContainer = $('gameContainer');
    const hintSection = $('hintSection');
    const hintLink = $('hintLink');
    const rollBtn = $('rollBtn');
    const doubleToggle = $('doubleModeToggle');
    const doubleContainer = $('doubleModeContainer');
    const statusEl = $('game-status');
    const themeBtn = $('theme-btn');
    const rulesDialog = $('rules-dialog');
    const rulesBtn = $('rules-btn');
    const langButtons = [$('btn-zh'), $('btn-en')];

    const reduceMotion = () => {
        try {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_) {
            return false;
        }
    };

    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    function announce(message) {
        statusEl.textContent = '';
        window.setTimeout(() => { statusEl.textContent = message; }, 30);
    }

    // ---------------------------------------------------------------------
    // 存檔：偏好（語言、雙注音）＋目前題目＋出題次數
    // ---------------------------------------------------------------------
    function savePrefs() {
        writeJSON(PREFS_KEY, { lang: state.lang, double: state.double });
    }

    function saveGameState() {
        if (!state.result) return;
        writeJSON(STATE_KEY, { lang: state.lang, double: state.double, result: state.result });
        writeJSON(STATS_KEY, { rounds: state.rounds });
    }

    function clearGameState() {
        removeKey(STATE_KEY);
    }

    function loadGameState() {
        const prefs = readJSON(PREFS_KEY);
        if (prefs) {
            if (prefs.lang === 'en' || prefs.lang === 'zh') state.lang = prefs.lang;
            state.double = prefs.double === true && state.lang === 'zh';
        }
        const stats = readJSON(STATS_KEY);
        if (stats && Number.isInteger(stats.rounds) && stats.rounds >= 0) state.rounds = stats.rounds;

        const saved = readJSON(STATE_KEY);
        if (!saved || saved.lang !== state.lang || saved.double !== state.double || !saved.result) return false;
        const source = state.lang === 'en' ? ALPHABET : ZHUYIN;
        const r = saved.result;
        if (!source.includes(r.s1)) return false;
        if (state.double ? !source.includes(r.s2) : !(Number.isInteger(r.cat) && CATEGORIES[r.cat])) return false;
        state.result = { s1: r.s1, s2: state.double ? r.s2 : null, cat: state.double ? null : r.cat };
        return true;
    }

    // ---------------------------------------------------------------------
    // 畫面
    // ---------------------------------------------------------------------
    function categoryText(index) {
        const cat = CATEGORIES[index];
        return state.lang === 'en' ? cat.en : cat.zh;
    }

    function renderModes() {
        langButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.lang === state.lang)));
        // English 沒有雙注音：整個開關收起來（用 hidden，報讀器與 Tab 都跳過）
        doubleContainer.hidden = state.lang === 'en';
        doubleToggle.checked = state.double;
        gameContainer.classList.toggle('double-mode-active', state.double);
        symbolTitle.textContent = state.double
            ? '用這兩個音造一個詞'
            : (state.lang === 'en' ? '開頭字母是……' : '開頭是……');
        categoryTitle.textContent = '題目是……';
    }

    function renderResult() {
        const r = state.result;
        if (!r) {
            symbolDisplay.textContent = '-';
            categoryDisplay.textContent = '-';
            categoryDisplay.classList.remove('long');
            categorySub.hidden = true;
            hintSection.hidden = true;
            return;
        }
        if (state.double) {
            symbolDisplay.textContent = `${r.s1} ${r.s2}`;
        } else {
            symbolDisplay.textContent = r.s1;
            const text = categoryText(r.cat);
            categoryDisplay.textContent = text;
            categoryDisplay.classList.toggle('long', text.length > (state.lang === 'en' ? 8 : 3));
            // English 模式附上中文，讓不熟英文的玩家也看得懂
            categorySub.hidden = state.lang !== 'en';
            categorySub.textContent = state.lang === 'en' ? CATEGORIES[r.cat].zh : '';
        }
        hintLink.href = `https://www.google.com/search?q=${encodeURIComponent(hintQuery())}`;
        hintSection.hidden = false;
    }

    function hintQuery() {
        const r = state.result;
        if (state.double) return `"${r.s1}${r.s2}" 造詞`;
        if (state.lang === 'en') return `${CATEGORIES[r.cat].en} that start with ${r.s1}`;
        return `${r.s1}開頭的${CATEGORIES[r.cat].zh}`;
    }

    function describeResult() {
        const r = state.result;
        if (state.double) return `出題：${r.s1}、${r.s2}，用這兩個音造一個詞。`;
        return `出題：開頭 ${r.s1}，題目 ${categoryText(r.cat)}。`;
    }

    // ---------------------------------------------------------------------
    // 出題
    // ---------------------------------------------------------------------
    function finalizeResult() {
        const source = state.lang === 'en' ? ALPHABET : ZHUYIN;
        state.result = state.double
            ? { s1: pick(source), s2: pick(source), cat: null }
            : { s1: pick(source), s2: null, cat: Math.floor(Math.random() * CATEGORIES.length) };
        state.rounds++;
        state.rolling = false;
        rollBtn.classList.remove('btn-animating');
        rollBtn.removeAttribute('aria-disabled');
        renderResult();
        saveGameState();
        announce(describeResult());
    }

    function startRoll() {
        if (state.rolling) return;
        state.rolling = true;
        hintSection.hidden = true;
        rollBtn.setAttribute('aria-disabled', 'true');

        // 減少動態效果：不跑跳字動畫，直接給結果
        if (reduceMotion()) {
            finalizeResult();
            return;
        }

        rollBtn.classList.add('btn-animating');
        const source = state.lang === 'en' ? ALPHABET : ZHUYIN;
        let counter = 0;
        const timer = window.setInterval(() => {
            if (state.double) {
                symbolDisplay.textContent = `${pick(source)} ${pick(source)}`;
            } else {
                symbolDisplay.textContent = pick(source);
                categoryDisplay.textContent = categoryText(Math.floor(Math.random() * CATEGORIES.length));
            }
            counter++;
            if (counter > 12) {
                window.clearInterval(timer);
                finalizeResult();
            }
        }, 50);
    }

    function setLang(lang) {
        if (lang === state.lang) return;
        state.lang = lang;
        if (lang === 'en') state.double = false;
        state.result = null;
        clearGameState();
        savePrefs();
        renderModes();
        renderResult();
        announce(lang === 'en' ? '改用英文字母出題。' : '改用注音出題。');
    }

    function setDouble(on) {
        state.double = on && state.lang === 'zh';
        state.result = null;
        clearGameState();
        savePrefs();
        renderModes();
        renderResult();
    }

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------
    langButtons.forEach(btn => btn.addEventListener('click', () => setLang(btn.dataset.lang)));
    doubleToggle.addEventListener('change', () => setDouble(doubleToggle.checked));
    rollBtn.addEventListener('click', startRoll);

    function syncThemeButton() {
        themeBtn.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
    }

    themeBtn.addEventListener('click', () => {
        if (typeof BoboTheme !== 'undefined') BoboTheme.toggle();
        else {
            const root = document.documentElement;
            root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        }
        syncThemeButton();
    });

    rulesBtn.addEventListener('click', () => {
        if (typeof rulesDialog.showModal === 'function') rulesDialog.showModal();
        else rulesDialog.setAttribute('open', '');
    });
    $('rules-close').addEventListener('click', () => rulesDialog.close());
    rulesDialog.addEventListener('close', () => rulesBtn.focus());
    rulesDialog.addEventListener('click', (event) => {
        if (event.target === rulesDialog) rulesDialog.close();
    });

    // ---------------------------------------------------------------------
    // 初始化
    // ---------------------------------------------------------------------
    if (typeof BoboTheme !== 'undefined') BoboTheme.init();
    syncThemeButton();
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncThemeButton).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    loadGameState();
    renderModes();
    renderResult();
})();
