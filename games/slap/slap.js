// 拍拍手遊戲（反應測速）
// 依序喊 A～K，同時一張張翻牌；翻出的牌和喊的一樣時要盡快拍。
// 計時一律在 JS，CSS 動畫只是視覺回饋，「減少動態效果」不影響判定。
(() => {
    'use strict';

    const SUITS = Object.freeze([
        { symbol: '♠', name: '黑桃', red: false },
        { symbol: '♥', name: '紅心', red: true },
        { symbol: '♦', name: '方塊', red: true },
        { symbol: '♣', name: '梅花', red: false }
    ]);
    const VALUES = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
    const DEAL_SPEED = 900;        // 發牌間隔（毫秒）
    const MISCLICK_PENALTY = 0.5;  // 誤按加秒
    const HISTORY_LIMIT = 30;
    const STATE_KEY = 'slap_state_v1';
    const STATS_KEY = 'slap_stats_v1';

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

    // ---------------------------------------------------------------------
    // 狀態
    // ---------------------------------------------------------------------
    const game = {
        running: false,      // 已開局（發牌中或回合結果顯示中）
        paused: true,        // 暫停發牌（結果框開著、緩衝時間）
        isMatch: false,
        matchStart: 0,
        currentCall: 0,
        penalty: 0,          // 這一回合累積的誤按秒數
        misclicks: 0,
        history: [],         // [{ time, penalty }]
        best: null,
        rounds: 0
    };
    let dealTimer = null;
    let resumeTimer = null;
    let lastSnapAt = 0;

    const $ = (id) => document.getElementById(id);
    const cardDisplay = $('cardDisplay');
    const callNum = $('callNum');
    const missedMsg = $('missedMsg');
    const snapBtn = $('snapBtn');
    const restartBtn = $('restartBtn');
    const historyPanel = $('historyPanel');
    const bestEl = $('bestTime');
    const statusEl = $('game-status');
    const resultDialog = $('result-dialog');
    const rulesDialog = $('rules-dialog');
    const themeBtn = $('theme-btn');

    const reduceMotion = () => {
        try {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_) {
            return false;
        }
    };

    function announce(message) {
        statusEl.textContent = '';
        window.setTimeout(() => { statusEl.textContent = message; }, 30);
    }

    const fmt = (sec) => `${sec.toFixed(3)} 秒`;

    // ---------------------------------------------------------------------
    // 存檔
    // ---------------------------------------------------------------------
    function saveGameState() {
        writeJSON(STATE_KEY, { history: game.history.slice(0, HISTORY_LIMIT) });
        writeJSON(STATS_KEY, { best: game.best, rounds: game.rounds });
    }

    function loadGameState() {
        const stats = readJSON(STATS_KEY);
        if (stats && Number.isFinite(stats.best) && stats.best > 0) game.best = stats.best;
        if (stats && Number.isInteger(stats.rounds) && stats.rounds >= 0) game.rounds = stats.rounds;
        const saved = readJSON(STATE_KEY);
        if (saved && Array.isArray(saved.history)) {
            game.history = saved.history
                .filter(item => item && Number.isFinite(item.time) && item.time >= 0)
                .map(item => ({ time: item.time, penalty: Number.isFinite(item.penalty) ? item.penalty : 0 }))
                .slice(0, HISTORY_LIMIT);
        }
    }

    function clearGameState() {
        removeKey(STATE_KEY);
    }

    // ---------------------------------------------------------------------
    // 畫面
    // ---------------------------------------------------------------------
    function renderHistory() {
        historyPanel.innerHTML = '';
        if (game.history.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'history-empty';
            empty.textContent = '還沒有成績，開始後翻到相同的牌就拍！';
            historyPanel.appendChild(empty);
        }
        game.history.forEach((item, i) => {
            const li = document.createElement('li');
            li.className = 'history-item';
            const number = game.history.length - i;
            const older = game.history[i + 1];
            let tag = '';
            if (!older) tag = '<span class="tag">第一筆</span>';
            else if (item.time < older.time) tag = '<span class="tag good">▲ 進步</span>';
            else if (item.time > older.time) tag = '<span class="tag bad">▼ 慢了一點</span>';
            const penalty = item.penalty > 0 ? `<span class="tag bad">含誤按 +${item.penalty.toFixed(1)}</span>` : '';
            li.innerHTML = `<span>第 ${number} 回</span><span class="time">${item.time.toFixed(3)} 秒 ${tag}${penalty}</span>`;
            historyPanel.appendChild(li);
        });
        bestEl.textContent = game.best ? `最快：${fmt(game.best)}` : '最快：—';
    }

    function renderCard(suit, valueIndex) {
        const value = VALUES[valueIndex];
        cardDisplay.className = `card playing ${suit.red ? 'red' : 'black'}`;
        cardDisplay.setAttribute('aria-label', `牌面：${suit.name} ${value}`);
        cardDisplay.innerHTML = `
            <span class="card-top" aria-hidden="true"><span>${value}</span><span>${suit.symbol}</span></span>
            <span class="card-center" aria-hidden="true">${suit.symbol}</span>
            <span class="card-bottom" aria-hidden="true"><span>${value}</span><span>${suit.symbol}</span></span>`;
        if (!reduceMotion()) {
            // 重新觸發發牌動畫
            cardDisplay.classList.remove('deal');
            void cardDisplay.offsetWidth;
            cardDisplay.classList.add('deal');
        }
    }

    function showStartCard() {
        cardDisplay.className = 'card';
        cardDisplay.removeAttribute('aria-disabled');
        cardDisplay.removeAttribute('aria-label');
        cardDisplay.innerHTML = '<span class="start-msg">點這裡開始</span>';
        callNum.textContent = '準備開始';
        callNum.classList.remove('show', 'missed');
        missedMsg.textContent = '';
    }

    function flashMissed() {
        callNum.classList.remove('missed');
        void callNum.offsetWidth;
        callNum.classList.add('missed');
        missedMsg.textContent = '剛剛那張對上了，錯過囉！';
        window.clearTimeout(flashMissed.timer);
        flashMissed.timer = window.setTimeout(() => {
            callNum.classList.remove('missed');
            missedMsg.textContent = '';
        }, 900);
    }

    // ---------------------------------------------------------------------
    // 遊戲流程
    // ---------------------------------------------------------------------
    function startDealing() {
        game.paused = false;
        nextTurn();
        window.clearInterval(dealTimer);
        dealTimer = window.setInterval(nextTurn, DEAL_SPEED);
    }

    function stopDealing() {
        game.paused = true;
        window.clearInterval(dealTimer);
        window.clearTimeout(resumeTimer);
        dealTimer = null;
    }

    function startGame() {
        if (game.running) return;
        game.running = true;
        game.currentCall = 0;
        game.penalty = 0;
        cardDisplay.setAttribute('aria-disabled', 'true');
        cardDisplay.classList.add('playing');
        callNum.classList.add('show');
        snapBtn.disabled = false;
        snapBtn.classList.add('active');
        // 開局後焦點交給「拍！」，鍵盤使用者直接按空白鍵／Enter
        snapBtn.focus();
        announce('開始！翻出的牌和喊的一樣就拍。');
        startDealing();
    }

    function nextTurn() {
        if (game.isMatch) flashMissed();

        game.currentCall = game.currentCall >= VALUES.length ? 1 : game.currentCall + 1;
        callNum.textContent = `喊數：${VALUES[game.currentCall - 1]}`;

        const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
        const valueIndex = Math.floor(Math.random() * VALUES.length);
        renderCard(suit, valueIndex);

        game.isMatch = (valueIndex + 1) === game.currentCall;
        if (game.isMatch) game.matchStart = performance.now();
    }

    function playerSnap() {
        // 結果框開著或緩衝中都不算數（修正：結果框開著時按 Enter 會多記一筆）
        if (!game.running || game.paused || resultDialog.open) return;
        lastSnapAt = performance.now();

        if (game.isMatch) {
            const reaction = (performance.now() - game.matchStart) / 1000;
            stopDealing();
            game.isMatch = false;
            handleSuccess(reaction);
            return;
        }

        // 誤按：這一回合加 0.5 秒，真的算進成績
        game.penalty += MISCLICK_PENALTY;
        game.misclicks++;
        cardDisplay.classList.remove('shake');
        void cardDisplay.offsetWidth;
        cardDisplay.classList.add('shake');
        window.setTimeout(() => cardDisplay.classList.remove('shake'), 320);
        missedMsg.textContent = `誤按！這回合 +${game.penalty.toFixed(1)} 秒`;
        announce(`誤按，這回合加 ${MISCLICK_PENALTY} 秒。`);
    }

    function handleSuccess(reaction) {
        const penalty = game.penalty;
        const total = Math.round((reaction + penalty) * 1000) / 1000;
        const prev = game.history[0] ? game.history[0].time : null;
        const isBest = !game.best || total < game.best;

        game.history.unshift({ time: total, penalty });
        game.history = game.history.slice(0, HISTORY_LIMIT);
        game.rounds++;
        if (isBest) game.best = total;
        game.penalty = 0;
        missedMsg.textContent = '';
        saveGameState();
        renderHistory();

        const title = $('modalTitle');
        const msg = $('modalMsg');
        const breakdown = $('modalBreakdown');
        $('modalTime').textContent = fmt(total);
        if (penalty > 0) {
            breakdown.hidden = false;
            breakdown.textContent = `反應 ${reaction.toFixed(3)} 秒 ＋ 誤按 ${penalty.toFixed(1)} 秒`;
        } else {
            breakdown.hidden = true;
        }

        title.className = 'result-title';
        if (prev === null) {
            title.textContent = '第一筆成績！';
            msg.textContent = '已記下來了，下一回合試著更快。';
        } else if (total < prev) {
            title.textContent = isBest ? '新紀錄！' : '恭喜進步！';
            title.classList.add('good');
            msg.textContent = `比上一回合快了 ${(prev - total).toFixed(3)} 秒。`;
        } else {
            title.textContent = '慢了一點點';
            title.classList.add('bad');
            msg.textContent = `比上一回合慢 ${(total - prev).toFixed(3)} 秒，深呼吸，再來一次！`;
        }

        if (typeof resultDialog.showModal === 'function') resultDialog.showModal();
        else resultDialog.setAttribute('open', '');
        announce(`${title.textContent} ${fmt(total)}。`);
    }

    function continueGame() {
        closeResult();
        // 稍微緩衝再發牌；這段時間 paused 仍為 true，按了也不算
        resumeTimer = window.setTimeout(() => {
            if (game.running) startDealing();
        }, 500);
        snapBtn.focus();
    }

    function stopGame() {
        closeResult();
        stopDealing();
        game.running = false;
        game.isMatch = false;
        snapBtn.disabled = true;
        snapBtn.classList.remove('active');
        showStartCard();
        cardDisplay.focus();
        announce('先休息一下，按「點這裡開始」繼續。');
    }

    function fullReset() {
        stopDealing();
        game.running = false;
        game.isMatch = false;
        game.penalty = 0;
        game.history = [];
        clearGameState();
        saveGameState();
        renderHistory();
        snapBtn.disabled = true;
        snapBtn.classList.remove('active');
        showStartCard();
        announce('成績已清空，最快紀錄保留。');
    }

    function closeResult() {
        if (!resultDialog.open) return;
        if (typeof resultDialog.close === 'function') resultDialog.close();
        else resultDialog.removeAttribute('open');
    }

    // ---------------------------------------------------------------------
    // 主題（只在使用者按下時寫入偏好）
    // ---------------------------------------------------------------------
    function syncThemeButton() {
        themeBtn.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
    }

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------
    cardDisplay.addEventListener('click', () => {
        if (!game.running) startGame();
    });

    // 觸控／滑鼠用 pointerdown 反應最快；鍵盤在 keydown 處理；
    // click 只接報讀器等「沒有 pointerdown 的點擊」，用時間戳避免同一下算兩次
    snapBtn.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        playerSnap();
    });
    snapBtn.addEventListener('click', () => {
        if (performance.now() - lastSnapAt < 400) return;
        playerSnap();
    });

    document.addEventListener('keydown', (event) => {
        if (event.code !== 'Space' && event.key !== 'Enter') return;
        if (!game.running || resultDialog.open || rulesDialog.open) return;
        const target = event.target;
        // 聚焦在其他按鈕或連結時保留它們原本的行為
        if (target instanceof Element && target.closest('a, button') && target !== snapBtn && target !== cardDisplay) return;
        event.preventDefault();
        if (!event.repeat) playerSnap();
    });

    $('continueBtn').addEventListener('click', continueGame);
    $('stopBtn').addEventListener('click', stopGame);
    // Esc 關閉結果框等同「先休息」，避免停在沒發牌的狀態
    resultDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        stopGame();
    });

    restartBtn.addEventListener('click', fullReset);

    const rulesBtn = $('rules-btn');
    rulesBtn.addEventListener('click', () => {
        // 看規則時暫停發牌，關掉後再接續
        if (game.running && !game.paused) {
            stopDealing();
            rulesDialog.dataset.resume = '1';
        }
        if (typeof rulesDialog.showModal === 'function') rulesDialog.showModal();
        else rulesDialog.setAttribute('open', '');
    });
    $('rules-close').addEventListener('click', () => rulesDialog.close());
    rulesDialog.addEventListener('close', () => {
        rulesBtn.focus();
        if (rulesDialog.dataset.resume === '1') {
            delete rulesDialog.dataset.resume;
            resumeTimer = window.setTimeout(() => {
                if (game.running && !resultDialog.open) startDealing();
            }, 500);
        }
    });

    themeBtn.addEventListener('click', () => {
        if (typeof BoboTheme !== 'undefined') BoboTheme.toggle();
        else {
            const root = document.documentElement;
            root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        }
        syncThemeButton();
    });

    // 切到背景就暫停，回來時讓玩家自己按開始（避免背景偷發牌）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && game.running && !resultDialog.open) stopGame();
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
    renderHistory();
    showStartCard();
})();
