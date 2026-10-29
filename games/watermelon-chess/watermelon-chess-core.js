(function (root) {
  'use strict';

  const RED = 1;
  const GREEN = -1;
  const offset = Math.sqrt(56000) / 3;
  const POINTS = [
    [300, 60], [300 + offset, 220 / 3], [1580 / 3, 300 - offset],
    [540, 300], [1580 / 3, 300 + offset], [300 + offset, 1580 / 3],
    [300, 540], [300 - offset, 1580 / 3], [220 / 3, 300 + offset],
    [60, 300], [220 / 3, 300 - offset], [300 - offset, 220 / 3],
    [300, 140], [460, 300], [300, 460], [140, 300],
    [300, 220], [380, 300], [300, 380], [220, 300], [300, 300]
  ].map(point => Object.freeze(point));
  const EDGES = [];
  function connect(line, closed = false) {
    for (let i = 1; i < line.length; i++) EDGES.push([line[i - 1], line[i]]);
    if (closed) EDGES.push([line[line.length - 1], line[0]]);
  }
  connect(Array.from({ length: 12 }, (_, i) => i), true);
  connect([0, 12, 16, 20, 18, 14, 6]);
  connect([9, 15, 19, 20, 17, 13, 3]);
  connect([16, 17, 18, 19], true);
  [[11, 12, 1], [2, 13, 4], [5, 14, 7], [8, 15, 10]].forEach(line => connect(line));
  const NEIGHBORS = POINTS.map((_, point) => Object.freeze(EDGES.flatMap(([a, b]) =>
    a === point ? [b] : b === point ? [a] : [])));
  Object.freeze(POINTS);
  EDGES.forEach(Object.freeze);
  Object.freeze(EDGES);
  Object.freeze(NEIGHBORS);

  function initialBoard() {
    const board = Array(21).fill(0);
    [0, 1, 2, 10, 11, 12].forEach(point => { board[point] = RED; });
    [4, 5, 6, 7, 8, 14].forEach(point => { board[point] = GREEN; });
    return board;
  }

  function groupAt(board, start) {
    const group = [start];
    const visited = new Set(group);
    const liberties = new Set();
    for (let i = 0; i < group.length; i++) {
      for (const point of NEIGHBORS[group[i]]) {
        if (board[point] === 0) liberties.add(point);
        else if (board[point] === board[start] && !visited.has(point)) {
          visited.add(point);
          group.push(point);
        }
      }
    }
    return { stones: group, liberties: [...liberties] };
  }

  function moveBoard(board, player, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to)
      || !NEIGHBORS[from]?.includes(to) || board[from] !== player || board[to] !== 0) {
      return null;
    }
    const next = board.slice();
    next[from] = 0;
    next[to] = player;
    const visited = new Set();
    const captured = [];
    // Collect all surrounded enemy groups before removing any of them.
    for (let point = 0; point < next.length; point++) {
      if (next[point] !== -player || visited.has(point)) continue;
      const group = groupAt(next, point);
      group.stones.forEach(stone => visited.add(stone));
      if (!group.liberties.length) captured.push(...group.stones);
    }
    captured.forEach(point => { next[point] = 0; });
    if (!groupAt(next, to).liberties.length) return null;
    return { board: next, captured };
  }

  function legalMoves(board, player) {
    const moves = [];
    board.forEach((stone, from) => {
      if (stone !== player) return;
      NEIGHBORS[from].forEach(to => {
        if (board[to] === 0 && moveBoard(board, player, from, to)) moves.push({ from, to });
      });
    });
    return moves;
  }

  function positionKey(board, turn) {
    return board.map(stone => stone === RED ? 'r' : stone === GREEN ? 'g' : '.').join('') + turn;
  }

  function count(board, player) {
    return board.filter(stone => stone === player).length;
  }

  function outcome(board, turn, repetitions = 1) {
    if (count(board, RED) <= 2) return { status: 'finished', winner: GREEN, reason: 'capture' };
    if (count(board, GREEN) <= 2) return { status: 'finished', winner: RED, reason: 'capture' };
    if (!legalMoves(board, turn).length) return { status: 'finished', winner: -turn, reason: 'blocked' };
    if (repetitions >= 3) return { status: 'finished', winner: 0, reason: 'repetition' };
    return { status: 'active', winner: 0, reason: null };
  }

  function validSettings(settings) {
    return settings && ['ai', 'local'].includes(settings.mode)
      && ['easy', 'normal', 'hard'].includes(settings.difficulty)
      && [RED, GREEN].includes(settings.human);
  }

  function createGame(settings = { mode: 'ai', difficulty: 'normal', human: RED }) {
    if (!validSettings(settings)) throw new TypeError('Invalid watermelon chess settings');
    const board = initialBoard();
    return {
      settings: { mode: settings.mode, difficulty: settings.difficulty, human: settings.human },
      moves: [],
      history: [{
        board, turn: RED, key: positionKey(board, RED), lastMove: null,
        status: 'active', winner: 0, reason: null
      }]
    };
  }

  function current(game) {
    return game.history[game.history.length - 1];
  }

  function playMove(game, from, to) {
    const state = current(game);
    if (state.status !== 'active') throw new Error('對局已結束，請開始新局。');
    const moved = moveBoard(state.board, state.turn, from, to);
    if (!moved) throw new Error('這一步不合法：請沿線走到相鄰空點，且不可自陷無氣。');
    const turn = -state.turn;
    const key = positionKey(moved.board, turn);
    const repetitions = 1 + game.history.filter(frame => frame.key === key).length;
    const next = {
      board: moved.board, turn, key,
      lastMove: { from, to, player: state.turn, captured: moved.captured },
      ...outcome(moved.board, turn, repetitions)
    };
    return {
      settings: { ...game.settings },
      moves: [...game.moves, { from, to }],
      history: [...game.history, next]
    };
  }

  function undoCount(game) {
    if (current(game).status !== 'active' || !game.moves.length) return 0;
    if (game.settings.mode === 'local') return 1;
    for (let i = game.history.length - 1; i > 0; i--) {
      if (game.history[i].lastMove.player === game.settings.human) return game.history.length - i;
    }
    return 0;
  }

  function undo(game) {
    const steps = undoCount(game);
    if (!steps) throw new Error('目前沒有可以悔棋的玩家步數。');
    return {
      settings: { ...game.settings },
      moves: game.moves.slice(0, -steps),
      history: game.history.slice(0, -steps)
    };
  }

  function serialize(game, selected = null) {
    return { version: 1, settings: { ...game.settings }, moves: game.moves, selected };
  }

  function restore(saved) {
    if (!saved || saved.version !== 1 || !validSettings(saved.settings)
      || !Array.isArray(saved.moves) || saved.moves.length > 10000) {
      throw new Error('西瓜棋存檔格式無效，請開始新局。');
    }
    let game = createGame(saved.settings);
    saved.moves.forEach(move => {
      if (!move || typeof move !== 'object') throw new Error('西瓜棋走棋紀錄無效。');
      game = playMove(game, move.from, move.to);
    });
    const state = current(game);
    const selected = Number.isInteger(saved.selected) && state.board[saved.selected] === state.turn
      && (game.settings.mode === 'local' || state.turn === game.settings.human)
      ? saved.selected : null;
    return { game, selected };
  }

  function evaluate(board, player) {
    let value = (count(board, player) - count(board, -player)) * 220;
    const visited = new Set();
    board.forEach((stone, point) => {
      if (!stone || visited.has(point)) return;
      const group = groupAt(board, point);
      group.stones.forEach(item => visited.add(item));
      const safety = group.liberties.length === 1 ? -70 * group.stones.length
        : Math.min(group.liberties.length, 6) * 9;
      value += stone * player * safety;
    });
    board.forEach((stone, point) => {
      if (stone) value += stone * player * (point >= 16 ? 12 : point >= 12 ? 6 : 0);
    });
    return value;
  }

  function chooseMove(game, difficulty = game.settings.difficulty, options = {}) {
    if (!['easy', 'normal', 'hard'].includes(difficulty)) throw new TypeError('Invalid AI difficulty');
    const state = current(game);
    if (state.status !== 'active') return null;
    const moves = legalMoves(state.board, state.turn);
    if (!moves.length) return null;
    const maxDepth = { easy: 1, normal: 3, hard: 5 }[difficulty];
    const budget = options.timeBudgetMs ?? (difficulty === 'hard' ? 140 : 65);
    const maxNodes = options.maxNodes ?? (difficulty === 'hard' ? 16000 : 6000);
    const now = () => performance.now();
    const deadline = now() + budget;
    const occurrences = new Map();
    game.history.forEach(frame => occurrences.set(frame.key, (occurrences.get(frame.key) || 0) + 1));
    let nodes = 0;
    let interrupted = false;

    function search(board, turn, depth, alpha, beta, ply) {
      if (++nodes > maxNodes || now() >= deadline) {
        interrupted = true;
        return evaluate(board, turn);
      }
      if (count(board, turn) <= 2) return -100000 + ply;
      if (count(board, -turn) <= 2) return 100000 - ply;
      const candidates = legalMoves(board, turn);
      if (!candidates.length) return -100000 + ply;
      if ((occurrences.get(positionKey(board, turn)) || 0) >= 3) return 0;
      if (!depth) return evaluate(board, turn);
      let best = -Infinity;
      const ordered = candidates.map(move => ({ move, result: moveBoard(board, turn, move.from, move.to) }))
        .sort((a, b) => b.result.captured.length - a.result.captured.length);
      for (const { result } of ordered) {
        const key = positionKey(result.board, -turn);
        occurrences.set(key, (occurrences.get(key) || 0) + 1);
        const value = -search(result.board, -turn, depth - 1, -beta, -alpha, ply + 1);
        occurrences.set(key, occurrences.get(key) - 1);
        if (interrupted) return best === -Infinity ? value : best;
        best = Math.max(best, value);
        alpha = Math.max(alpha, value);
        if (alpha >= beta) break;
      }
      return best;
    }

    // Keep a complete one-ply ranking even when deeper searches exhaust their budget.
    let ranked = moves.map(move => {
      const result = moveBoard(state.board, state.turn, move.from, move.to);
      const resultOutcome = outcome(result.board, -state.turn);
      return { ...move, score: resultOutcome.winner === state.turn ? 100000
        : resultOutcome.winner === -state.turn ? -100000 : evaluate(result.board, state.turn) };
    }).sort((a, b) => b.score - a.score);
    if (difficulty === 'easy') {
      const choices = ranked[0].score >= 100000 ? [ranked[0]] : ranked.slice(0, 3);
      const random = options.random || Math.random;
      const choice = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
      return { from: choice.from, to: choice.to };
    }
    for (let depth = 2; depth <= maxDepth; depth++) {
      const next = [];
      let alpha = -Infinity;
      for (const move of ranked) {
        const result = moveBoard(state.board, state.turn, move.from, move.to);
        const key = positionKey(result.board, -state.turn);
        occurrences.set(key, (occurrences.get(key) || 0) + 1);
        const score = -search(result.board, -state.turn, depth - 1, -Infinity, -alpha, 1);
        occurrences.set(key, occurrences.get(key) - 1);
        if (interrupted) break;
        next.push({ from: move.from, to: move.to, score });
        alpha = Math.max(alpha, score);
      }
      if (interrupted) break;
      ranked = next.sort((a, b) => b.score - a.score);
      if (ranked[0].score > 90000) break;
    }
    return { from: ranked[0].from, to: ranked[0].to };
  }

  const api = {
    RED, GREEN, POINTS, EDGES, NEIGHBORS, initialBoard, groupAt, moveBoard,
    legalMoves, positionKey, count, outcome, validSettings, createGame,
    current, playMove, undoCount, undo, serialize, restore, chooseMove
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WatermelonChessCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
