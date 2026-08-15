const zhuyin = ["ㄅ", "ㄆ", "ㄇ", "ㄈ", "ㄉ", "ㄊ", "ㄋ", "ㄌ", "ㄍ", "ㄎ", "ㄏ", "ㄐ", "ㄑ", "ㄒ", "ㄓ", "ㄔ", "ㄕ", "ㄖ", "ㄗ", "ㄘ", "ㄙ", "ㄧ", "ㄨ", "ㄩ", "ㄚ", "ㄦ"];
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

        const categories = [
            "動物", "食物", "水果", "交通工具",
            "地點", "身體部位", "生活用品", "職業",
            "卡通人物", "動作", "形容詞"
        ];

        let currentLang = 'zh'; // 'zh' or 'en'
        let isDoubleMode = false;
        let currentResult = { s1: "", s2: "", cat: "" };
        let isRolling = false;

        function setLang(lang) {
            currentLang = lang;

            // UI 更新
            document.getElementById('btn-zh').className = lang === 'zh' ? 'mode-btn active' : 'mode-btn';
            document.getElementById('btn-en').className = lang === 'en' ? 'mode-btn active' : 'mode-btn';

            // 處理雙注音開關狀態
            const doubleContainer = document.getElementById('doubleModeContainer');
            const doubleToggle = document.getElementById('doubleModeToggle');

            if (lang === 'en') {
                // English模式：如果有開啟雙注音，先強制關閉，再隱藏UI
                if (isDoubleMode) {
                    doubleToggle.checked = false;
                    toggleDoubleMode();
                }
                // 完全隱藏 Switch
                doubleContainer.style.display = 'none';
            } else {
                // 注音模式：顯示 Switch
                doubleContainer.style.display = 'flex';
            }

            resetDisplay();
        }

        function toggleDoubleMode() {
            const toggle = document.getElementById('doubleModeToggle');
            const gameContainer = document.getElementById('gameContainer');
            const symbolTitle = document.getElementById('symbolTitle');

            isDoubleMode = toggle.checked;

            if (isDoubleMode) {
                gameContainer.classList.add('double-mode-active');
                symbolTitle.innerText = "用這兩個字造詞/聯想";
            } else {
                gameContainer.classList.remove('double-mode-active');
                symbolTitle.innerText = "開頭是...";
            }

            resetDisplay();
        }

        function resetDisplay() {
            document.getElementById('symbolDisplay').innerText = "-";
            document.getElementById('categoryDisplay').innerText = "-";
            document.getElementById('hintSection').classList.remove('visible');
        }

        function startRoll() {
            if (isRolling) return;
            isRolling = true;

            const rollBtn = document.getElementById('rollBtn');
            const symbolDisplay = document.getElementById('symbolDisplay');
            const categoryDisplay = document.getElementById('categoryDisplay');
            const hintSec = document.getElementById('hintSection');

            hintSec.classList.remove('visible');
            rollBtn.classList.add('btn-animating');

            let counter = 0;
            const sourceArray = currentLang === 'en' ? alphabet : zhuyin;

            const interval = setInterval(() => {
                if (isDoubleMode) {
                    // 雙注音跳動
                    const r1 = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                    const r2 = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                    symbolDisplay.innerText = `${r1} ${r2}`;
                } else {
                    // 一般跳動
                    symbolDisplay.innerText = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                    categoryDisplay.innerText = categories[Math.floor(Math.random() * categories.length)];
                }

                counter++;
                if (counter > 12) {
                    clearInterval(interval);
                    finalizeResult(sourceArray);
                }
            }, 50);
        }

        function finalizeResult(sourceArray) {
            const rollBtn = document.getElementById('rollBtn');

            if (isDoubleMode) {
                currentResult.s1 = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                currentResult.s2 = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                currentResult.cat = null;

                document.getElementById('symbolDisplay').innerText = `${currentResult.s1}  ${currentResult.s2}`;
            } else {
                currentResult.s1 = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                currentResult.s2 = null;
                currentResult.cat = categories[Math.floor(Math.random() * categories.length)];

                document.getElementById('symbolDisplay').innerText = currentResult.s1;
                document.getElementById('categoryDisplay').innerText = currentResult.cat;

                const catEl = document.getElementById('categoryDisplay');
                catEl.style.fontSize = currentResult.cat.length > 3 ? "1.5rem" : "2rem";
            }

            rollBtn.classList.remove('btn-animating');
            isRolling = false;

            setTimeout(() => {
                document.getElementById('hintSection').classList.add('visible');
            }, 300);
        }

        function openHint() {
            let query = "";

            if (isDoubleMode) {
                query = `"${currentResult.s1}${currentResult.s2}" 造詞`;
            } else {
                if (currentLang === 'en') {
                    query = `${currentResult.cat} starts with ${currentResult.s1}`;
                } else {
                    query = `${currentResult.s1}開頭的${currentResult.cat}`;
                }
            }
            window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
        }
