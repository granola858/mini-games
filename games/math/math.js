let targetValue = 0;
        let targetLength = 5;
        let currentSteps = [];
        let currentMode = 'random'; // 預設隨機模式

        // 設定模式並重新開始
        function setMode(mode) {
            currentMode = mode;

            // 更新按鈕樣式
            document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
            if (mode === 'random') {
                document.getElementById('mode-random').classList.add('active');
            } else {
                document.getElementById(`mode-${mode}`).classList.add('active');
            }

            initGame();
        }

        function initGame() {
            resetState();

            // 核心修改：根據模式決定長度
            if (currentMode === 'random') {
                targetLength = Math.random() > 0.5 ? 5 : 3;
            } else {
                targetLength = currentMode;
            }

            renderSlots(targetLength);
            generateSolvableTarget(targetLength);
            updateButtonStates();
        }

        function renderSlots(count) {
            const container = document.getElementById('slotsArea');
            container.innerHTML = '';
            for (let i = 0; i < count; i++) {
                let div = document.createElement('div');
                div.className = 'slot';
                div.id = `slot-${i}`;
                container.appendChild(div);
            }
        }

        function generateSolvableTarget(length) {
            const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const ops = ['+', '-', '*', '/'];

            let valid = false;
            while (!valid) {
                const shuffledNums = [...nums].sort(() => 0.5 - Math.random());
                const shuffledOps = [...ops].sort(() => 0.5 - Math.random());

                let formulaParts = [];
                let currentNumIdx = 0;
                let currentOpIdx = 0;

                for (let i = 0; i < length; i++) {
                    if (i % 2 === 0) {
                        formulaParts.push(shuffledNums[currentNumIdx++]);
                    } else {
                        formulaParts.push(shuffledOps[currentOpIdx++]);
                    }
                }

                const formulaStr = formulaParts.join(' ');

                try {
                    const ans = new Function('return ' + formulaStr)();
                    if (Number.isInteger(ans) && ans > 0 && ans <= 100) {
                        targetValue = ans;
                        valid = true;
                        // console.log("答案:", formulaStr, "=", ans); 
                    }
                } catch (e) { }
            }

            document.getElementById('targetNum').innerText = targetValue;
            document.getElementById('targetNum').style.color = "#00b894";
        }

        function handleInput(val, btn) {
            if (currentSteps.length >= targetLength) return;

            currentSteps.push({ value: val, btn: btn });

            const slotIndex = currentSteps.length - 1;
            const slot = document.getElementById(`slot-${slotIndex}`);
            slot.innerText = (val === '*') ? '×' : (val === '/') ? '÷' : val;
            slot.classList.add('filled');

            if (currentSteps.length === targetLength) {
                checkResult();
            }

            updateButtonStates();
        }

        function undoLast() {
            if (currentSteps.length === 0) return;
            const lastStep = currentSteps.pop();
            const slot = document.getElementById(`slot-${currentSteps.length}`);
            slot.innerText = '';
            slot.classList.remove('filled');
            updateButtonStates();
            document.getElementById('targetNum').style.color = "#00b894";
        }

        function updateButtonStates() {
            const allNumBtns = document.querySelectorAll('.btn.num');
            const allOpBtns = document.querySelectorAll('.btn.op');
            const allBtns = [...allNumBtns, ...allOpBtns];

            allBtns.forEach(btn => {
                const isUsed = currentSteps.some(step => step.btn === btn);
                btn.disabled = isUsed;
            });

            const nextIsNumber = (currentSteps.length % 2 === 0);

            if (currentSteps.length < targetLength) {
                if (nextIsNumber) {
                    allOpBtns.forEach(btn => btn.disabled = true);
                } else {
                    allNumBtns.forEach(btn => btn.disabled = true);
                }
            } else {
                allBtns.forEach(btn => btn.disabled = true);
            }
        }

        function checkResult() {
            const formulaStr = currentSteps.map(s => s.value).join(' ');
            try {
                const result = new Function('return ' + formulaStr)();
                if (Math.abs(result - targetValue) < 0.001) {
                    showToast("🎉 太神啦！答對了！", "success");
                    document.getElementById('targetNum').style.color = "#00b894";
                } else {
                    showToast(`結果是 ${result} ... 再試試！`, "error");
                    document.getElementById('targetNum').style.color = "#ff7675";
                }
            } catch (e) {
                showToast("算式錯誤", "error");
            }
        }

        function showToast(msg, type) {
            const toast = document.getElementById('toast');
            toast.innerText = msg;
            toast.className = `message-toast show ${type}`;
            setTimeout(() => {
                toast.className = 'message-toast';
            }, 2000);
        }

        function resetState() {
            currentSteps = [];
            document.querySelectorAll('.slot').forEach(el => {
                el.innerText = '';
                el.className = 'slot';
            });
            document.querySelectorAll('.btn').forEach(btn => btn.disabled = false);
        }

        // 啟動
        initGame();
