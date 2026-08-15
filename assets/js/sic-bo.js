let balance = 1000;
        let currentChip = 10;
        let totalBetAmount = 0;
        let currentBets = [];
        let lastBets = [];
        let history = [];
        let isRolling = false;

        const diceFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

        function selectChip(amount, el) {
            if (isRolling) return;
            currentChip = amount;
            document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
            el.classList.add('selected');
        }

        function placeBet(type, value, multiplier, btn, amountOverride = null) {
            if (isRolling) return;
            let betAmount = amountOverride || currentChip;

            if (balance < betAmount) {
                alert('餘額不足！');
                return;
            }

            let existingBet = currentBets.find(b => b.type === type && b.value === value);
            if (existingBet) {
                existingBet.amount += betAmount;
            } else {
                currentBets.push({ type, value, multiplier, amount: betAmount, element: btn });
                btn.classList.add('active');
            }

            balance -= betAmount;
            totalBetAmount += betAmount;
            updateBetBadge(btn, existingBet ? existingBet.amount : betAmount);
            updateUI();
        }

        function updateBetBadge(btn, totalAmount) {
            let badge = btn.querySelector('.bet-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'bet-badge';
                btn.appendChild(badge);
            }
            badge.innerText = totalAmount;
        }

        function clearBets() {
            if (isRolling) return;
            currentBets.forEach(bet => {
                bet.element.classList.remove('active');
                const badge = bet.element.querySelector('.bet-badge');
                if (badge) badge.remove();
            });
            balance += totalBetAmount;
            currentBets = [];
            totalBetAmount = 0;
            updateUI();
        }

        function rebet() {
            if (isRolling) return;
            if (lastBets.length === 0) {
                alert('沒有上一局的下注紀錄！');
                return;
            }

            let neededBalance = lastBets.reduce((sum, bet) => sum + bet.amount, 0);
            if (balance + totalBetAmount < neededBalance) {
                alert('餘額不足以重複上局下注！');
                return;
            }

            clearBets();
            lastBets.forEach(bet => {
                placeBet(bet.type, bet.value, bet.multiplier, bet.element, bet.amount);
            });
        }

        function rollDice() {
            if (isRolling) return;
            if (currentBets.length === 0) {
                alert('請先下注！');
                return;
            }

            isRolling = true;
            document.getElementById('rollBtn').disabled = true;

            const msgEl = document.getElementById('resultMsg');
            msgEl.innerText = "骰子轉動中...";
            msgEl.className = "result-msg lose-text";

            lastBets = currentBets.map(b => ({ ...b }));
            let betThisRound = totalBetAmount;

            const diceDivs = document.querySelectorAll('#diceContainer .dice');
            diceDivs.forEach(d => d.classList.add('rolling'));

            let rollInterval = setInterval(() => {
                diceDivs[0].innerText = diceFaces[Math.floor(Math.random() * 6)];
                diceDivs[1].innerText = diceFaces[Math.floor(Math.random() * 6)];
                diceDivs[2].innerText = diceFaces[Math.floor(Math.random() * 6)];
            }, 100);

            setTimeout(() => {
                clearInterval(rollInterval);
                diceDivs.forEach(d => d.classList.remove('rolling'));

                const d1 = Math.floor(Math.random() * 6) + 1;
                const d2 = Math.floor(Math.random() * 6) + 1;
                const d3 = Math.floor(Math.random() * 6) + 1;
                const dice = [d1, d2, d3];
                const sum = d1 + d2 + d3;

                diceDivs[0].innerText = diceFaces[d1 - 1];
                diceDivs[1].innerText = diceFaces[d2 - 1];
                diceDivs[2].innerText = diceFaces[d3 - 1];

                calculateWin(dice, sum, betThisRound);
                resetRound();
                isRolling = false;
                document.getElementById('rollBtn').disabled = false;
            }, 1200);
        }

        function calculateWin(dice, sum, betThisRound) {
            let totalWin = 0;
            const diceCounts = {};
            dice.forEach(d => { diceCounts[d] = (diceCounts[d] || 0) + 1; });
            const isTriple = Object.values(diceCounts).includes(3);

            currentBets.forEach(bet => {
                let winAmount = 0;
                let betAmount = bet.amount;

                switch (bet.type) {
                    case 'bs':
                        if (!isTriple) {
                            if (bet.value === 'small' && sum >= 4 && sum <= 10) winAmount = betAmount * bet.multiplier;
                            if (bet.value === 'big' && sum >= 11 && sum <= 17) winAmount = betAmount * bet.multiplier;
                        }
                        break;
                    case 'triple_any':
                        if (isTriple) winAmount = betAmount * bet.multiplier;
                        break;
                    case 'sum':
                        if (sum === bet.value) winAmount = betAmount * bet.multiplier;
                        break;
                    case 'single':
                        if (diceCounts[bet.value]) winAmount = betAmount * diceCounts[bet.value];
                        break;
                    case 'double':
                        if (diceCounts[bet.value] >= 2) winAmount = betAmount * bet.multiplier;
                        break;
                }

                if (winAmount > 0) totalWin += (winAmount + betAmount);
            });

            balance += totalWin;

            let netProfit = totalWin - betThisRound;
            const msgEl = document.getElementById('resultMsg');

            if (netProfit > 0) {
                msgEl.innerText = `中獎！贏了 ${netProfit} 分`;
                msgEl.className = "result-msg win-text";
            } else if (netProfit < 0) {
                msgEl.innerText = `未中獎，輸了 ${Math.abs(netProfit)} 分`;
                msgEl.className = "result-msg lose-text";
            } else {
                msgEl.innerText = `打平，不輸不贏`;
                msgEl.className = "result-msg";
            }

            updateHistory(dice, sum, netProfit);
        }

        function resetRound() {
            currentBets.forEach(bet => {
                bet.element.classList.remove('active');
                const badge = bet.element.querySelector('.bet-badge');
                if (badge) badge.remove();
            });
            currentBets = [];
            totalBetAmount = 0;
            updateUI();
        }

        function updateHistory(dice, sum, netProfit) {
            const isTriple = (dice[0] === dice[1] && dice[1] === dice[2]);
            const bs = isTriple ? '圍骰' : ((sum >= 4 && sum <= 10) ? '小' : '大');

            let profitStr = netProfit >= 0 ? `<span class="win-text">+${netProfit}</span>` : `<span class="lose-text">${netProfit}</span>`;

            let li = `<div class="history-item ${netProfit >= 0 ? 'win' : 'lose'}">
                        <span>[${dice.join(', ')}] ${sum} (${bs})</span>
                        <span>${profitStr}</span>
                      </div>`;

            history.unshift(li);
            if (history.length > 50) history.pop();

            document.getElementById('historyBox').innerHTML = history.join('');
        }

        function updateUI() {
            document.getElementById('balance').innerText = balance;
            document.getElementById('totalBet').innerText = totalBetAmount;
        }
