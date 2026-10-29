(() => {
  'use strict';

  const Core = WatermelonChessCore;
  const SAVE_KEY = 'watermelon_chess_save_v1';
  const PREF_KEY = 'watermelon_chess_pref_v1';
  const STATS_KEY = 'watermelon_chess_stats_v1';
  const SOUND_KEY = 'watermelon_chess_sound';
  const $ = id => document.getElementById(id);
  const theme = typeof BoboTheme !== 'undefined' ? BoboTheme : null;
  const audio = typeof BoboAudio !== 'undefined' ? BoboAudio.create() : null;
  const difficultyNames = { easy: '簡單', normal: '普通', hard: '困難' };
  const statFields = ['wins', 'losses', 'draws', 'localGames', 'streak', 'bestStreak', 'bestMoves'];
  let game;
  let selected = null;
  let aiTimer = null;
  let thinking = false;
  let pendingSettings = null;
  let demoStep = 0;
  let sound = true;
  let stats = Object.fromEntries(statFields.map(field => [field, 0]));
  const pointButtons = [];

  function storageWarning(message) {
    $('storage-notice').textContent = message;
    $('storage-notice').hidden = false;
  }

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (error) {
      storageWarning('無法讀取本機資料；存檔可能已損壞，或瀏覽器未允許儲存。這局仍可遊玩。');
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      storageWarning('無法儲存本機資料；離開後可能遺失這局進度、設定或戰績。請檢查儲存權限。');
    }
  }

  function saveGameState() {
    if (game && Core.current(game).status === 'active') writeJson(SAVE_KEY, Core.serialize(game, selected));
  }

  function clearGameState() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (error) {
      storageWarning('無法清除舊對局；請檢查瀏覽器的本機儲存權限。');
    }
  }

  function loadGameState() {
    const saved = readJson(SAVE_KEY);
    if (!saved) return false;
    let restored;
    try {
      restored = Core.restore(saved);
    } catch (error) {
      storageWarning('這份西瓜棋存檔無效，已重新開局。');
      clearGameState();
      return false;
    }
    if (Core.current(restored.game).status !== 'active') {
      clearGameState();
      return false;
    }
    game = restored.game;
    selected = restored.selected;
    return true;
  }

  function settingsFromForm() {
    return { mode: $('mode').value, difficulty: $('difficulty').value, human: Number($('human').value) };
  }

  function fillSettings(settings) {
    $('mode').value = settings.mode;
    $('difficulty').value = settings.difficulty;
    $('human').value = String(settings.human);
    $('ai-settings').hidden = settings.mode === 'local';
  }

  function playerName(player) {
    const color = player === Core.RED ? '紅方' : '綠方';
    return game.settings.mode === 'local' ? color
      : color + (player === game.settings.human ? ' · 你' : ' · 電腦');
  }

  function renderRecords() {
    $('records').innerHTML = [['wins', '勝'], ['losses', '敗'], ['draws', '和']]
      .map(([key, label]) => '<div><strong>' + stats[key] + '</strong><span>人機' + label + '</span></div>')
      .join('');
    $('best-record').textContent = '最佳連勝 ' + stats.bestStreak + ' · 雙人完成 ' + stats.localGames + ' 局'
      + (stats.bestMoves ? ' · 最少勝局 ' + stats.bestMoves + ' 步（含雙方）' : '');
  }

  function recordResult() {
    const state = Core.current(game);
    if (game.settings.mode === 'local') stats.localGames += 1;
    else if (!state.winner) {
      stats.draws += 1;
      stats.streak = 0;
    } else if (state.winner === game.settings.human) {
      stats.wins += 1;
      stats.streak += 1;
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
      stats.bestMoves = stats.bestMoves ? Math.min(stats.bestMoves, game.moves.length) : game.moves.length;
    } else {
      stats.losses += 1;
      stats.streak = 0;
    }
    writeJson(STATS_KEY, stats);
    renderRecords();
  }

  function playSound(captured, finished) {
    if (!sound || !audio) return;
    audio.tone({ freq: finished ? 660 : captured ? 520 : 330, type: 'triangle', duration: .09, gain: .09 });
    if (finished) audio.tone({ freq: 880, delay: .12, type: 'triangle', duration: .16, gain: .07 });
  }

  function createBoard() {
    Core.POINTS.forEach(([x, y], point) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'point';
      button.id = 'point-' + point;
      button.dataset.point = String(point);
      button.style.left = (x / 6) + '%';
      button.style.top = (y / 6) + '%';
      button.addEventListener('click', () => selectPoint(point));
      button.addEventListener('keydown', event => {
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction) {
          if (event.key === 'Escape' && selected !== null) {
            selected = null;
            saveGameState();
            render();
          }
          return;
        }
        event.preventDefault();
        const target = Core.POINTS.map(([tx, ty], index) => {
          const dx = tx - x;
          const dy = ty - y;
          const forward = dx * direction[0] + dy * direction[1];
          const sideways = Math.abs(dx * direction[1] - dy * direction[0]);
          return { index, score: forward > .1 ? Math.hypot(dx, dy) + sideways * 2 : Infinity };
        }).sort((a, b) => a.score - b.score)[0];
        if (Number.isFinite(target.score)) pointButtons[target.index].focus();
      });
      pointButtons.push(button);
      $('board').appendChild(button);
    });
  }

  function render() {
    const state = Core.current(game);
    const finished = state.status === 'finished';
    const humanTurn = game.settings.mode === 'local' || state.turn === game.settings.human;
    const legal = selected === null ? [] : Core.legalMoves(state.board, state.turn)
      .filter(move => move.from === selected).map(move => move.to);
    pointButtons.forEach((button, point) => {
      const stone = state.board[point];
      button.className = 'point'
        + (stone ? ' has-piece' : '') + (stone === Core.GREEN ? ' green' : '')
        + (point === selected ? ' is-selected' : '') + (legal.includes(point) ? ' is-legal' : '')
        + (state.lastMove?.to === point ? ' is-last' : '')
        + (state.lastMove?.from === point ? ' is-from' : '');
      button.textContent = stone === Core.RED ? '紅' : stone === Core.GREEN ? '綠' : '';
      button.setAttribute('aria-label', '棋點 ' + (point + 1) + '，'
        + (stone ? (stone === Core.RED ? '紅棋' : '綠棋') : '空點')
        + (point === selected ? '，已選取' : '')
        + (legal.includes(point) ? '，可移動到這裡' : '')
        + (state.lastMove?.to === point ? '，最近一步' : ''));
      button.setAttribute('aria-pressed', String(point === selected));
      button.disabled = finished || !humanTurn || thinking;
    });
    for (const [prefix, player] of [['red', Core.RED], ['green', Core.GREEN]]) {
      $(prefix + '-count').textContent = Core.count(state.board, player);
      $(prefix + '-name').textContent = playerName(player);
      $(prefix + '-player').classList.toggle('is-turn', !finished && state.turn === player);
      $(prefix + '-turn').hidden = finished || state.turn !== player;
    }
    $('move-count').textContent = game.moves.length;
    $('match-tag').textContent = game.settings.mode === 'local' ? '雙人同機'
      : '人機對戰 · ' + difficultyNames[game.settings.difficulty];
    $('undo-button').disabled = Core.undoCount(game) === 0;
    $('turn-status').classList.toggle('is-finished', finished);
    $('board').setAttribute('aria-busy', String(thinking));
    if (finished) {
      $('turn-status').textContent = state.winner ? playerName(state.winner) + '獲勝！' : '平手，棋逢敵手！';
      $('last-move').textContent = {
        capture: '對手剩下 2 顆或更少。好棋，再來一局？',
        blocked: '對手已經沒有合法步可走。',
        repetition: '同盤面、同一方行棋出現三次，這局握手言和。'
      }[state.reason];
    } else {
      $('turn-status').textContent = thinking ? playerName(state.turn) + '思考中…'
        : selected !== null ? '已選取棋點 ' + (selected + 1) + (legal.length ? '，點圓環走子' : '，這顆暫時無路可走')
          : '輪到' + playerName(state.turn) + '，選一顆棋子';
      const last = state.lastMove;
      $('last-move').textContent = last ? playerName(last.player) + '：' + (last.from + 1) + ' → ' + (last.to + 1)
        + (last.captured.length ? '，吃掉 ' + last.captured.length + ' 顆！' : '。外圈標示最近一步。')
        : '紅方先手，先選一顆棋子吧。';
    }
    $('again-button').textContent = finished ? '再來一局' : '重新開始';
  }

  function cancelAI() {
    clearTimeout(aiTimer);
    aiTimer = null;
    thinking = false;
  }

  function scheduleAI() {
    const state = Core.current(game);
    if (state.status !== 'active' || game.settings.mode !== 'ai' || state.turn === game.settings.human) return;
    thinking = true;
    render();
    aiTimer = setTimeout(() => {
      aiTimer = null;
      const move = Core.chooseMove(game);
      thinking = false;
      if (!move) {
        render();
        $('turn-status').textContent = '電腦無法完成行棋，請悔棋或重新開局。';
        console.error('Watermelon chess AI returned no move for an active game');
        return;
      }
      commitMove(move.from, move.to);
    }, 350);
  }

  function commitMove(from, to) {
    game = Core.playMove(game, from, to);
    selected = null;
    const state = Core.current(game);
    if (state.status === 'finished') {
      clearGameState();
      recordResult();
    } else saveGameState();
    playSound(state.lastMove.captured.length > 0, state.status === 'finished');
    render();
    scheduleAI();
  }

  function selectPoint(point) {
    const state = Core.current(game);
    if (thinking || state.status !== 'active'
      || (game.settings.mode === 'ai' && state.turn !== game.settings.human)) return;
    if (state.board[point] === state.turn) {
      selected = selected === point ? null : point;
      saveGameState();
      render();
      return;
    }
    if (selected !== null && state.board[point] === 0
      && Core.moveBoard(state.board, state.turn, selected, point)) {
      commitMove(selected, point);
      return;
    }
    $('turn-status').textContent = selected === null ? '請先點選自己的棋子。'
      : '不能走到這裡；請選相鄰空點，且不可自陷無氣。';
  }

  function startGame(settings, recordPlay = true) {
    cancelAI();
    clearGameState();
    selected = null;
    game = Core.createGame(settings);
    fillSettings(settings);
    writeJson(PREF_KEY, settings);
    saveGameState();
    render();
    scheduleAI();
    if (recordPlay) {
      if (typeof Stats !== 'undefined') Stats.recordGamePlay('watermelon-chess');
      if (innerWidth <= 850) $('board').closest('.match-panel').scrollIntoView({ block: 'start' });
    }
  }

  function requestNewGame(settings) {
    if (Core.current(game).status === 'active' && game.moves.length) {
      pendingSettings = settings;
      $('confirm-dialog').showModal();
    } else startGame(settings);
  }

  function renderDemo() {
    $('demo-target').classList.toggle('is-filled', demoStep >= 1);
    $('demo-arrival').style.display = demoStep >= 1 ? '' : 'none';
    $('demo-arrival').removeAttribute('hidden');
    $('demo-victim').classList.toggle('is-captured', demoStep === 2);
    $('demo-copy').textContent = [
      '① 綠棋還有右邊這一口氣，所以現在不能吃。',
      '② 紅棋走進最後一個空點，綠棋的出路都被封住了。',
      '③ 綠棋已無氣，從棋盤移除！相連的同色棋子也要一起看氣。'
    ][demoStep];
    $('demo-next').textContent = demoStep === 2 ? '再看一次 ↶' : '下一步 →';
  }

  function openRules() {
    demoStep = 0;
    renderDemo();
    $('rules-dialog').showModal();
  }

  function init() {
    if (theme) theme.init();
    const storedStats = readJson(STATS_KEY);
    if (storedStats !== null) {
      if (statFields.every(field => Number.isSafeInteger(storedStats[field]) && storedStats[field] >= 0)) stats = storedStats;
      else storageWarning('棋桌紀錄格式無效，這次將從零開始記錄。');
    }
    const storedSound = readJson(SOUND_KEY);
    if (typeof storedSound === 'boolean') sound = storedSound;
    else if (storedSound !== null) storageWarning('音效設定格式無效，已使用預設設定。');
    if (audio) audio.setEnabled(sound);
    else $('sound-button').disabled = true;
    $('sound-button').setAttribute('aria-pressed', String(sound));
    const preferences = readJson(PREF_KEY);
    if (preferences !== null && !Core.validSettings(preferences)) storageWarning('對局設定格式無效，已使用預設設定。');
    fillSettings(Core.validSettings(preferences) ? preferences : { mode: 'ai', difficulty: 'normal', human: Core.RED });
    createBoard();
    if (!loadGameState()) startGame(settingsFromForm(), false);
    else {
      fillSettings(game.settings);
      render();
      scheduleAI();
    }
    renderRecords();

    $('settings-form').addEventListener('submit', event => {
      event.preventDefault();
      requestNewGame(settingsFromForm());
    });
    $('mode').addEventListener('change', () => { $('ai-settings').hidden = $('mode').value === 'local'; });
    $('again-button').addEventListener('click', () => requestNewGame(game.settings));
    $('confirm-new').addEventListener('click', () => {
      $('confirm-dialog').close();
      startGame(pendingSettings);
      pendingSettings = null;
    });
    $('cancel-new').addEventListener('click', () => $('confirm-dialog').close());
    $('undo-button').addEventListener('click', () => {
      cancelAI();
      game = Core.undo(game);
      selected = null;
      saveGameState();
      render();
    });
    $('sound-button').addEventListener('click', () => {
      sound = !sound;
      if (audio) audio.setEnabled(sound);
      $('sound-button').setAttribute('aria-pressed', String(sound));
      writeJson(SOUND_KEY, sound);
    });
    $('theme-button').addEventListener('click', () => {
      if (!theme) {
        storageWarning('主題模組未能載入，請重新整理頁面。');
        return;
      }
      const next = theme.toggle();
      if (readJson('bobo-home-preferences-v2')?.theme !== next) {
        storageWarning('主題已切換，但無法儲存偏好。');
      }
    });
    $('rules-button').addEventListener('click', openRules);
    $('demo-button').addEventListener('click', openRules);
    $('demo-next').addEventListener('click', () => { demoStep = (demoStep + 1) % 3; renderDemo(); });
  }

  init();
})();
