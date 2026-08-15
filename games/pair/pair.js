// 遊戲設定
        const config = {
            easy: { rows: 5, cols: 4 },
            medium: { rows: 6, cols: 5 },
            hard: { rows: 7, cols: 6 }
        };

        // 圖形與顏色池
        const shapes = ['circle', 'rect', 'triangle', 'diamond', 'cross', 'star', 'hexagon'];
        const colors = ['#BA68C8', '#EF5350', '#42A5F5', '#66BB6A', '#FFA726', '#FF7043', '#8D6E63', '#78909C'];

        let currentLevel = 'easy';
        let cards = [];
        let flippedCards = [];
        let matchedPairs = 0;
        let moves = 0;
        let isLocked = false;

        const gameContainer = document.getElementById('game-container');
        const moveDisplay = document.getElementById('moves');
        const pairDisplay = document.getElementById('pairs');
        const modal = document.getElementById('victory-modal');

        function generateCardContent(totalPairs) {
            let deck = [];
            let shapeIndex = 0;
            let colorIndex = 0;

            for (let i = 0; i < totalPairs; i++) {
                const shape = shapes[shapeIndex % shapes.length];
                const color = colors[colorIndex % colors.length];

                shapeIndex++;
                if (shapeIndex % shapes.length === 0) colorIndex++;

                const cardData = { shape, color, id: i };
                deck.push(cardData, cardData);
            }

            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }
            return deck;
        }

        function getSvgIcon(type, color) {
            let path = '';
            switch (type) {
                case 'circle': path = '<circle cx="50" cy="50" r="40" />'; break;
                case 'rect': path = '<rect x="15" y="15" width="70" height="70" rx="10" />'; break;
                case 'triangle': path = '<polygon points="50,15 90,85 10,85" />'; break;
                case 'diamond': path = '<polygon points="50,10 90,50 50,90 10,50" />'; break;
                case 'cross': path = '<path d="M20,20 L80,80 M80,20 L20,80" stroke-width="15" stroke-linecap="round" />'; break;
                case 'star': path = '<polygon points="50,10 61,35 90,35 66,55 75,85 50,65 25,85 34,55 10,35 39,35" />'; break;
                case 'hexagon': path = '<polygon points="50,10 85,30 85,70 50,90 15,70 15,30" />'; break;
            }
            const attr = type === 'cross' ? `stroke="${color}" fill="none"` : `fill="${color}"`;
            return `<svg viewBox="0 0 100 100" class="shape-svg" ${attr}>${path}</svg>`;
        }

        function startGame(level) {
            currentLevel = level;

            // 更新按鈕狀態
            document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById(`btn-${level}`).classList.add('active');

            // 重置數據
            matchedPairs = 0;
            moves = 0;
            flippedCards = [];
            isLocked = false;
            moveDisplay.textContent = `步數: ${moves}`;
            pairDisplay.textContent = `配對: ${matchedPairs}`;
            modal.classList.remove('show');

            // 設定 Grid
            const rows = config[level].rows;
            const cols = config[level].cols;
            gameContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

            // 生成卡片
            const totalCards = rows * cols;
            const deckData = generateCardContent(totalCards / 2);
            gameContainer.innerHTML = '';

            deckData.forEach((data, index) => {
                const card = document.createElement('div');
                card.classList.add('card');
                card.dataset.id = data.id;

                const front = document.createElement('div');
                front.classList.add('card-face', 'front');

                const back = document.createElement('div');
                back.classList.add('card-face', 'back');
                back.innerHTML = getSvgIcon(data.shape, data.color);

                card.appendChild(front);
                card.appendChild(back);

                card.addEventListener('click', () => flipCard(card));
                gameContainer.appendChild(card);
            });
        }

        function flipCard(card) {
            if (isLocked) return;
            if (card.classList.contains('flipped')) return;

            card.classList.add('flipped');
            flippedCards.push(card);

            if (flippedCards.length === 2) {
                moves++;
                moveDisplay.textContent = `步數: ${moves}`;
                checkForMatch();
            }
        }

        function checkForMatch() {
            isLocked = true;
            const [card1, card2] = flippedCards;

            if (card1.dataset.id === card2.dataset.id) {
                disableCards();
            } else {
                unflipCards();
            }
        }

        function disableCards() {
            flippedCards.forEach(card => card.classList.add('matched'));
            matchedPairs++;
            pairDisplay.textContent = `配對: ${matchedPairs}`;
            flippedCards = [];
            isLocked = false;

            const totalPairs = (config[currentLevel].rows * config[currentLevel].cols) / 2;
            if (matchedPairs === totalPairs) {
                setTimeout(() => {
                    document.getElementById('final-score').textContent = `總步數: ${moves}`;
                    modal.classList.add('show');
                }, 500);
            }
        }

        function unflipCards() {
            setTimeout(() => {
                flippedCards.forEach(card => card.classList.remove('flipped'));
                flippedCards = [];
                isLocked = false;
            }, 800);
        }

        function restartCurrentLevel() {
            startGame(currentLevel);
        }

        // 初始化
        startGame('easy');
