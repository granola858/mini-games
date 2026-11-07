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
    const SET_SIZE = 5;            // 每組回合數：打完一組才端出結果卡片，不打斷每回合的節奏
    const ROUND_PAUSE = 1300;      // 每回合拍中後，成績留在桌上這麼久再繼續發牌
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
        set: [],             // 目前這一組已完成的回合 [{ time, penalty, misclicks }]
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
    const pauseBtn = $('pauseBtn');
    const setProgressEl = $('setProgress');
    const historyPanel = $('historyPanel');
    const bestEl = $('bestTime');
    const statusEl = $('game-status');
    const rulesDialog = $('rules-dialog');
    const celebrate = (typeof BoboCelebrate !== 'undefined') ? BoboCelebrate : null;
    // 結果卡片開著時不接受拍擊（修正：結果視窗開著時按 Enter 會多記一筆）
    const summaryOpen = () => !!(celebrate && celebrate.isOpen());
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
        writeJSON(STATE_KEY, { history: game.history.slice(0, HISTORY_LIMIT), set: game.set });
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
        if (saved && Array.isArray(saved.set)) {
            game.set = saved.set
                .filter(item => item && Number.isFinite(item.time) && item.time >= 0)
                .map(item => ({
                    time: item.time,
                    penalty: Number.isFinite(item.penalty) ? item.penalty : 0,
                    misclicks: Number.isInteger(item.misclicks) ? item.misclicks : 0
                }))
                .slice(0, SET_SIZE - 1);
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
        renderSetProgress();
    }

    function renderSetProgress() {
        setProgressEl.textContent = game.running
            ? `第 ${Math.min(game.set.length + 1, SET_SIZE)}／${SET_SIZE} 回`
            : (game.set.length ? `這組已打 ${game.set.length}／${SET_SIZE} 回` : `每組 ${SET_SIZE} 回合`);
    }

    // 桌上的訊息列：誤按、錯過、每回合成績都寫在這裡（tone: good / bad / 空）
    function setTableMsg(text, tone) {
        missedMsg.textContent = text;
        missedMsg.classList.toggle('good', tone === 'good');
        missedMsg.classList.toggle('bad', tone === 'bad');
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
        setTableMsg('', '');
    }

    function flashMissed() {
        callNum.classList.remove('missed');
        void callNum.offsetWidth;
        callNum.classList.add('missed');
        setTableMsg('剛剛那張對上了，錯過囉！', 'bad');
        window.clearTimeout(flashMissed.timer);
        flashMissed.timer = window.setTimeout(() => {
            callNum.classList.remove('missed');
            setTableMsg('', '');
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
        pauseBtn.hidden = false;
        renderSetProgress();
        // 開局後焦點交給「拍！」，鍵盤使用者直接按空白鍵／Enter
        snapBtn.focus();
        announce(`開始！翻出的牌和喊的一樣就拍。第 ${game.set.length + 1}／${SET_SIZE} 回。`);
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
        if (!game.running || game.paused || summaryOpen()) return;
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
        setTableMsg(`誤按！這回合 +${game.penalty.toFixed(1)} 秒`, 'bad');
        announce(`誤按，這回合加 ${MISCLICK_PENALTY} 秒。`);
    }

    function handleSuccess(reaction) {
        const penalty = game.penalty;
        const misclicks = game.misclicks;
        const total = Math.round((reaction + penalty) * 1000) / 1000;
        const prev = game.history[0] ? game.history[0].time : null;
        const isBest = !game.best || total < game.best;

        game.history.unshift({ time: total, penalty });
        game.history = game.history.slice(0, HISTORY_LIMIT);
        game.set.push({ time: total, penalty, misclicks, isBest });
        game.rounds++;
        if (isBest) game.best = total;
        game.penalty = 0;
        game.misclicks = 0;
        saveGameState();
        renderHistory();

        // 每回合的成績寫在桌上（不跳視窗），稍等一下自動繼續發牌
        let verdict;
        let tone = '';
        if (isBest && prev !== null) {
            verdict = '新紀錄！';
            tone = 'good';
        } else if (prev === null) {
            verdict = '第一筆成績';
        } else if (total < prev) {
            verdict = `比上回快 ${(prev - total).toFixed(3)} 秒`;
            tone = 'good';
        } else {
            verdict = `比上回慢 ${(total - prev).toFixed(3)} 秒`;
        }
        const penaltyNote = penalty > 0 ? `（含誤按 +${penalty.toFixed(1)}）` : '';
        setTableMsg(`拍中！${fmt(total)}${penaltyNote} · ${verdict}`, tone);
        announce(`拍中，${fmt(total)}${penaltyNote}，${verdict}。`);

        if (game.set.length >= SET_SIZE) {
            showSetSummary();
            return;
        }
        renderSetProgress();
        resumeTimer = window.setTimeout(() => {
            if (game.running && !summaryOpen() && document.visibilityState !== 'hidden') {
                setTableMsg('', '');
                startDealing();
            }
        }, ROUND_PAUSE);
    }

    // 一組打完：用全站共用的過關卡片做小結（平均、最快、誤按）
    function showSetSummary() {
        const set = game.set.slice();
        game.set = [];
        saveGameState();
        renderSetProgress();

        const times = set.map(item => item.time);
        const avg = times.reduce((sum, t) => sum + t, 0) / times.length;
        const fastest = Math.min(...times);
        const misclicks = set.reduce((sum, item) => sum + (item.misclicks || 0), 0);
        const brokeRecord = set.some(item => item.isBest);

        if (!celebrate) {
            announce(`這組完成，平均 ${fmt(avg)}，最快 ${fmt(fastest)}。`);
            resumeTimer = window.setTimeout(() => {
                if (game.running) startDealing();
            }, ROUND_PAUSE);
            return;
        }

        // 小結卡片上的「五張成績牌」：這組每一回的秒數，最快的那張標出來
        const extra = document.createElement('ol');
        extra.className = 'set-cards';
        extra.setAttribute('aria-label', '這組每回合的成績');
        set.forEach((item, i) => {
            const li = document.createElement('li');
            li.className = item.time === fastest ? 'set-card fastest' : 'set-card';
            li.innerHTML = `<span class="set-card-round">第 ${i + 1} 回</span><span class="set-card-time">${item.time.toFixed(3)}</span>`;
            extra.appendChild(li);
        });

        window.setTimeout(() => {
            celebrate.show({
                outcome: 'win',
                gameName: '拍拍手遊戲',
                title: brokeRecord ? '這組刷新了紀錄！' : `${SET_SIZE} 回合完成！`,
                subtitle: `平均 ${fmt(avg)}，最快一回 ${fmt(fastest)}。`,
                stats: [
                    { label: '平均', value: `${avg.toFixed(3)} 秒` },
                    { label: '本組最快', value: `${fastest.toFixed(3)} 秒`, isBest: brokeRecord },
                    { label: '誤按', value: `${misclicks} 次` }
                ],
                extra,
                accent: '#357A22',
                accentDark: '#8BD37A',
                returnFocus: snapBtn,
                primary: {
                    label: '再來一組',
                    onClick: () => {
                        if (!game.running) return;
                        setTableMsg('', '');
                        renderSetProgress();
                        snapBtn.focus();
                        resumeTimer = window.setTimeout(() => {
                            if (game.running && !summaryOpen()) startDealing();
                        }, 500);
                    }
                },
                secondary: { label: '先休息', onClick: stopGame },
                // Esc 關掉卡片等同「先休息」，避免停在沒發牌的狀態
                onClose: (reason) => {
                    if (reason === 'dismiss') stopGame();
                }
            });
        }, 450);
    }

    function stopGame() {
        stopDealing();
        game.running = false;
        game.isMatch = false;
        game.penalty = 0;
        game.misclicks = 0;
        snapBtn.disabled = true;
        snapBtn.classList.remove('active');
        pauseBtn.hidden = true;
        showStartCard();
        renderSetProgress();
        cardDisplay.focus();
        announce('先休息一下，按「點這裡開始」繼續。');
    }

    function fullReset() {
        stopDealing();
        game.running = false;
        game.isMatch = false;
        game.penalty = 0;
        game.misclicks = 0;
        game.history = [];
        game.set = [];
        clearGameState();
        saveGameState();
        renderHistory();
        snapBtn.disabled = true;
        snapBtn.classList.remove('active');
        pauseBtn.hidden = true;
        showStartCard();
        announce('成績已清空，最快紀錄保留。');
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
        if (!game.running || summaryOpen() || rulesDialog.open) return;
        const target = event.target;
        // 聚焦在其他按鈕或連結時保留它們原本的行為
        if (target instanceof Element && target.closest('a, button') && target !== snapBtn && target !== cardDisplay) return;
        event.preventDefault();
        if (!event.repeat) playerSnap();
    });

    pauseBtn.addEventListener('click', stopGame);
    restartBtn.addEventListener('click', fullReset);

    const rulesBtn = $('rules-btn');
    rulesBtn.addEventListener('click', () => {
        // 看規則時暫停發牌，關掉後再接續
        // 回合間的等待（成績留在桌上時）也要一併停住，避免看規則時偷發牌
        if (game.running && !summaryOpen()) {
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
                if (game.running && !summaryOpen()) startDealing();
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
        if (document.visibilityState === 'hidden' && game.running && !summaryOpen()) stopGame();
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
