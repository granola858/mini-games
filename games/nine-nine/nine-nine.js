(() => {
  'use strict';

  const Core = typeof NineNineCore !== 'undefined' ? NineNineCore : null;
  if (!Core) throw new Error('NineNineCore is required');

  const SAVE_KEY = 'nine_nine_save_v1';
  const PREF_KEY = 'nine_nine_pref_v1';
  const STATS_KEY = 'nine_nine_stats_v1';
  const $ = id => document.getElementById(id);
  const elements = {
    setup: $('setup-panel'),
    game: $('game-panel'),
    playerCount: $('player-count'),
    handSize: $('hand-size'),
    difficulty: $('difficulty'),
    start: $('start-button'),
    resume: $('resume-button'),
    storageNotice: $('storage-notice'),
    status: $('status-line'),
    record: $('record-chip'),
    turnTitle: $('turn-title'),
    players: $('players-list'),
    value: $('current-value'),
    fill: $('score-fill'),
    caption: $('score-caption'),
    history: $('play-history'),
    deckCount: $('deck-count'),
    handPanel: $('hand-panel'),
    turnHint: $('turn-hint'),
    hand: $('hand'),
    options: $('move-options'),
    result: $('result-panel'),
    resultTitle: $('result-title'),
    resultCopy: $('result-copy')
  };

  let game = null;
  let savedMatchId = null;
  let stats = Core.emptyStats();
  let selectedMoves = [];
  let aiTimer = null;
  let thinking = false;
  let lastShownValue = null; // 上一次畫出來的海中點數，用來判斷要不要強調變化

  const reduceMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function storageWarning(message) {
    elements.storageNotice.textContent = message;
    elements.storageNotice.hidden = false;
  }

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ok: true, value: JSON.parse(raw) } : { ok: true, value: null };
    } catch (error) {
      storageWarning('無法讀取本機資料，設定和對局可能無法接續。請檢查瀏覽器儲存權限。');
      return { ok: false, value: null };
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      storageWarning('瀏覽器未允許本機儲存；設定、戰績或這局牌面可能無法保留。');
      return false;
    }
  }

  function settingsFromForm() {
    return Core.normalizePreferences({
      playerCount: Number(elements.playerCount.value),
      handSize: Number(elements.handSize.value),
      difficulty: elements.difficulty.value
    });
  }

  function saveSettings() {
    const settings = settingsFromForm();
    writeJson(PREF_KEY, settings);
  }

  function readSavedGame() {
    const saved = readJson(SAVE_KEY);
    if (!saved.value) return;
    if (!saved.ok || typeof saved.value !== 'object') return;
    const normalized = Core.normalizeGame(saved.value.game);
    if (!normalized) {
      storageWarning('找到的牌局存檔無效或已過期，請開始新局。');
      return;
    }
    savedMatchId = typeof saved.value.recordedMatchId === 'string'
      ? saved.value.recordedMatchId : null;
    elements.resume.hidden = normalized.status !== 'active';
  }

  function saveGame() {
    if (!game) return;
    writeJson(SAVE_KEY, { game, recordedMatchId: savedMatchId });
  }

  function saveStats() {
    writeJson(STATS_KEY, stats);
    renderStats();
  }

  function renderStats() {
    elements.record.textContent = '勝 ' + stats.wins + ' · 敗 ' + stats.losses;
  }

  function recordResult() {
    if (!game || game.status !== 'finished' || savedMatchId === game.matchId) return;
    const previousBestStreak = stats.bestWinStreak;
    stats.games += 1;
    if (game.winnerId === 'p0') {
      stats.wins += 1;
      stats.currentWinStreak += 1;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    } else {
      stats.losses += 1;
      stats.currentWinStreak = 0;
    }
    savedMatchId = game.matchId;
    saveStats();
    // 讓最後一張牌先落到桌上，再跳出過關卡片
    const finished = game;
    setTimeout(() => showResultCard(finished, previousBestStreak), reduceMotion() ? 150 : 520);
  }

  // 過關卡片上的「最後一張牌」：讓玩家記得這局是怎麼結束的
  function finalCardElement(action) {
    if (!action || !action.card) return null;
    const card = action.card;
    const el = document.createElement('div');
    el.className = 'final-card' + (isRed(card) ? ' red' : '');
    const family = cardFamily(card);
    if (family) el.dataset.family = family;
    const owner = Core.getPlayer(game, action.playerId);
    const caption = document.createElement('span');
    caption.className = 'final-caption';
    caption.textContent = (owner ? owner.name : '玩家') + '的最後一張';
    const face = document.createElement('strong');
    face.className = 'final-face';
    face.textContent = getCardLabel(card);
    const effect = document.createElement('span');
    effect.className = 'final-effect';
    effect.textContent = '點數 → ' + action.value + (action.busted ? '（爆點）' : '');
    el.append(caption, face, effect);
    return el;
  }

  function showResultCard(finished, previousBestStreak) {
    if (typeof BoboCelebrate === 'undefined' || !finished || game !== finished) return;
    const winner = finished.winnerId ? Core.getPlayer(finished, finished.winnerId) : null;
    const won = finished.winnerId === 'p0';
    const streakRecord = won && stats.currentWinStreak > 1 && stats.currentWinStreak > previousBestStreak;
    BoboCelebrate.show({
      outcome: won ? 'win' : 'lose',
      gameName: '九九',
      title: won ? '你贏了！' : (winner ? winner.name + ' 獲勝' : '本局結束'),
      subtitle: won
        ? '撐到最後！海中點數停在 ' + finished.currentValue + '。'
        : '這局由 ' + (winner ? winner.name : '對手') + ' 撐到最後。換個出牌順序，再挑戰一次！',
      stats: won
        ? [
            { label: '目前連勝', value: stats.currentWinStreak + ' 場', isBest: streakRecord },
            { label: '勝場', value: stats.wins },
            { label: '總對局', value: stats.games }
          ]
        : [
            { label: '勝場', value: stats.wins },
            { label: '敗場', value: stats.losses },
            { label: '最佳連勝', value: stats.bestWinStreak + ' 場' }
          ],
      bestLabel: '新的連勝紀錄',
      extra: finalCardElement(finished.lastAction),
      accent: '#197148',
      accentDark: '#46c27c',
      returnFocus: $('play-again-button'),
      primary: { label: '再玩一局', onClick: () => startGame(true) },
      secondary: { label: '看牌桌' }
    });
  }

  const isRed = card => card.suit === 'hearts' || card.suit === 'diamonds';

  // 功能牌分三族：turn＝改變出牌順序、adjust＝加減點、extreme＝一口氣改變點數
  function cardFamily(card) {
    if (!card) return '';
    if (card.id === 'spades-A' || card.rank === 'K') return 'extreme';
    if (card.rank === '4' || card.rank === '5' || card.rank === 'J') return 'turn';
    if (card.rank === '10' || card.rank === 'Q') return 'adjust';
    return '';
  }

  function getCardLabel(card) {
    const suits = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
    return card.rank + suits[card.suit];
  }

  function actionDescription(action) {
    if (!action) return '尚未出牌';
    const player = Core.getPlayer(game, action.playerId);
    const label = getCardLabel(action.card);
    let effect = '';
    switch (action.card.rank) {
      case 'A': effect = action.choice === 'zero' ? '歸零' : '加 1'; break;
      case '4': effect = '反轉方向'; break;
      case '5': effect = '指定 ' + (Core.getPlayer(game, action.targetId)?.name || '玩家'); break;
      case 'J': effect = '跳過下一位'; break;
      case 'K': effect = '點數加到 99'; break;
      case '10': case 'Q':
        effect = (action.choice === 'minus' ? '減' : '加')
          + (action.card.rank === '10' ? '10' : '20');
        break;
      default:
        effect = '加 ' + (action.card.rank === 'A' ? '1' : action.card.rank);
    }
    return (player ? player.name : '玩家') + ' 出了 ' + label + ' · ' + effect
      + (action.busted ? '，爆點淘汰' : '');
  }

  function turnDescription() {
    if (game.lastAction?.busted) return actionDescription(game.lastAction);
    const eliminated = game.lastEliminatedIds.map(id => Core.getPlayer(game, id).name);
    return eliminated.length
      ? eliminated.join('、') + ' 無牌可出，已淘汰'
      : actionDescription(game.lastAction);
  }

  function renderHistory() {
    const placeholders = Array.from({ length: 5 - game.history.length }, () =>
      '<li class="history-empty" aria-label="尚無出牌"><span aria-hidden="true">—</span></li>');
    const cards = game.history.map((action, index) => {
      const owner = Core.getPlayer(game, action.playerId);
      const latest = index === game.history.length - 1;
      const red = ['hearts', 'diamonds'].includes(action.card.suit);
      const family = cardFamily(action.card);
      return '<li class="history-card' + (latest ? ' is-latest' : '') + '"'
        + (family ? ' data-family="' + family + '"' : '') + ' aria-label="'
        + escapeHtml(actionDescription(action) + '，點數 ' + action.value + (latest ? '，最新' : '')) + '">'
        + '<span class="history-owner">' + escapeHtml(owner.name) + '</span>'
        + '<strong class="history-face' + (red ? ' red' : '') + '">' + getCardLabel(action.card) + '</strong>'
        + '<span class="history-value">→ ' + action.value + (action.busted ? ' 爆點' : '') + '</span></li>';
    });
    elements.history.innerHTML = [...placeholders, ...cards].join('');
  }

  function renderPlayers() {
    const current = Core.getCurrentPlayer(game);
    const directionLabel = game.direction === 1 ? '順時針' : '逆時針';
    elements.players.style.setProperty('--player-count', game.playerCount);
    elements.players.innerHTML = game.players.map(player => {
      const classes = ['player-tile'];
      if (player.id === game.currentPlayerId && game.status === 'active') classes.push('is-current');
      if (!player.alive) classes.push('is-out');
      const marker = player.id === game.currentPlayerId && game.status === 'active'
        ? '<span class="turn-dot" aria-hidden="true"></span>' : '';
      const status = !player.alive
        ? '已淘汰'
        : player.id === game.winnerId ? '獲勝' : player.hand.length + ' 張手牌';
      return '<div class="' + classes.join(' ') + '" aria-label="'
        + escapeHtml(player.name + (player.alive ? '，' + status : '，已淘汰')) + '">'
        + '<span class="player-name">' + marker + escapeHtml(player.name) + '</span>'
        + '<span class="player-meta">' + escapeHtml(status) + '</span></div>';
    }).join('');
    if (game.status === 'finished') {
      const winner = game.winnerId ? Core.getPlayer(game, game.winnerId) : null;
      elements.turnTitle.textContent = winner ? '本局結束 · ' + winner.name + ' 獲勝' : '本局結束';
    } else {
      elements.turnTitle.textContent = thinking && current && !current.human
        ? current.name + ' 思考中… · ' + directionLabel
        : current
          ? (current.human ? '輪到你出牌' : '輪到 ' + current.name) + ' · ' + directionLabel
          : '本局結束';
    }
  }

  // 功能牌的效果標籤：牌面直接寫出它會做什麼，不必背規則
  function cardEffect(card) {
    if (card.id === 'spades-A') return '歸零/+1';
    switch (card.rank) {
      case '4': return '↺ 迴轉';
      case '5': return '指定';
      case '10': return '±10';
      case 'J': return '跳過';
      case 'Q': return '±20';
      case 'K': return '→99';
      default: return '';
    }
  }

  function renderHand() {
    const player = Core.getPlayer(game, 'p0');
    const humanTurn = game.status === 'active' && game.currentPlayerId === 'p0' && !thinking;
    if (!player) return;
    const safeMoves = humanTurn ? Core.getSafeMoves(game) : [];
    elements.hand.style.setProperty('--hand-size', game.handSize);
    const suitGlyph = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
    elements.hand.innerHTML = player.hand.map(card => {
      const red = card.suit === 'hearts' || card.suit === 'diamonds';
      const selected = selectedMoves.some(move => move.cardId === card.id);
      const safe = safeMoves.some(move => move.cardId === card.id);
      const blocked = humanTurn && !safe;
      const effect = cardEffect(card);
      const family = cardFamily(card);
      return '<button class="playing-card' + (red ? ' red' : '') + (selected ? ' selected' : '')
        + '" type="button" data-card-id="' + card.id + '"' + (family ? ' data-family="' + family + '"' : '')
        + ' aria-label="出 ' + card.rank
        + suitGlyph[card.suit] + (effect ? '，' + effect : '') + (blocked ? '，出牌會爆點淘汰' : '') + '" '
        + (humanTurn ? '' : 'disabled') + '>'
        + '<span class="rank">' + card.rank + '</span><span class="suit" aria-hidden="true">'
        + suitGlyph[card.suit] + '</span>'
        + (effect && !blocked ? '<span class="card-effect" aria-hidden="true">' + effect + '</span>' : '')
        + (blocked ? '<span class="card-warning">會爆點</span>' : '') + '</button>';
    }).join('');
    elements.turnHint.textContent = !player.alive
      ? '你已淘汰，電腦繼續對局'
      : thinking
      ? '電腦正在思考…'
      : humanTurn ? '點選一張手牌出牌' : game.status === 'active' ? '請稍候' : '對局已結束';
  }

  function renderOptions() {
    if (!selectedMoves.length) {
      elements.options.hidden = true;
      elements.options.replaceChildren();
      return;
    }
    elements.options.hidden = false;
    const card = Core.getPlayer(game, 'p0').hand.find(item => item.id === selectedMoves[0].cardId);
    if (card.id === 'spades-A') {
      elements.options.innerHTML = selectedMoves.map((move, index) => {
        const value = move.choice === 'zero' ? 0 : game.currentValue + 1;
        const label = move.choice === 'zero' ? '歸零 → 0' : '+1 → ' + value + (value > 99 ? ' · 爆點' : '');
        return '<button type="button" data-move-index="' + index + '">' + label + '</button>';
      }).join('');
      return;
    }
    if (card.rank === '10' || card.rank === 'Q') {
      const amount = card.rank === '10' ? 10 : 20;
      elements.options.innerHTML = ['plus', 'minus'].map(choice => {
        const index = selectedMoves.findIndex(move => move.choice === choice);
        const value = game.currentValue + (choice === 'plus' ? amount : -amount);
        const label = (choice === 'plus' ? '+' : '−') + amount
          + (index < 0 ? ' · 爆點' : ' → ' + value);
        return '<button type="button" data-move-index="' + index + '"'
          + (index < 0 ? ' disabled' : '') + '>' + label + '</button>';
      }).join('');
      return;
    }
    elements.options.innerHTML = selectedMoves.map((move, index) => {
      let label = '出牌';
      if (move.choice) label = move.choice === 'plus' ? '加點' : '減點';
      if (move.targetId) {
        const target = Core.getPlayer(game, move.targetId);
        label = '指定 ' + (target ? target.name : '玩家');
      }
      return '<button type="button" data-move-index="' + index + '">' + escapeHtml(label) + '</button>';
    }).join('');
  }

  function renderScore() {
    const value = game.currentValue;
    elements.value.textContent = String(value);
    elements.fill.style.width = Math.max(0, Math.min(100, value / 99 * 100)) + '%';
    const danger = value >= 85;
    const warn = !danger && value >= 70;
    elements.fill.classList.toggle('is-danger', danger);
    elements.fill.classList.toggle('is-warn', warn);
    elements.value.classList.toggle('is-danger', danger);
    elements.value.classList.toggle('is-warn', warn);
    // 點數真的變了才強調（第一次畫面、重繪同一個數字都不動）
    if (lastShownValue !== null && lastShownValue !== value) {
      elements.value.classList.remove('is-bumped');
      void elements.value.offsetWidth; // 重新觸發動畫
      elements.value.classList.add('is-bumped');
    }
    lastShownValue = value;
    elements.caption.textContent = game.currentValue < 0
      ? '目前低於 0 點 ' + Math.abs(game.currentValue) + ' 點'
      : '距離 99 還有 ' + Math.max(0, 99 - game.currentValue) + ' 點';
    elements.deckCount.textContent = String(game.drawPile.length);
  }

  function renderResult() {
    const finished = game.status === 'finished';
    elements.result.hidden = !finished;
    elements.handPanel.hidden = finished;
    if (!finished) return;
    const winner = game.winnerId ? Core.getPlayer(game, game.winnerId) : null;
    elements.resultTitle.textContent = winner
      ? winner.id === 'p0' ? '你贏了！' : winner.name + ' 獲勝'
      : '本局結束';
    elements.resultCopy.textContent = winner
      ? '恭喜 ' + winner.name + ' 撐到最後，海中點數是 ' + game.currentValue + '。'
      : '所有玩家都已淘汰。';
  }

  function render() {
    if (!game) return;
    document.body.classList.add('is-playing');
    elements.setup.hidden = true;
    elements.game.hidden = false;
    renderPlayers();
    renderHand();
    renderOptions();
    renderScore();
    renderHistory();
    renderResult();
    if (game.status === 'finished') recordResult();
    saveGame();
    scheduleComputerTurn();
  }

  function clearAiTurn() {
    if (aiTimer !== null) {
      clearTimeout(aiTimer);
      aiTimer = null;
    }
    thinking = false;
  }

  function scheduleComputerTurn() {
    if (!game || game.status !== 'active') return;
    const player = Core.getCurrentPlayer(game);
    if (!player || player.human || aiTimer !== null) return;
    thinking = true;
    renderPlayers();
    renderHand();
    aiTimer = setTimeout(() => {
      aiTimer = null;
      if (!game || game.status !== 'active') return;
      const current = Core.getCurrentPlayer(game);
      if (!current || current.human) return;
      try {
        const move = Core.chooseMove(game, game.difficulty);
        if (!move) throw new Error('Computer has no legal move');
        const seatIndex = game.players.findIndex(p => p.id === current.id);
        const seat = elements.players.children[seatIndex];
        const fromRect = seat ? seat.getBoundingClientRect() : null;
        game = Core.applyMove(game, move);
        thinking = false;
        selectedMoves = [];
        if (game.status === 'finished') recordResult();
        saveGame();
        elements.status.textContent = turnDescription();
        // 電腦出牌前焦點若在回合標題（鍵盤玩家在等），輪回玩家時移到手牌
        keepFocusInGame = keepFocusInGame || document.activeElement === elements.turnTitle;
        render();
        animatePlay(fromRect);
        restoreGameFocus();
      } catch (error) {
        thinking = false;
        elements.status.textContent = '電腦出牌失敗：' + error.message;
        renderHand();
        renderPlayers();
      }
    }, 520);
  }

  // 鍵盤焦點管理：手牌每次重繪都會換掉按鈕，焦點不能就此掉回 body。
  // 只有焦點原本就在牌局裡（鍵盤或螢幕閱讀器操作中）才移動，滑鼠使用者不受影響。
  let keepFocusInGame = false;
  let pendingFromRect = null; // 玩家點的那張牌的位置（選效果時要等第二下才出牌）

  function restoreGameFocus() {
    if (!keepFocusInGame || !game) return;
    const humanTurn = game.status === 'active' && game.currentPlayerId === 'p0' && !thinking;
    const target = humanTurn
      ? elements.hand.querySelector('button:not(:disabled)')
      : game.status === 'finished'
        ? $('play-again-button')
        : elements.turnTitle;
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  }

  // 出牌動畫：從來源（手牌或電腦座位）飛到桌上最新那一格。
  // 只是視覺分身，遊戲狀態在動畫開始前就已經更新，所以不會拖慢操作。
  function animatePlay(fromRect) {
    const target = elements.history.querySelector('.history-card.is-latest');
    if (!target) return;
    if (reduceMotion() || !fromRect || typeof target.animate !== 'function') {
      target.classList.remove('is-arriving');
      void target.offsetWidth;
      target.classList.add('is-arriving');
      return;
    }
    const to = target.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const ghost = target.cloneNode(true);
    ghost.classList.add('card-flight');
    ghost.removeAttribute('aria-label');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, {
      left: to.left + 'px', top: to.top + 'px', width: to.width + 'px', height: to.height + 'px'
    });
    document.body.appendChild(ghost);
    target.style.visibility = 'hidden';
    const dx = (fromRect.left + fromRect.width / 2) - (to.left + to.width / 2);
    const dy = (fromRect.top + fromRect.height / 2) - (to.top + to.height / 2);
    const scale = Math.max(0.6, Math.min(1.6, fromRect.width / to.width));
    const flight = ghost.animate([
      { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + scale + ')', opacity: 0.9 },
      { transform: 'none', opacity: 1 }
    ], { duration: 280, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    const land = () => {
      ghost.remove();
      target.style.visibility = '';
    };
    flight.onfinish = land;
    flight.oncancel = land;
  }

  function applyHumanMove(move, fromRect) {
    keepFocusInGame = keepFocusInGame || elements.game.contains(document.activeElement);
    try {
      game = Core.applyMove(game, move);
      selectedMoves = [];
      thinking = false;
      if (game.status === 'finished') recordResult();
      saveGame();
      elements.status.textContent = turnDescription();
      render();
      animatePlay(fromRect);
      restoreGameFocus();
    } catch (error) {
      elements.status.textContent = '無法出牌：' + error.message;
    }
  }

  const BoboCelebrateClose = () => {
    if (typeof BoboCelebrate !== 'undefined') BoboCelebrate.close();
  };

  function startGame(confirmed) {
    if (game && game.status === 'active' && !confirmed
      && !window.confirm('目前牌局尚未結束，確定要放棄並開始新局嗎？')) return;
    clearAiTurn();
    saveSettings();
    BoboCelebrateClose();
    game = Core.createGame(settingsFromForm());
    lastShownValue = null;
    selectedMoves = [];
    elements.resume.hidden = true;
    elements.status.textContent = '新局開始，輪到你出牌。';
    keepFocusInGame = true;
    render();
    // 「開始新局」按鈕會被藏起來，焦點直接交給手牌，不掉回 body
    restoreGameFocus();
  }

  function openSettings() {
    if (game && game.status === 'active'
      && !window.confirm('目前牌局會保存在本機。確定要回到設定開始新局嗎？')) return;
    clearAiTurn();
    saveGame();
    elements.resume.hidden = !(game && game.status === 'active');
    game = null;
    selectedMoves = [];
    elements.game.hidden = true;
    elements.setup.hidden = false;
    document.body.classList.remove('is-playing');
    elements.status.textContent = '調整人數、手牌或難度，再開始新局；也可以接續剛才的牌局。';
  }

  function resumeGame() {
    const saved = readJson(SAVE_KEY);
    if (!saved.value || !saved.ok) return;
    const resumed = Core.normalizeGame(saved.value.game);
    if (!resumed || resumed.status !== 'active') {
      storageWarning('無法接續這局牌面，請開始新局。');
      elements.resume.hidden = true;
      return;
    }
    clearAiTurn();
    lastShownValue = null;
    game = Core.resolveTurn(resumed);
    selectedMoves = [];
    savedMatchId = typeof saved.value.recordedMatchId === 'string'
      ? saved.value.recordedMatchId : savedMatchId;
    elements.playerCount.value = String(game.playerCount);
    elements.handSize.value = String(game.handSize);
    elements.difficulty.value = game.difficulty;
    elements.status.textContent = game.lastEliminatedIds.length ? turnDescription() : '已接續上局。';
    render();
  }

  function handleCardClick(event) {
    const button = event.target.closest('[data-card-id]');
    if (!button || !game || game.status !== 'active' || game.currentPlayerId !== 'p0' || thinking) return;
    const moves = Core.getAvailableMoves(game).filter(move => move.cardId === button.dataset.cardId);
    if (!moves.length) return;
    // renderHand() 會換掉被按下的那張牌，先記住焦點原本在牌局裡
    keepFocusInGame = elements.game.contains(document.activeElement);
    // 記下這張牌在手牌裡的位置，出牌動畫從這裡起飛（renderHand 之後按鈕會被換掉）
    pendingFromRect = button.getBoundingClientRect();
    selectedMoves = moves;
    renderHand();
    if (moves.length === 1) {
      applyHumanMove(moves[0], pendingFromRect);
    } else {
      renderOptions();
      elements.options.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  }

  function handleOptionClick(event) {
    const button = event.target.closest('[data-move-index]');
    if (!button) return;
    const index = Number(button.dataset.moveIndex);
    if (!Number.isInteger(index) || !selectedMoves[index]) return;
    applyHumanMove(selectedMoves[index], pendingFromRect);
  }

  // 主題鍵：label 固定為「深色模式」，狀態只由 aria-pressed 表達
  function syncThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('theme-button').innerHTML = dark ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
    $('theme-button').setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  function init() {
    const themeKit = typeof BoboTheme !== 'undefined' ? BoboTheme : null;
    if (themeKit) themeKit.init();
    syncThemeButton();

    const preferences = readJson(PREF_KEY);
    const settings = Core.normalizePreferences(preferences.value);
    elements.playerCount.value = String(settings.playerCount);
    elements.handSize.value = String(settings.handSize);
    elements.difficulty.value = settings.difficulty;
    const savedStats = readJson(STATS_KEY);
    stats = Core.normalizeStats(savedStats.value);
    renderStats();
    readSavedGame();

    elements.start.addEventListener('click', () => startGame(false));
    elements.resume.addEventListener('click', resumeGame);
    elements.playerCount.addEventListener('change', saveSettings);
    elements.handSize.addEventListener('change', saveSettings);
    elements.difficulty.addEventListener('change', saveSettings);
    elements.hand.addEventListener('click', handleCardClick);
    elements.options.addEventListener('click', handleOptionClick);
    $('new-game-button').addEventListener('click', openSettings);
    $('play-again-button').addEventListener('click', () => startGame(true));
    $('rules-button').addEventListener('click', () => {
      $('rules-dialog').showModal();
    });
    $('theme-button').addEventListener('click', () => {
      if (themeKit) themeKit.toggle();
      else document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      syncThemeButton();
    });
    window.addEventListener('pagehide', saveGame);
  }

  init();
})();
