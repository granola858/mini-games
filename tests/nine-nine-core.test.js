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
  const targetIndex = allCards.findIndex(card => card.rank === rank);
  const targetCard = allCards.splice(targetIndex, 1)[0];
  let offset = 0;
  game.players.forEach((player, index) => {
    const count = index === 0 ? 4 : 5;
    player.hand = index === 0
      ? [targetCard, ...allCards.splice(offset, count)]
      : allCards.splice(offset, count);
    offset = 0;
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

function playRank(game, rank, option) {
  const card = Core.getCurrentPlayer(game).hand.find(item => item.rank === rank);
  assert.ok(card, `No ${rank} in current player's hand`);
  const move = { cardId: card.id, ...option };
  return Core.applyMove(game, move, () => 0);
}

test('new games deal five cards to 2–4 seats with exactly one human', () => {
  for (let count = 2; count <= 4; count += 1) {
    const game = Core.createGame({ playerCount: count }, () => 0.4);
    assert.equal(game.players.length, count);
    assert.deepEqual(game.players.map(player => player.hand.length), Array(count).fill(5));
    assert.equal(game.players.filter(player => player.human).length, 1);
    assert.equal(game.players[0].human, true);
    assert.equal(game.drawPile.length, 52 - count * 5);
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

test('playing above 99 eliminates the player without drawing and ends with the last survivor', () => {
  const busted = playRank(createFixture({ rank: '2', value: 98, playerCount: 2 }), '2');
  assert.equal(busted.players[0].alive, false);
  assert.equal(busted.players[0].hand.length, 4);
  assert.equal(busted.status, 'finished');
  assert.equal(busted.winnerId, 'p1');
  assert.equal(Core.normalizeGame(busted).status, 'finished');
});

test('the discard pile is recycled when the draw pile is empty without changing the count', () => {
  const game = createFixture({ rank: 'A', playerCount: 2 });
  const held = Core.getCurrentPlayer(game).hand;
  const returned = game.drawPile.splice(0, 1)[0];
  game.discardPile = [returned];
  game.drawPile = [];
  const next = Core.applyMove(game, { cardId: held[0].id }, () => 0.5);
  assert.equal(Core.getPlayer(next, 'p0').hand.length, 5);
  assert.equal(next.currentValue, 1);
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
    difficulty: 'normal'
  });
});

test('all AI levels finish deterministic games with 2–4 players', () => {
  for (let playerCount = 2; playerCount <= 4; playerCount += 1) {
    for (const difficulty of Core.DIFFICULTIES) {
      let seed = 0x12345678 + playerCount * 101;
      const rng = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      let game = Core.createGame({ playerCount, difficulty }, rng);
      let turns = 0;
      while (game.status === 'active' && turns < 20000) {
        const move = Core.chooseMove(game, difficulty, rng);
        assert.ok(move, `${playerCount} seats / ${difficulty} has no legal move`);
        game = Core.applyMove(game, move, rng);
        turns += 1;
      }
      assert.equal(game.status, 'finished', `${playerCount} seats / ${difficulty} failed to finish`);
      assert.ok(turns < 20000, 'The deterministic game exceeded the turn safety limit');
      assert.ok(Core.normalizeGame(game), 'Finished game failed save validation');
    }
  }
});
