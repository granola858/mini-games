const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../games/nine-nine/nine-nine-core.js');

function createFixture({ rank, value = 0, playerCount = 3, difficulty = 'normal', direction = 1 }) {
  const game = Core.createGame({ playerCount, difficulty }, () => 0.25);
  const allCards = [
    ...game.players.flatMap(player => player.hand),
    ...game.drawPile,
    ...game.discardPile
  ];
  const targetIndex = allCards.findIndex(card => card.rank === rank && (rank !== 'A' || card.suit !== 'spades'));
  const targetCard = allCards.splice(targetIndex, 1)[0];
  game.players.forEach((player, index) => {
    const count = index === 0 ? 4 : 5;
    player.hand = index === 0
      ? [targetCard, ...allCards.splice(0, count)]
      : allCards.splice(0, count);
  });
  game.drawPile = allCards;
  game.discardPile = [];
  game.currentValue = value;
  game.direction = direction;
  game.currentPlayerId = 'p0';
  game.status = 'active';
  game.winnerId = null;
  game.lastAction = null;
  return game;
}

function withHands(hands, value = 99) {
  const game = Core.createGame({ playerCount: hands.length, handSize: hands[0].length }, () => 0.25);
  const cards = Core.createDeck();
  hands.forEach((ranks, index) => {
    game.players[index].hand = ranks.map(rank => {
      const cardIndex = cards.findIndex(card => card.id === rank
        || (card.rank === rank && (rank !== 'A' || card.suit !== 'spades')));
      assert.notEqual(cardIndex, -1, `Not enough ${rank} cards`);
      return cards.splice(cardIndex, 1)[0];
    });
  });
  game.drawPile = cards;
  game.currentValue = value;
  return game;
}

function playRank(game, rank, option) {
  const card = Core.getCurrentPlayer(game).hand.find(item => item.rank === rank);
  assert.ok(card, `No ${rank} in current player's hand`);
  const move = { cardId: card.id, ...option };
  return Core.applyMove(game, move, () => 0);
}

test('new games deal the configured four or five cards to 2–4 seats with exactly one human', () => {
  for (let count = 2; count <= 4; count += 1) {
    for (const handSize of [4, 5]) {
      const game = Core.createGame({ playerCount: count, handSize }, () => 0.4);
      assert.equal(game.players.length, count);
      assert.equal(game.handSize, handSize);
      assert.deepEqual(game.players.map(player => player.hand.length), Array(count).fill(handSize));
      assert.equal(game.players.filter(player => player.human).length, 1);
      assert.equal(game.players[0].human, true);
      assert.equal(game.drawPile.length, 52 - count * handSize);
      assert.ok(Core.normalizeGame(game));
    }
  }
  assert.throws(() => Core.createGame({ handSize: 3 }), /handSize/);
});

test('only the spade Ace offers +1 or reset, including +1 bust penalties', () => {
  const game = withHands([['spades-A', '2', '10', 'Q', 'K'], ['4', '5', '6', '7', '8']], 70);
  assert.deepEqual(Core.getAvailableMoves(game).filter(move => move.cardId === 'spades-A'), [
    { cardId: 'spades-A', choice: 'plus' }, { cardId: 'spades-A', choice: 'zero' }
  ]);
  assert.equal(playRank(game, 'A', { choice: 'plus' }).currentValue, 71);
  const reset = playRank(game, 'A', { choice: 'zero' });
  assert.equal(reset.currentValue, 0);
  assert.equal(reset.history.at(-1).choice, 'zero');
  assert.ok(Core.normalizeGame(reset));
  game.currentValue = 99;
  assert.equal(Core.resolveTurn(game).players[0].alive, true);
  assert.equal(Core.getSafeMoves(game).filter(move => move.cardId === 'spades-A').length, 1);
  const busted = playRank(game, 'A', { choice: 'plus' });
  assert.equal(busted.players[0].alive, false);
  assert.equal(busted.currentValue, 99);
  for (const suit of ['hearts', 'diamonds', 'clubs']) {
    const other = withHands([[suit + '-A', '2', '10', 'Q', 'K'], ['4', '5', '6', '7', '8']], 70);
    assert.deepEqual(Core.getAvailableMoves(other).filter(move => move.cardId === suit + '-A'), [
      { cardId: suit + '-A' }
    ]);
    assert.throws(() => Core.applyMove(other, { cardId: suit + '-A', choice: 'zero' }), /not legal/);
  }
});

test('A, number cards, 10, Q and K apply the public rules', () => {
  assert.equal(playRank(createFixture({ rank: 'A' }), 'A').currentValue, 1);
  assert.equal(playRank(createFixture({ rank: '8' }), '8').currentValue, 8);
  assert.equal(playRank(createFixture({ rank: '10' }), '10', { choice: 'minus' }).currentValue, -10);
  assert.equal(playRank(createFixture({ rank: 'Q', value: 50 }), 'Q', { choice: 'plus' }).currentValue, 70);
  assert.equal(playRank(createFixture({ rank: 'Q', value: 50 }), 'Q', { choice: 'minus' }).currentValue, 30);
  assert.equal(playRank(createFixture({ rank: 'K', value: 12 }), 'K').currentValue, 99);
});

test('4 reverses direction, 5 targets another live player, and J skips one player', () => {
  const reversed = playRank(createFixture({ rank: '4', playerCount: 3 }), '4');
  assert.equal(reversed.direction, -1);
  assert.equal(reversed.currentPlayerId, 'p2');

  const targeted = playRank(createFixture({ rank: '5', playerCount: 3 }), '5', { targetId: 'p2' });
  assert.equal(targeted.currentPlayerId, 'p2');

  const skipped = playRank(createFixture({ rank: 'J', playerCount: 3 }), 'J');
  assert.equal(skipped.currentPlayerId, 'p2');
});

test('tool bust options are rejected while ordinary bust cards remain playable', () => {
  const game = withHands([['A', '2', '10', 'Q', 'K'], ['4', '5', '6', '7', '8']], 90);
  const before = JSON.stringify(game);
  const moves = Core.getAvailableMoves(game);
  for (const rank of ['10', 'Q']) {
    const card = game.players[0].hand.find(item => item.rank === rank);
    assert.ok(!moves.some(move => move.cardId === card.id && move.choice === 'plus'));
    assert.ok(moves.some(move => move.cardId === card.id && move.choice === 'minus'));
    assert.throws(() => Core.applyMove(game, { cardId: card.id, choice: 'plus' }), /not legal/);
  }
  const at99 = withHands([['A', '2', '3', '6', '7'], ['4', '5', '8', '9', 'K']]);
  assert.equal(Core.getAvailableMoves(at99).length, 5);
  assert.deepEqual(Core.getSafeMoves(at99), []);
  assert.equal(JSON.stringify(game), before);
});

test('an accidental ordinary bust eliminates the player without drawing or changing the shared total', () => {
  for (const handSize of [4, 5]) {
    for (const playerCount of [2, 3, 4]) {
      const hands = Array.from({ length: playerCount }, (_, index) =>
        (index === 0 ? ['2', '10', 'Q', 'K', '4'] : ['J', '4', '5', '10', 'Q']).slice(0, handSize));
      const game = withHands(hands, 98);
      const next = playRank(game, '2');
      assert.equal(next.players[0].alive, false);
      assert.equal(next.players[0].hand.length, handSize - 1);
      assert.equal(next.drawPile.length, game.drawPile.length);
      assert.equal(next.currentValue, 98);
      assert.equal(next.lastAction.value, 100);
      assert.equal(next.lastAction.busted, true);
      assert.equal(next.history.at(-1).playerId, 'p0');
      assert.deepEqual(next.lastEliminatedIds, ['p0']);
      assert.equal(next.status, playerCount === 2 ? 'finished' : 'active');
      assert.equal(next.currentPlayerId, 'p1');
      assert.ok(Core.normalizeGame(next));
    }
  }
});

test('exactly 99 is allowed, with no lower clamp on subtraction', () => {
  const game = withHands([['A', '2', '10', 'Q', '4'], ['J', '5', '6', '7', 'K']], 89);
  assert.equal(playRank(game, '10', { choice: 'plus' }).currentValue, 99);
  assert.throws(() => playRank(game, 'Q', { choice: 'plus' }), /not legal/);
  const atZero = withHands([['A', '2', '10', 'Q', '4'], ['J', '5', '6', '7', 'K']], 0);
  assert.equal(playRank(atZero, 'Q', { choice: 'minus' }).currentValue, -20);
});

test('players with no safe move are automatically eliminated without changing the total or hand', () => {
  const game = withHands([
    ['K', '4', '5', '10', 'Q'],
    ['A', '2', '3', '6', '7'],
    ['A', '2', '3', '8', '9'],
    ['J', '4', '5', '10', 'Q']
  ], 55);
  const next = playRank(game, 'K');
  assert.deepEqual(next.lastEliminatedIds, ['p1', 'p2']);
  assert.deepEqual(next.players.map(player => player.alive), [true, false, false, true]);
  assert.equal(next.currentPlayerId, 'p3');
  assert.equal(next.currentValue, 99);
  assert.equal(next.turnNumber, 1);
  assert.deepEqual(next.players[1].hand, game.players[1].hand);
  assert.ok(Core.normalizeGame(next));
});

test('a blocked restored turn ends with the last survivor, not a self-destructive move', () => {
  const game = withHands([['A', '2', '3', '6', '7'], ['4', '5', '8', '9', 'K']]);
  for (const level of Core.DIFFICULTIES) assert.equal(Core.chooseMove(game, level), null);
  const next = Core.resolveTurn(game);
  assert.equal(next.status, 'finished');
  assert.equal(next.winnerId, 'p1');
  assert.equal(next.currentPlayerId, 'p1');
  assert.equal(next.currentValue, 99);
  assert.equal(next.players[0].hand.length, 5);
  assert.ok(Core.normalizeGame(next));
  assert.equal(game.players[0].alive, true, 'resolution must not mutate the source');
});

test('reverse, skip and target determine which blocked player is eliminated next', () => {
  for (const rank of ['4', 'J', '5']) {
    const game = withHands([
      ['4', 'J', '5', '10', 'Q'],
      ['A', '2', '3', '6', '7'],
      ['A', '2', '3', '8', '9'],
      ['K', '4', '5', '10', 'Q']
    ]);
    const next = playRank(game, rank, rank === '5' ? { targetId: 'p2' } : {});
    assert.deepEqual(next.lastEliminatedIds, rank === '4' ? [] : ['p2']);
    assert.equal(next.currentPlayerId, 'p3');
    assert.equal(next.players[1].alive, true, 'a skipped player must not be eliminated off-turn');
  }
});

test('the discard pile is recycled when the draw pile is empty without changing the count', () => {
  const game = createFixture({ rank: 'A', playerCount: 2 });
  const held = Core.getCurrentPlayer(game).hand;
  game.discardPile = game.drawPile.splice(0);
  const next = Core.applyMove(game, { cardId: held[0].id }, () => 0.5);
  assert.equal(Core.getPlayer(next, 'p0').hand.length, 5);
  assert.equal(next.currentValue, 1);
  assert.ok(Core.normalizeGame(next));
});

test('AI exposes three difficulty levels and returns a legal move', () => {
  const game = createFixture({ rank: 'A', playerCount: 3 });
  game.currentPlayerId = 'p1';
  for (const difficulty of Core.DIFFICULTIES) {
    const move = Core.chooseMove(game, difficulty, () => 0);
    assert.ok(Core.getAvailableMoves(game).some(candidate =>
      candidate.cardId === move.cardId
        && candidate.choice === move.choice
        && candidate.targetId === move.targetId));
  }
});

test('invalid moves and corrupted saves are rejected', () => {
  const game = createFixture({ rank: 'A' });
  assert.throws(() => Core.applyMove(game, { cardId: 'spades-K' }), /not legal/);
  assert.equal(Core.normalizeGame({}), null);
  const corrupted = JSON.parse(JSON.stringify(game));
  corrupted.players[1].hand[0] = corrupted.players[0].hand[0];
  assert.equal(Core.normalizeGame(corrupted), null);
  assert.deepEqual(Core.normalizePreferences({ playerCount: 99, difficulty: 'evil' }), {
    playerCount: 3,
    difficulty: 'normal',
    handSize: 5
  });
});

test('hand-size settings persist, validate and migrate legacy five-card saves', () => {
  assert.deepEqual(Core.normalizePreferences({ playerCount: 4, difficulty: 'hard', handSize: 4 }), {
    playerCount: 4, difficulty: 'hard', handSize: 4
  });
  assert.equal(Core.normalizePreferences({ handSize: 6 }).handSize, 5);
  const legacy = Core.createGame();
  delete legacy.handSize;
  assert.equal(Core.normalizeGame(legacy).handSize, 5);
  const four = Core.createGame({ handSize: 4 });
  assert.equal(Core.normalizeGame(JSON.parse(JSON.stringify(four))).handSize, 4);
  four.handSize = 5;
  assert.equal(Core.normalizeGame(four), null);
  four.handSize = 6;
  assert.equal(Core.normalizeGame(four), null);
});

test('history retains the last five cards with their owners and survives save/restore', () => {
  let game = Core.createGame({ playerCount: 3 }, () => 0.4);
  const played = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const move = Core.getSafeMoves(game).find(candidate => {
      const card = Core.getCurrentPlayer(game).hand.find(item => item.id === candidate.cardId);
      return card.rank !== 'K' && !candidate.targetId;
    });
    const owner = game.currentPlayerId;
    game = Core.applyMove(game, move, () => 0.4);
    assert.equal(game.lastAction.playerId, owner);
    played.push(game.lastAction);
    assert.deepEqual(game.history, played.slice(-5));
    assert.deepEqual(Core.normalizeGame(JSON.parse(JSON.stringify(game))).history, game.history);
  }
  const legacy = JSON.parse(JSON.stringify(game));
  delete legacy.history;
  delete legacy.lastEliminatedIds;
  assert.deepEqual(Core.normalizeGame(legacy).history, [game.lastAction]);
  const invalid = JSON.parse(JSON.stringify(game));
  invalid.history[0].playerId = 'p99';
  assert.equal(Core.normalizeGame(invalid), null);
  invalid.history = Array(6).fill(game.lastAction);
  assert.equal(Core.normalizeGame(invalid), null);
});

test('every AI difficulty only chooses safe moves near 99', () => {
  const game = withHands([['A', '2', '10', 'Q', 'K'], ['4', '5', '6', '7', '8']]);
  for (const level of Core.DIFFICULTIES) {
    for (let index = 0; index < 20; index += 1) {
      const move = Core.chooseMove(game, level, () => index / 20);
      assert.ok(['10', 'Q', 'K'].includes(game.players[0].hand.find(card => card.id === move.cardId).rank));
      if (move.choice) assert.equal(move.choice, 'minus');
      assert.ok(Core.applyMove(game, move).currentValue <= 99);
    }
  }
});

test('all AI levels finish deterministic games with 2–4 players', () => {
  for (let playerCount = 2; playerCount <= 4; playerCount += 1) {
    for (const handSize of [4, 5]) {
      for (const difficulty of Core.DIFFICULTIES) {
        let seed = 0x12345678 + playerCount * 101;
        const rng = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 0x100000000;
        };
        let game = Core.createGame({ playerCount, difficulty, handSize }, rng);
        let turns = 0;
        while (game.status === 'active' && turns < 20000) {
          const move = Core.chooseMove(game, difficulty, rng);
          assert.ok(move, `${playerCount} seats / ${difficulty} has no legal move`);
          game = Core.applyMove(game, move, rng);
          assert.ok(game.currentValue <= 99);
          assert.ok(Core.normalizeGame(game), 'Every intermediate state must be restorable');
          turns += 1;
        }
        assert.equal(game.status, 'finished', `${playerCount} seats / ${difficulty} failed to finish`);
        assert.ok(turns < 20000, 'The deterministic game exceeded the turn safety limit');
        assert.ok(Core.normalizeGame(game), 'Finished game failed save validation');
      }
    }
  }
});
