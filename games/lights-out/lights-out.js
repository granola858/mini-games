const board = document.getElementById('board');
    const modeBtns = document.querySelectorAll('.mode-btn');
    const moveDisplay = document.getElementById('moveCount');
    const winPopup = document.getElementById('winPopup');
    const finalMovesDisplay = document.getElementById('finalMoves');
    const restartBtn = document.getElementById('restartBtn');

    let size = 4;
    let grid = [];
    let moves = 0;
    let isGameActive = true;

    // 初始化遊戲 (Initialize Game)
    function initGame(newSize) {
      size = newSize;
      moves = 0;
      isGameActive = true;
      moveDisplay.innerText = moves;
      winPopup.classList.remove('show');

      board.style.setProperty('--grid-size', size);
      board.innerHTML = '';
      grid = [];

      for (let r = 0; r < size; r++) {
        let row = [];
        for (let c = 0; c < size; c++) {
          row.push(false);
          const card = document.createElement('div');
          card.className = 'card';
          card.addEventListener('click', () => handleCardClick(r, c));
          board.appendChild(card);
        }
        grid.push(row);
      }

      const shuffleCount = size * size * 2;
      for (let i = 0; i < shuffleCount; i++) {
        if (Math.random() > 0.5) {
          toggleCell(Math.floor(Math.random() * size), Math.floor(Math.random() * size), false);
        }
      }
      updateUI();
    }

    // 處理點擊事件 (Event Handler)
    function handleCardClick(r, c) {
      if (!isGameActive) return;
      moves++;
      moveDisplay.innerText = moves;
      toggleCell(r, c, true);
    }

    // 切換狀態邏輯 (Toggle Logic)
    function toggleCell(r, c, checkWinCondition = true) {
      const toggle = (row, col) => {
        if (row >= 0 && row < size && col >= 0 && col < size) {
          grid[row][col] = !grid[row][col];
        }
      };

      toggle(r, c);
      toggle(r - 1, c);
      toggle(r + 1, c);
      toggle(r, c - 1);
      toggle(r, c + 1);

      if (checkWinCondition) {
        updateUI();
        checkWin();
      }
    }

    // 更新畫面 (Render)
    function updateUI() {
      const cards = board.children;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const index = r * size + c;
          if (grid[r][c]) {
            cards[index].classList.add('active');
          } else {
            cards[index].classList.remove('active');
          }
        }
      }
    }

    // 檢查勝利條件 (Win Condition)
    function checkWin() {
      const isWin = grid.every(row => row.every(cell => !cell));
      if (isWin) {
        isGameActive = false;
        setTimeout(() => {
          finalMovesDisplay.innerText = moves;
          winPopup.classList.add('show');
        }, 300);
      }
    }

    // 綁定難度按鈕事件 (Bind Button Events)
    modeBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        modeBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        initGame(parseInt(e.target.dataset.size));
      });
    });

    // 綁定重新開始按鈕 (Bind Restart Event)
    restartBtn.addEventListener('click', () => {
      initGame(size);
    });

    // 啟動預設遊戲 (Start Default Game)
    initGame(size);
