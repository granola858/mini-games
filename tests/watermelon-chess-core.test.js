const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../games/watermelon-chess/watermelon-chess-core.js');

const settings = { mode: 'local', difficulty: 'normal', human: Core.RED };
const emptyBoard = () => Array(21).fill(0);

test('西瓜棋棋盤有 21 點、36 條邊，所有連線對稱且棋盤連通', () => {
  assert.equal(Core.POINTS.length, 21);
  assert.equal(Core.EDGES.length, 36);
  assert.equal(new Set(Core.EDGES.map(edge => edge.slice().sort((a, b) => a - b).join(','))).size, 36);
  const visited = new Set([0]);
  const pending = [0];
  while (pending.length) {
    const point = pending.pop();
    Core.NEIGHBORS[point].forEach(next => {
      assert.ok(Core.NEIGHBORS[next].includes(point));
      if (!visited.has(next)) { visited.add(next); pending.push(next); }
    });
  }
  assert.equal(visited.size, 21);
  assert.deepEqual(Core.NEIGHBORS[0].slice().sort((a, b) => a - b), [1, 11, 12]);
  assert.deepEqual(Core.NEIGHBORS[20].slice().sort((a, b) => a - b), [16, 17, 18, 19]);
  Core.POINTS.forEach(([x, y]) => assert.ok(x >= 60 && x <= 540 && y >= 60 && y <= 540));
});

test('開局雙方各六子，紅先手，沒有無氣棋組', () => {
  const game = Core.createGame(settings);
  const state = Core.current(game);
  assert.equal(Core.count(state.board, Core.RED), 6);
  assert.equal(Core.count(state.board, Core.GREEN), 6);
  assert.equal(state.turn, Core.RED);
  assert.equal(state.status, 'active');
  state.board.forEach((stone, point) => {
    if (stone) assert.ok(Core.groupAt(state.board, point).liberties.length);
  });
  assert.ok(Core.legalMoves(state.board, Core.RED).length);
});

test('只可沿相鄰連線移動自己的棋子到空點，不可跳棋或蓋子', () => {
  const board = Core.initialBoard();
  assert.ok(Core.moveBoard(board, Core.RED, 12, 16));
  [[12, 20], [12, 0], [14, 18], [-1, 0], [1.5, 2], [12, 21]].forEach(([from, to]) => {
    assert.equal(Core.moveBoard(board, Core.RED, from, to), null);
  });
  assert.deepEqual(board, Core.initialBoard());
});

test('封住最後一氣吃掉單子，且不修改輸入盤面', () => {
  const board = emptyBoard();
  board[0] = Core.GREEN;
  [11, 12, 2].forEach(point => { board[point] = Core.RED; });
  const moved = Core.moveBoard(board, Core.RED, 2, 1);
  assert.deepEqual(moved.captured, [0]);
  assert.equal(moved.board[0], 0);
  assert.equal(moved.board[1], Core.RED);
  assert.equal(board[0], Core.GREEN);

});

test('同色相連共同看氣，不會因其中一子周圍塞滿就被誤吃', () => {
  const board = emptyBoard();
  [0, 11].forEach(point => { board[point] = Core.GREEN; });
  [1, 12, 9].forEach(point => { board[point] = Core.RED; });
  const moved = Core.moveBoard(board, Core.RED, 9, 15);
  assert.deepEqual(moved.captured, []);
  assert.equal(moved.board[0], Core.GREEN);
  assert.ok(Core.groupAt(moved.board, 0).liberties.includes(10));
});

test('封住整組最後一氣會一次提掉多顆，不能借同色棋子當敵棋包圍', () => {
  const board = emptyBoard();
  [0, 11].forEach(point => { board[point] = Core.GREEN; });
  [1, 12, 9].forEach(point => { board[point] = Core.RED; });
  const moved = Core.moveBoard(board, Core.RED, 9, 10);
  assert.deepEqual(moved.captured.slice().sort((a, b) => a - b), [0, 11]);
  assert.equal(Core.count(moved.board, Core.GREEN), 0);
});

test('同一手能同時提掉不同的無氣敵棋組', () => {
  const board = emptyBoard();
  [16, 13].forEach(point => { board[point] = Core.GREEN; });
  [12, 20, 19, 2, 4, 3, 18].forEach(point => { board[point] = Core.RED; });
  const moved = Core.moveBoard(board, Core.RED, 18, 17);
  assert.deepEqual(moved.captured.slice().sort((a, b) => a - b), [13, 16]);
});

test('走入看似被圍的點仍會因原位置騰空而保有一氣', () => {
  const board = emptyBoard();
  [1, 11].forEach(point => { board[point] = Core.GREEN; });
  board[12] = Core.RED;
  const moved = Core.moveBoard(board, Core.RED, 12, 0);
  assert.deepEqual(Core.groupAt(moved.board, 0).liberties, [12]);
});

test('剩下兩顆即判負，三顆不算輸；無合法步則判負', () => {
  const board = emptyBoard();
  [0, 1, 12].forEach(point => { board[point] = Core.RED; });
  [6, 7, 14].forEach(point => { board[point] = Core.GREEN; });
  assert.equal(Core.outcome(board, Core.RED).status, 'active');
  board[6] = 0;
  assert.deepEqual(Core.outcome(board, Core.RED), { status: 'finished', winner: Core.RED, reason: 'capture' });
  const blocked = Array(21).fill(Core.RED);
  [0, 1, 11].forEach(point => { blocked[point] = Core.GREEN; });
  assert.deepEqual(Core.outcome(blocked, Core.GREEN), { status: 'finished', winner: Core.RED, reason: 'blocked' });
});

test('走棋不改動舊盤面，換手並留下來源、目的地及完整紀錄', () => {
  const game = Core.createGame(settings);
  const moved = Core.playMove(game, 12, 16);
  assert.equal(game.moves.length, 0);
  assert.equal(Core.current(game).board[12], Core.RED);
  assert.equal(moved.moves.length, 1);
  assert.equal(Core.current(moved).turn, Core.GREEN);
  assert.deepEqual(Core.current(moved).lastMove, { from: 12, to: 16, player: Core.RED, captured: [] });
  assert.throws(() => Core.playMove(moved, 16, 20), /不合法/);
});

test('同盤面同方行棋三次才和局，結束後不可續走或悔棋', () => {
  let game = Core.createGame(settings);
  const cycle = [[12, 16], [14, 18], [16, 12], [18, 14]];
  cycle.forEach(([from, to]) => { game = Core.playMove(game, from, to); });
  assert.equal(Core.current(game).status, 'active');
  cycle.forEach(([from, to]) => { game = Core.playMove(game, from, to); });
  assert.equal(Core.current(game).status, 'finished');
  assert.equal(Core.current(game).reason, 'repetition');
  assert.equal(Core.current(game).winner, 0);
  assert.equal(Core.undoCount(game), 0);
  assert.throws(() => Core.playMove(game, 12, 16), /結束/);
  assert.throws(() => Core.undo(game), /沒有/);
  assert.notEqual(Core.positionKey(Core.initialBoard(), Core.RED), Core.positionKey(Core.initialBoard(), Core.GREEN));
});

test('雙人退一步，人機思考時退一手、回應後退兩手，電腦起手不能退', () => {
  const local = Core.playMove(Core.createGame(settings), 12, 16);
  assert.equal(Core.undo(local).moves.length, 0);
  let ai = Core.createGame({ ...settings, mode: 'ai' });
  ai = Core.playMove(ai, 12, 16);
  assert.equal(Core.undoCount(ai), 1);
  ai = Core.playMove(ai, 14, 18);
  assert.equal(Core.undoCount(ai), 2);
  assert.deepEqual(Core.current(Core.undo(ai)).board, Core.initialBoard());
  const second = Core.playMove(Core.createGame({ ...settings, mode: 'ai', human: Core.GREEN }), 12, 16);
  assert.equal(Core.undoCount(second), 0);
  const secondPlayed = Core.playMove(second, 14, 18);
  assert.equal(Core.undo(secondPlayed).moves.length, 1);
});

test('存檔重播保留設定、棋盤、選取及悔棋紀錄，拒絕不合法紀錄', () => {
  const game = Core.playMove(Core.createGame(settings), 12, 16);
  const restored = Core.restore(JSON.parse(JSON.stringify(Core.serialize(game, 14))));
  assert.deepEqual(restored.game, game);
  assert.equal(restored.selected, 14);
  assert.equal(Core.undo(restored.game).moves.length, 0);
  assert.equal(Core.restore(Core.serialize(game, 16)).selected, null);
  [null, {}, { version: 1, settings, moves: [{ from: 0, to: 20 }] },
    { version: 1, settings: { ...settings, human: 0 }, moves: [] },
    { version: 1, settings, moves: [null] }].forEach(saved => assert.throws(() => Core.restore(saved)));
});

test('三檔 AI 只能回傳合法走法；用盡搜尋預算仍有合法備援', () => {
  const game = Core.createGame();
  const legal = Core.legalMoves(Core.current(game).board, Core.RED);
  ['easy', 'normal', 'hard'].forEach(difficulty => {
    const move = Core.chooseMove(game, difficulty);
    assert.ok(legal.some(candidate => candidate.from === move.from && candidate.to === move.to));
  });
  const bounded = Core.chooseMove(game, 'hard', { maxNodes: 0, timeBudgetMs: 0 });
  assert.ok(Core.moveBoard(Core.current(game).board, Core.RED, bounded.from, bounded.to));
  assert.throws(() => Core.chooseMove(game, 'impossible'), /difficulty/);
});

test('所有難度優先走出立即獲勝的吃子步', () => {
  const board = emptyBoard();
  [0, 6, 14].forEach(point => { board[point] = Core.GREEN; });
  [2, 11, 12].forEach(point => { board[point] = Core.RED; });
  const game = Core.createGame();
  game.history[0].board = board;
  game.history[0].key = Core.positionKey(board, Core.RED);
  ['easy', 'normal', 'hard'].forEach(difficulty => {
    const move = Core.chooseMove(game, difficulty, { random: () => .99 });
    const next = Core.playMove(game, move.from, move.to);
    assert.equal(Core.current(next).winner, Core.RED);
    assert.equal(Core.current(next).reason, 'capture');
  });
});

test('AI 對戰不會產生無氣殘子，終局回傳 null，存檔可精確重播', () => {
  let seed = 937;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let game = Core.createGame();
  for (let i = 0; i < 180 && Core.current(game).status === 'active'; i++) {
    const move = Core.chooseMove(game, 'easy', { random });
    game = Core.playMove(game, move.from, move.to);
    const state = Core.current(game);
    state.board.forEach((stone, point) => {
      if (stone) assert.ok(Core.groupAt(state.board, point).liberties.length, '殘留無氣棋組');
    });
  }
  assert.deepEqual(Core.restore(Core.serialize(game)).game, game);
  if (Core.current(game).status === 'finished') assert.equal(Core.chooseMove(game), null);
});
