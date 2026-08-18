// --- 遊戲核心變數 ---
        const suits = ['♠', '♥', '♦', '♣'];
        const displayValues = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

        let gameInterval = null;
        let isRunning = false;      // 遊戲是否正在跑
        let isMatch = false;        // 是否配對成功
        let matchStartTime = 0;     // 配對時間點
        let dealSpeed = 900;        // 發牌速度 (毫秒)

        let currentCall = 0;        // 目前喊的數字 (1-13)
        let currentCardVal = 0;     // 目前牌面數字

        let historyData = [];       // 儲存成績

        // --- DOM 元素 ---
        const cardDisplay = document.getElementById('cardDisplay');
        const callNumDisplay = document.getElementById('callNum');
        const snapBtn = document.getElementById('snapBtn');
        const restartBtn = document.getElementById('restartBtn');
        const historyPanel = document.getElementById('historyPanel');
        const modal = document.getElementById('modal');

        // --- 卡片點擊處理 ---
        function handleCardClick() {
            // 只有在遊戲還沒開始時，點擊卡片才有效
            if (!isRunning) {
                startGame();
            }
        }

        // --- 開始遊戲 ---
        function startGame() {
            isRunning = true;

            // UI 更新：進入遊戲狀態
            cardDisplay.classList.add('playing'); // 移除手指游標
            callNumDisplay.classList.add('show'); // 顯示喊話氣泡
            historyPanel.classList.add('show');   // 顯示歷史紀錄區

            snapBtn.disabled = false;
            snapBtn.classList.add('active');      // 讓 SNAP 按鈕變色亮起

            currentCall = 0;

            // 如果是第一次開始（沒有任何內容），可以在這裡清空或初始化
            if (historyPanel.innerHTML.trim() === '') {
                historyPanel.innerHTML = '<div style="text-align:center; color:#e0e0e0; padding-top:20px;">等待成績...</div>';
            }

            nextTurn(); // 發第一張
            gameInterval = setInterval(nextTurn, dealSpeed);
        }

        // --- 完全重置 (回到初始畫面) ---
        function fullReset() {
            clearInterval(gameInterval);
            isRunning = false;
            historyData = [];

            // UI 還原：回到初始狀態
            cardDisplay.classList.remove('playing');
            callNumDisplay.classList.remove('show');
            historyPanel.classList.remove('show');

            snapBtn.disabled = true;
            snapBtn.classList.remove('active');

            // 還原卡片內容為「點擊開始」
            cardDisplay.className = 'card'; // 移除紅黑樣式
            cardDisplay.innerHTML = '<div class="start-msg">點擊開始</div>';

            // 清空歷史區塊內容
            historyPanel.innerHTML = '';

            // 關閉彈窗 (如果有的話)
            modal.style.display = 'none';
        }

        // --- 下一回合 (發牌邏輯) ---
        function nextTurn() {
            // 檢查錯過邏輯 (上一張 Match 但沒按)
            if (isMatch) {
                callNumDisplay.style.color = 'var(--accent-color)';
                setTimeout(() => callNumDisplay.style.color = 'var(--primary-color)', 300);
            }

            // 1. 更新喊話
            currentCall++;
            if (currentCall > 13) currentCall = 1;
            callNumDisplay.innerText = `喊數：${displayValues[currentCall - 1]}`;

            // 2. 隨機發牌
            const randomSuit = suits[Math.floor(Math.random() * 4)];
            const randomVal = Math.floor(Math.random() * 13) + 1;
            currentCardVal = randomVal;

            // 3. 渲染卡片
            renderCard(randomSuit, randomVal);

            // 4. 判定
            if (currentCall === currentCardVal) {
                isMatch = true;
                matchStartTime = performance.now();
            } else {
                isMatch = false;
            }
        }

        function renderCard(suit, val) {
            const valStr = displayValues[val - 1];
            const isRed = (suit === '♥' || suit === '♦');

            cardDisplay.className = `card playing ${isRed ? 'red' : 'black'}`;
            // 動畫
            cardDisplay.style.transform = "scale(0.95)";
            setTimeout(() => cardDisplay.style.transform = "scale(1)", 100);

            cardDisplay.innerHTML = `
                <div class="card-top">
                    <span>${valStr}</span><span>${suit}</span>
                </div>
                <div class="card-center">${suit}</div>
                <div class="card-bottom">
                    <span>${valStr}</span><span>${suit}</span>
                </div>
            `;
        }

        // --- 玩家按下 SNAP ---
        function playerSnap() {
            if (!isRunning) return;

            if (isMatch) {
                // 成功
                clearInterval(gameInterval);
                const reactionTime = (performance.now() - matchStartTime) / 1000;
                handleSuccess(reactionTime);
            } else {
                // 失敗 (誤按)
                cardDisplay.classList.add('shake');
                setTimeout(() => cardDisplay.classList.remove('shake'), 300);

                // 在歷史加一筆懲罰 (可選)
                const tempMsg = document.createElement('div');
                tempMsg.className = 'history-item';
                tempMsg.style.color = 'var(--accent-color)';
                tempMsg.innerHTML = '<span style="flex:1">誤按!</span> <span>+0.5s</span>';

                // 移除"等待成績"提示
                if (historyPanel.innerText.includes('等待成績')) historyPanel.innerHTML = '';
                historyPanel.insertBefore(tempMsg, historyPanel.firstChild);
            }
        }

        // --- 處理成功並顯示彈窗 ---
        function handleSuccess(time) {
            const currentSec = parseFloat(time.toFixed(3));
            let prevSec = null;

            // 尋找上一筆有效成績 (排除懲罰)
            if (historyData.length > 0) {
                prevSec = historyData[historyData.length - 1];
            }
            historyData.push(currentSec);

            // 更新彈窗內容
            const modalTitle = document.getElementById('modalTitle');
            const modalMsg = document.getElementById('modalMsg');
            const modalTime = document.getElementById('modalTime');

            modalTime.innerText = `${currentSec}s`;

            if (prevSec === null) {
                modalTitle.innerText = "開局順利！";
                modalTitle.style.color = "var(--primary-color)";
                modalMsg.innerText = "第一筆成績已記錄，繼續保持！";
            } else {
                if (currentSec < prevSec) {
                    modalTitle.innerText = "恭喜進步！";
                    modalTitle.style.color = "var(--success-color)";
                    modalMsg.innerText = `比上次快了 ${(prevSec - currentSec).toFixed(3)}秒！心臟很強喔！`;
                } else {
                    modalTitle.innerText = "退步囉...";
                    modalTitle.style.color = "var(--accent-color)";
                    modalMsg.innerText = `比上次慢了 ${(currentSec - prevSec).toFixed(3)}秒，是不是老了？`;
                }
            }

            updateHistoryUI(currentSec, prevSec);
            modal.style.display = 'flex';
        }

        function updateHistoryUI(current, prev) {
            // 清除"等待成績"
            if (historyPanel.innerText.includes('等待成績')) historyPanel.innerHTML = '';

            const index = historyData.length;
            const item = document.createElement('div');
            item.className = 'history-item';

            let statusTag = '';
            if (prev !== null) {
                if (current < prev) statusTag = '<span class="good"> (▲進步)</span>';
                else statusTag = '<span class="bad"> (▼退步)</span>';
            } else {
                statusTag = '<span style="font-size:0.8em; color:#bdbdbd"> (New)</span>';
            }

            item.innerHTML = `
                <span>第 ${index} 次</span>
                <span>${current}s ${statusTag}</span>
            `;

            historyPanel.insertBefore(item, historyPanel.firstChild);
        }

        // --- 繼續下一局 ---
        function continueGame() {
            modal.style.display = 'none';
            isMatch = false;

            // 稍微緩衝再開始
            setTimeout(() => {
                nextTurn();
                gameInterval = setInterval(nextTurn, dealSpeed);
            }, 500);
        }
