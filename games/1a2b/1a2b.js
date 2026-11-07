// 1A2B 猜數字
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

    const confettiCanvas = document.getElementById('confetti-canvas');
    const celebrate = () => {
        if (typeof BoboConfetti !== 'undefined') BoboConfetti.burst(confettiCanvas);
    };

    // ======================================================================
    // 遊戲狀態
    // ======================================================================
    const STATE_KEY = '1a2b_game_state';
    const STATS_KEY = '1a2b_stats';

    let answer = '';
    let isGameOver = false;
    let gaveUp = false;
    let count = 0;
    let historyData = [];
    let stats = { wins: 0, best: null, plays: 0 };

    const inputs = Array.from(document.querySelectorAll('.digit-input'));
    const form = document.getElementById('guess-form');
    const digitGroup = document.getElementById('digit-group');
    const submitBtn = document.getElementById('submit-btn');
    const giveupBtn = document.getElementById('giveup-btn');
    const restartBtn = document.getElementById('restart-btn');
    const statusEl = document.getElementById('status');
    const historyList = document.getElementById('history-list');
    const historyEmpty = document.getElementById('history-empty');
    const guessCountEl = document.getElementById('guess-count');
    const bestCountEl = document.getElementById('best-count');
    const winCountEl = document.getElementById('win-count');
    const lastResult = document.getElementById('last-result');
    const lastGuessEl = document.getElementById('last-guess');
    const lastAbEl = document.getElementById('last-ab');
    const lastExplainEl = document.getElementById('last-explain');
    const resultDialog = document.getElementById('result-dialog');
    resultDialog._fallback = restartBtn;

    function setStatus(text, tone) {
        statusEl.textContent = text;
        if (tone) statusEl.dataset.tone = tone;
        else delete statusEl.dataset.tone;
    }

    // --- 存檔 ---
    function saveGameState() {
        writeJSON(STATE_KEY, { answer, isGameOver, gaveUp, count, historyData });
    }

    function clearGameState() {
        store.remove(STATE_KEY);
    }

    function loadStats() {
        const saved = readJSON(STATS_KEY, {});
        stats = {
            wins: Number.isInteger(saved.wins) && saved.wins >= 0 ? saved.wins : 0,
            best: Number.isInteger(saved.best) && saved.best > 0 ? saved.best : null,
            plays: Number.isInteger(saved.plays) && saved.plays >= 0 ? saved.plays : 0
        };
    }

    function saveStats() {
        writeJSON(STATS_KEY, stats);
    }

    function isValidAnswer(str) {
        return typeof str === 'string' && /^\d{4}$/.test(str) && new Set(str).size === 4;
    }

    function loadGameState() {
        const state = readJSON(STATE_KEY, null);
        if (!state || !isValidAnswer(state.answer)) return false;
        answer = state.answer;
        isGameOver = !!state.isGameOver;
        gaveUp = !!state.gaveUp;
        count = Number.isInteger(state.count) && state.count >= 0 ? state.count : 0;
        historyData = Array.isArray(state.historyData)
            ? state.historyData.filter(item => item && /^\d{4}$/.test(item.guess) && /^\dA\dB$/.test(item.result))
            : [];
        return true;
    }

    // --- 規則 ---
    function generateAnswer() {
        const nums = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        for (let i = nums.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [nums[i], nums[j]] = [nums[j], nums[i]];
        }
        return nums.slice(0, 4).join('');
    }

    function validateInput(str) {
        if (str.length !== 4) return '請填滿 4 個數字';
        if (!/^\d+$/.test(str)) return '只能輸入數字';
        if (new Set(str.split('')).size !== 4) return '數字不能重複';
        return null;
    }

    function checkAB(guess, ans) {
        let a = 0;
        let b = 0;
        for (let i = 0; i < 4; i++) {
            if (guess[i] === ans[i]) a++;
            else if (ans.includes(guess[i])) b++;
        }
        return `${a}A${b}B`;
    }

    function explain(result) {
        const a = Number(result[0]);
        const b = Number(result[2]);
        if (a === 4) return '全部猜中！';
        if (a === 0 && b === 0) return '4 個數字都不在答案裡';
        const parts = [];
        if (a) parts.push(`${a} 個數字和位置都對`);
        if (b) parts.push(`${b} 個數字對但位置不對`);
        return parts.join('，');
    }

    // --- 畫面 ---
    function renderStats() {
        guessCountEl.textContent = count;
        bestCountEl.textContent = stats.best ?? '—';
        winCountEl.textContent = stats.wins;
    }

    function renderHistory() {
        historyList.innerHTML = '';
        // 最新的一筆放最上面
        historyData.slice().reverse().forEach((item, idx) => {
            const li = document.createElement('li');
            li.className = 'history-item';
            if (item.result === '4A0B') li.classList.add('is-win');
            const num = historyData.length - idx;
            li.innerHTML = `<span class="h-num">${num}</span>`
                + `<span class="h-guess">${item.guess.split('').join(' ')}</span>`
                + `<span class="h-result">${item.result}</span>`;
            li.setAttribute('aria-label', `第 ${num} 次：${item.guess}，${item.result}`);
            historyList.appendChild(li);
        });
        historyEmpty.hidden = historyData.length > 0;
    }

    function renderLastResult() {
        const last = historyData[historyData.length - 1];
        if (!last) {
            lastResult.hidden = true;
            return;
        }
        lastResult.hidden = false;
        lastGuessEl.textContent = last.guess;
        lastAbEl.textContent = last.result;
        lastExplainEl.textContent = explain(last.result);
        lastResult.classList.toggle('is-win', last.result === '4A0B');
    }

    function setInputsEnabled(enabled) {
        inputs.forEach(input => { input.disabled = !enabled; });
        submitBtn.disabled = !enabled;
        giveupBtn.disabled = !enabled;
    }

    function clearInputs() {
        inputs.forEach(input => { input.value = ''; });
    }

    function renderAll() {
        renderStats();
        renderHistory();
        renderLastResult();
        setInputsEnabled(!isGameOver);
    }

    // --- 流程 ---
    function newGame(focus = true) {
        clearGameState();
        answer = generateAnswer();
        isGameOver = false;
        gaveUp = false;
        count = 0;
        historyData = [];
        clearInputs();
        saveGameState();
        renderAll();
        setStatus('新的一局開始了，輸入第一個猜測吧。');
        if (focus) inputs[0].focus();
    }

    function showResult({ won }) {
        resultDialog.dataset.tone = won ? 'win' : 'lose';
        document.getElementById('result-emoji').textContent = won ? '🎉' : '🤔';
        document.getElementById('result-title').textContent = won ? '猜中了！' : '下次一定行';
        document.getElementById('result-answer').textContent = answer;
        document.getElementById('result-count').textContent = count;
        document.getElementById('result-best').textContent = stats.best ?? '—';
        openDialog(resultDialog, document.getElementById('result-again'));
    }

    function handleGuess() {
        if (isGameOver) return;
        const val = inputs.map(input => input.value).join('');
        const errorMsg = validateInput(val);

        if (errorMsg) {
            setStatus(errorMsg, 'error');
            digitGroup.classList.remove('is-invalid');
            void digitGroup.offsetWidth; // 重新觸發提示動畫
            digitGroup.classList.add('is-invalid');
            const firstBad = inputs.find(input => input.value === '') || inputs[0];
            firstBad.focus();
            return;
        }

        count++;
        const result = checkAB(val, answer);
        historyData.push({ guess: val, result });

        if (result === '4A0B') {
            isGameOver = true;
            stats.wins++;
            stats.plays++;
            const isRecord = stats.best === null || count < stats.best;
            if (isRecord) stats.best = count;
            saveStats();
            saveGameState();
            renderAll();
            setStatus(`恭喜！你用了 ${count} 次猜中答案 ${answer}。`, 'success');
            document.getElementById('result-record').hidden = !isRecord;
            celebrate();
            showResult({ won: true });
            return;
        }

        saveGameState();
        renderAll();
        clearInputs();
        setStatus(`${val}：${result}，${explain(result)}。`);
        inputs[0].focus();
    }

    // --- 輸入框行為 ---
    inputs.forEach((input, index) => {
        input.addEventListener('input', () => {
            digitGroup.classList.remove('is-invalid');
            const digits = input.value.replace(/\D/g, '');
            input.value = digits.slice(-1);
            if (input.value !== '' && index < inputs.length - 1) inputs[index + 1].focus();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && input.value === '' && index > 0) {
                e.preventDefault();
                inputs[index - 1].value = '';
                inputs[index - 1].focus();
            } else if (e.key === 'ArrowLeft' && index > 0) {
                e.preventDefault();
                inputs[index - 1].focus();
            } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
                e.preventDefault();
                inputs[index + 1].focus();
            }
        });

        input.addEventListener('focus', () => input.select());

        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
            if (text.length < 4) return;
            inputs.forEach((inp, i) => { inp.value = text[i]; });
            submitBtn.focus();
        });
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        handleGuess();
    });

    giveupBtn.addEventListener('click', async () => {
        if (isGameOver) return;
        const ok = await askConfirm('放棄這一局並揭曉答案？這局不會算進過關次數。', '揭曉答案');
        if (!ok) return;
        isGameOver = true;
        gaveUp = true;
        stats.plays++;
        saveStats();
        saveGameState();
        renderAll();
        setStatus(`答案是 ${answer}。再來一局吧！`);
        document.getElementById('result-record').hidden = true;
        showResult({ won: false });
    });

    restartBtn.addEventListener('click', async () => {
        if (!isGameOver && count > 0) {
            const ok = await askConfirm('目前這局還沒猜中，確定要重新開局嗎？', '重新開局');
            if (!ok) return;
        }
        newGame();
    });

    document.getElementById('result-again').addEventListener('click', () => {
        resultDialog._skipRestore = true;
        closeDialog(resultDialog);
        newGame();
    });
    document.getElementById('result-close').addEventListener('click', () => {
        resultDialog._skipRestore = true;
        closeDialog(resultDialog);
        restartBtn.focus();
    });

    // --- 啟動 ---
    loadStats();
    if (loadGameState()) {
        renderAll();
        if (isGameOver) {
            setStatus(gaveUp ? `上一局的答案是 ${answer}。按「重新開局」再挑戰。` : `上一局已猜中 ${answer}。按「重新開局」再挑戰。`);
        } else if (count > 0) {
            setStatus(`接續上一局：已經猜了 ${count} 次。`);
        }
    } else {
        // 第一次進站不搶焦點，避免手機一進來就跳出鍵盤
        newGame(false);
    }
})();
