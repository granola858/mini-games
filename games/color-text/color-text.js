// --- 遊戲設定 ---
        const config = {
            easy: 4,
            medium: 6,
            hard: 9
        };

        const items = [
            { text: '紅', class: 'c-red', name: '紅色' },
            { text: '藍', class: 'c-blue', name: '藍色' },
            { text: '綠', class: 'c-green', name: '綠色' },
            { text: '黃', class: 'c-yellow', name: '黃色' },
            { text: '黑', class: 'c-black', name: '黑色' }
        ];

        let currentMode = 'easy';
        let currentCount = 4;
        let gameData = [];
        let correctAnswer = 0;
        let timerId = null;
        let currentStreak = 0;

        // --- 功能實作 ---

        function setMode(mode, count, btnElement) {
            currentMode = mode;
            currentCount = count;

            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btnElement.classList.add('active');

            resetGameUI();
            updateStreak(0, true);
        }

        function resetGameUI() {
            document.getElementById('grid').innerHTML = '';
            document.getElementById('question-box').style.display = 'none';
            document.getElementById('start-btn').style.display = 'block';
            document.getElementById('result-overlay').style.display = 'none';
            document.getElementById('timer-bar-container').style.display = 'none';

            const fill = document.getElementById('timer-bar-fill');
            fill.style.animation = 'none';
            if (timerId) clearTimeout(timerId);
        }

        function updateStreak(val, isReset = false) {
            if (isReset) {
                currentStreak = val;
            } else {
                currentStreak += val;
            }
            document.getElementById('streak-score').innerText = currentStreak;
        }

        function startGame() {
            resetGameUI();
            document.getElementById('start-btn').style.display = 'none';

            // 1. 生成與排版
            gameData = [];
            const gridEl = document.getElementById('grid');
            gridEl.innerHTML = '';

            if (currentMode === 'hard') {
                gridEl.style.gridTemplateColumns = 'repeat(3, 1fr)';
            } else {
                gridEl.style.gridTemplateColumns = 'repeat(2, 1fr)';
            }

            for (let i = 0; i < currentCount; i++) {
                const textObj = items[Math.floor(Math.random() * items.length)];
                const colorObj = items[Math.floor(Math.random() * items.length)];

                gameData.push({
                    text: textObj.text,
                    colorClass: colorObj.class,
                    colorName: colorObj.name
                });

                const card = document.createElement('div');
                card.className = `card ${colorObj.class}`;
                card.innerText = textObj.text;
                gridEl.appendChild(card);
            }

            // 2. 計算停留時間
            let memoryTime = 2000;
            if (currentMode === 'easy') memoryTime = 3000;
            if (currentMode === 'medium') memoryTime = 6000;
            if (currentMode === 'hard') memoryTime = 10000;

            setTimeout(() => {
                hideGridAndAsk();
            }, memoryTime);
        }

        function hideGridAndAsk() {
            const cards = document.querySelectorAll('.card');
            cards.forEach(card => {
                card.innerText = '?';
                card.className = 'card';
                card.style.color = '#DDD';
            });

            generateQuestion();
        }

        function generateQuestion() {
            const type = Math.random() > 0.5 ? 'color' : 'text';
            const targetItem = items[Math.floor(Math.random() * items.length)];
            const qContent = document.getElementById('question-content');

            let questionHtml = '';
            correctAnswer = 0;

            if (type === 'color') {
                // 顯示圓形色塊，無陰影
                const hexColor = getColorCode(targetItem.class);
                questionHtml = `字體顏色是 <span class="q-color-dot" style="background-color:${hexColor}"></span>`;
                correctAnswer = gameData.filter(d => d.colorName === targetItem.name).length;
            } else {
                // 文字內容
                questionHtml = `<span class="q-content-text">文字內容是 「${targetItem.text}」</span>`;
                correctAnswer = gameData.filter(d => d.text === targetItem.text).length;
            }

            qContent.innerHTML = questionHtml;
            document.getElementById('question-box').style.display = 'block';

            // 生成鍵盤
            const numpadContainer = document.getElementById('numpad-container');
            numpadContainer.innerHTML = '';

            if (currentMode === 'hard') {
                const row1 = document.createElement('div');
                row1.className = 'numpad-row';
                for (let i = 0; i <= 4; i++) row1.appendChild(createNumBtn(i));

                const row2 = document.createElement('div');
                row2.className = 'numpad-row';
                for (let i = 5; i <= 9; i++) row2.appendChild(createNumBtn(i));

                numpadContainer.appendChild(row1);
                numpadContainer.appendChild(row2);

            } else {
                const row = document.createElement('div');
                row.className = 'numpad-row';
                row.style.flexWrap = 'wrap';
                for (let i = 0; i <= currentCount; i++) row.appendChild(createNumBtn(i));
                numpadContainer.appendChild(row);
            }

            // 3. 處理計時模式
            const isTimerMode = document.getElementById('timer-mode-check').checked;
            if (isTimerMode) {
                startTimer();
            }
        }

        function createNumBtn(num) {
            const btn = document.createElement('button');
            btn.className = 'num-btn';
            btn.innerText = num;
            btn.onclick = () => checkAnswer(num);
            return btn;
        }

        function startTimer() {
            const barContainer = document.getElementById('timer-bar-container');
            const fill = document.getElementById('timer-bar-fill');

            barContainer.style.display = 'block';
            fill.style.animation = 'none';
            fill.offsetHeight;
            // 8秒計時
            fill.style.animation = 'timerShrink 8s linear forwards';

            timerId = setTimeout(() => {
                checkAnswer(-1); // 傳入 -1 代表超時
            }, 8000);
        }

        function checkAnswer(userAns) {
            if (timerId) clearTimeout(timerId);
            const fill = document.getElementById('timer-bar-fill');
            fill.style.animationPlayState = 'paused';

            let isSuccess = false;
            let msg = '';

            if (userAns === -1) {
                isSuccess = false;
                msg = '時間到！反應太慢囉！';
                updateStreak(0, true);
            } else if (userAns === correctAnswer) {
                isSuccess = true;
                msg = '答對了！記憶力超強！';
                updateStreak(1);
            } else {
                isSuccess = false;
                msg = `答錯囉，正確是 ${correctAnswer} 個`;
                updateStreak(0, true);
            }

            showResult(isSuccess, msg);
        }

        function showResult(isSuccess, msg) {
            const overlay = document.getElementById('result-overlay');
            const icon = document.getElementById('result-icon');
            const text = document.getElementById('result-text');

            icon.innerText = isSuccess ? '😎' : '😵';
            text.innerText = msg;
            text.style.color = isSuccess ? 'var(--primary-blue)' : '#E63946';

            overlay.style.display = 'flex';
        }

        function getColorCode(className) {
            switch (className) {
                case 'c-red': return '#E63946';
                case 'c-green': return '#2A9D8F';
                case 'c-blue': return '#53B4FF';
                case 'c-yellow': return '#F4A261';
                case 'c-black': return '#333333';
                default: return '#000';
            }
        }

        // 初始化
        updateStreak(0, true);
