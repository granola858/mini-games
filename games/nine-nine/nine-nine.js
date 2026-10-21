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
    return (player ? player.name : '玩家') + ' 出了 ' + label + ' · ' + effect;
  }

  function turnDescription() {
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
      return '<li class="history-card' + (latest ? ' is-latest' : '') + '" aria-label="'
        + escapeHtml(actionDescription(action) + '，點數 ' + action.value + (latest ? '，最新' : '')) + '">'
        + '<span class="history-owner">' + escapeHtml(owner.name) + '</span>'
        + '<strong class="history-face' + (red ? ' red' : '') + '">' + getCardLabel(action.card) + '</strong>'
        + '<span class="history-value">→ ' + action.value + '</span></li>';
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

  function renderHand() {
    const player = Core.getPlayer(game, 'p0');
    const humanTurn = game.status === 'active' && game.currentPlayerId === 'p0' && !thinking;
    if (!player) return;
    const legalMoves = humanTurn ? Core.getAvailableMoves(game) : [];
    const suitGlyph = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
    elements.hand.innerHTML = player.hand.map(card => {
      const red = card.suit === 'hearts' || card.suit === 'diamonds';
      const selected = selectedMoves.some(move => move.cardId === card.id);
      const safe = legalMoves.some(move => move.cardId === card.id);
      const blocked = humanTurn && !safe;
      return '<button class="playing-card' + (red ? ' red' : '') + (selected ? ' selected' : '')
        + '" type="button" data-card-id="' + card.id + '" aria-label="出 ' + card.rank
        + suitGlyph[card.suit] + (blocked ? '，超過 99，無法出牌' : '') + '" '
        + (humanTurn && safe ? '' : 'disabled') + '>'
        + '<span class="rank">' + card.rank + '</span><span class="suit" aria-hidden="true">'
        + suitGlyph[card.suit] + '</span>'
        + (blocked ? '<span class="card-warning">爆點</span>' : '') + '</button>';
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
    elements.value.textContent = String(game.currentValue);
    elements.fill.style.width = Math.max(0, Math.min(100, game.currentValue / 99 * 100)) + '%';
    elements.fill.classList.toggle('is-danger', game.currentValue >= 85);
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
        game = Core.applyMove(game, move);
        thinking = false;
        selectedMoves = [];
        if (game.status === 'finished') recordResult();
        saveGame();
        elements.status.textContent = turnDescription();
        render();
      } catch (error) {
        thinking = false;
        elements.status.textContent = '電腦出牌失敗：' + error.message;
        renderHand();
        renderPlayers();
      }
    }, 520);
  }

  function applyHumanMove(move) {
    try {
      game = Core.applyMove(game, move);
      selectedMoves = [];
      thinking = false;
      if (game.status === 'finished') recordResult();
      saveGame();
      elements.status.textContent = turnDescription();
      render();
    } catch (error) {
      elements.status.textContent = '無法出牌：' + error.message;
    }
  }

  function startGame(confirmed) {
    if (game && game.status === 'active' && !confirmed
      && !window.confirm('目前牌局尚未結束，確定要放棄並開始新局嗎？')) return;
    clearAiTurn();
    saveSettings();
    game = Core.createGame(settingsFromForm());
    selectedMoves = [];
    elements.resume.hidden = true;
    elements.status.textContent = '新局開始，輪到你出牌。';
    render();
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
    elements.status.textContent = '調整人數或難度，再開始新局；也可以接續剛才的牌局。';
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
    game = Core.resolveTurn(resumed);
    selectedMoves = [];
    savedMatchId = typeof saved.value.recordedMatchId === 'string'
      ? saved.value.recordedMatchId : savedMatchId;
    elements.playerCount.value = String(game.playerCount);
    elements.difficulty.value = game.difficulty;
    elements.status.textContent = game.lastEliminatedIds.length ? turnDescription() : '已接續上局。';
    render();
  }

  function handleCardClick(event) {
    const button = event.target.closest('[data-card-id]');
    if (!button || !game || game.status !== 'active' || game.currentPlayerId !== 'p0' || thinking) return;
    const moves = Core.getAvailableMoves(game).filter(move => move.cardId === button.dataset.cardId);
    if (!moves.length) return;
    selectedMoves = moves;
    renderHand();
    const card = Core.getPlayer(game, 'p0').hand.find(item => item.id === button.dataset.cardId);
    if (moves.length === 1 && card.rank !== '10' && card.rank !== 'Q') {
      applyHumanMove(moves[0]);
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
    applyHumanMove(selectedMoves[index]);
  }

  function syncThemeButton() {
    const theme = document.documentElement.dataset.theme;
    $('theme-button').textContent = theme === 'dark' ? '☀️' : '🌙';
    $('theme-button').setAttribute('aria-label', theme === 'dark' ? '切換為淺色模式' : '切換為深色模式');
  }

  function init() {
    const themeKit = typeof BoboTheme !== 'undefined' ? BoboTheme : null;
    if (themeKit) themeKit.init();
    syncThemeButton();

    const preferences = readJson(PREF_KEY);
    const settings = Core.normalizePreferences(preferences.value);
    elements.playerCount.value = String(settings.playerCount);
    elements.difficulty.value = settings.difficulty;
    const savedStats = readJson(STATS_KEY);
    stats = Core.normalizeStats(savedStats.value);
    renderStats();
    readSavedGame();

    elements.start.addEventListener('click', () => startGame(false));
    elements.resume.addEventListener('click', resumeGame);
    elements.playerCount.addEventListener('change', saveSettings);
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
