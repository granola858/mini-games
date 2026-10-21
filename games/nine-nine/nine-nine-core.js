// Pure Nine-Nine rules and AI. This module is usable in both the browser and Node tests.
const NineNineCore = (() => {
  'use strict';

  const SAVE_VERSION = 1;
  const SUITS = Object.freeze(['spades', 'hearts', 'diamonds', 'clubs']);
  const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
  const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);
  const HAND_SIZE = 5;
  const HAND_SIZES = Object.freeze([4, 5]);

  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

  function makeCard(suit, rank) {
    return { id: suit + '-' + rank, suit, rank };
  }

  function createDeck() {
    return SUITS.flatMap(suit => RANKS.map(rank => makeCard(suit, rank)));
  }

  function shuffled(cards, rng) {
    const result = cards.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const random = rng();
      if (typeof random !== 'number' || random < 0 || random >= 1) {
        throw new RangeError('rng must return a number in [0, 1)');
      }
      const j = Math.floor(random * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function createGame(options, rng) {
    const settings = options || {};
    const playerCount = settings.playerCount === undefined ? 3 : settings.playerCount;
    const difficulty = settings.difficulty || 'normal';
    const handSize = settings.handSize === undefined ? HAND_SIZE : settings.handSize;
    if (!isInteger(playerCount, 2, 4)) throw new RangeError('playerCount must be between 2 and 4');
    if (!DIFFICULTIES.includes(difficulty)) throw new RangeError('Unknown AI difficulty');
    if (!HAND_SIZES.includes(handSize)) throw new RangeError('handSize must be 4 or 5');

    const random = typeof rng === 'function' ? rng : Math.random;
    const deck = shuffled(createDeck(), random);
    const players = Array.from({ length: playerCount }, (_, index) => ({
      id: 'p' + index,
      name: index === 0 ? '你' : '電腦 ' + index,
      human: index === 0,
      alive: true,
      hand: deck.splice(0, handSize)
    }));

    return {
      version: SAVE_VERSION,
      matchId: settings.matchId || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)),
      playerCount,
      handSize,
      difficulty,
      players,
      drawPile: deck,
      discardPile: [],
      currentValue: 0,
      direction: 1,
      currentPlayerId: 'p0',
      turnNumber: 0,
      status: 'active',
      winnerId: null,
      lastAction: null,
      history: [],
      lastEliminatedIds: []
    };
  }

  function getPlayer(game, playerId) {
    return game.players.find(player => player.id === playerId) || null;
  }

  function getCurrentPlayer(game) {
    return getPlayer(game, game.currentPlayerId);
  }

  function activePlayers(game) {
    return game.players.filter(player => player.alive);
  }

  function getNextActive(game, playerId, steps) {
    const startIndex = game.players.findIndex(player => player.id === playerId);
    let index = startIndex;
    let remaining = steps;
    while (remaining > 0) {
      index = (index + game.direction + game.players.length) % game.players.length;
      if (game.players[index].alive) remaining -= 1;
    }
    return game.players[index];
  }

  function choicesForCard(game, player, card) {
    if (card.id === 'spades-A') {
      return [{ choice: 'plus' }, { choice: 'zero' }];
    }
    if (card.rank === '5') {
      return activePlayers(game)
        .filter(target => target.id !== player.id)
        .map(target => ({ targetId: target.id }));
    }
    if (card.rank === '10' || card.rank === 'Q') {
      return [{ choice: 'plus' }, { choice: 'minus' }]
        .filter(option => valueAfterCard(game.currentValue, card, option.choice) <= 99);
    }
    return [{}];
  }

  function valueAfterCard(value, card, choice) {
    if (card.id === 'spades-A' && choice === 'zero') return 0;
    if (card.rank === 'A') return value + 1;
    if (['2', '3', '6', '7', '8', '9'].includes(card.rank)) return value + Number(card.rank);
    if (card.rank === '10' || card.rank === 'Q') {
      return value + (choice === 'minus' ? -1 : 1) * (card.rank === '10' ? 10 : 20);
    }
    return card.rank === 'K' ? 99 : value;
  }

  function getAvailableMoves(game) {
    if (!game || game.status !== 'active') return [];
    const player = getCurrentPlayer(game);
    if (!player || !player.alive) return [];
    return player.hand.flatMap(card => choicesForCard(game, player, card)
      .map(option => Object.assign({ cardId: card.id }, option)));
  }

  function getSafeMoves(game) {
    const player = getCurrentPlayer(game);
    return getAvailableMoves(game).filter(move => {
      const card = player.hand.find(item => item.id === move.cardId);
      return valueAfterCard(game.currentValue, card, move.choice) <= 99;
    });
  }

  function findMove(game, move) {
    if (!isObject(move)) return null;
    return getAvailableMoves(game).find(candidate => candidate.cardId === move.cardId
      && candidate.choice === move.choice && candidate.targetId === move.targetId) || null;
  }

  function finishIfLastPlayer(game) {
    const remaining = activePlayers(game);
    if (remaining.length <= 1) {
      game.status = 'finished';
      game.winnerId = remaining.length === 1 ? remaining[0].id : null;
      game.currentPlayerId = game.winnerId;
      return true;
    }
    return false;
  }

  function eliminateBlockedPlayers(game) {
    while (game.status === 'active' && !getSafeMoves(game).length) {
      const player = getCurrentPlayer(game);
      player.alive = false;
      game.lastEliminatedIds.push(player.id);
      if (finishIfLastPlayer(game)) break;
      game.currentPlayerId = getNextActive(game, player.id, 1).id;
    }
    return game;
  }

  function resolveTurn(game) {
    const next = JSON.parse(JSON.stringify(game));
    next.lastEliminatedIds = [];
    return eliminateBlockedPlayers(next);
  }

  function refillHand(game, player, rng) {
    if (!game.drawPile.length) {
      if (!game.discardPile.length) return;
      game.drawPile = shuffled(game.discardPile, rng);
      game.discardPile = [];
    }
    if (game.drawPile.length) player.hand.push(game.drawPile.pop());
  }

  function applyMove(game, move, rng) {
    if (!game || game.status !== 'active') throw new Error('The game is not active');
    const legalMove = findMove(game, move);
    if (!legalMove) throw new Error('Move is not legal in the current position');

    const next = JSON.parse(JSON.stringify(game));
    const player = getCurrentPlayer(next);
    const cardIndex = player.hand.findIndex(card => card.id === legalMove.cardId);
    const card = player.hand.splice(cardIndex, 1)[0];
    next.discardPile.push(card);

    let skip = 0;
    let forcedTarget = null;
    const playedValue = valueAfterCard(next.currentValue, card, legalMove.choice);
    const busted = playedValue > 99;
    if (!busted) next.currentValue = playedValue;
    switch (card.rank) {
      case '4':
        next.direction *= -1;
        break;
      case '5':
        forcedTarget = legalMove.targetId;
        break;
      case 'J':
        skip = 1;
        break;
    }
    next.turnNumber += 1;
    next.lastAction = {
      playerId: player.id,
      card: card,
      choice: legalMove.choice || null,
      targetId: legalMove.targetId || null,
      value: playedValue,
      busted
    };
    next.history = [...(next.history || []), next.lastAction].slice(-5);
    next.lastEliminatedIds = [];
    if (busted) {
      player.alive = false;
      next.lastEliminatedIds.push(player.id);
      if (finishIfLastPlayer(next)) return next;
    } else {
      refillHand(next, player, typeof rng === 'function' ? rng : Math.random);
    }
    next.currentPlayerId = forcedTarget || getNextActive(next, player.id, 1 + skip).id;
    return eliminateBlockedPlayers(next);
  }

  function resultingMove(game, move) {
    const player = getCurrentPlayer(game);
    const card = player.hand.find(item => item.id === move.cardId);
    const value = valueAfterCard(game.currentValue, card, move.choice);
    let direction = game.direction;
    let nextPlayerId = null;
    if (card.rank === '4') direction *= -1;
    if (card.rank === '5') nextPlayerId = move.targetId;
    else {
      const copy = Object.assign({}, game, { direction });
      nextPlayerId = getNextActive(copy, player.id, card.rank === 'J' ? 2 : 1).id;
    }
    return { card, value, direction, nextPlayerId };
  }

  function getMoveScore(game, move, difficulty) {
    const result = resultingMove(game, move);
    if (result.value > 99) return -10000;

    const current = game.currentValue;
    const distanceFrom99 = 99 - result.value;
    let score = 0;
    const rank = result.card.rank;
    const isControl = ['4', '5', 'J'].includes(rank);
    const target = result.nextPlayerId && getPlayer(game, result.nextPlayerId);

    if (difficulty === 'easy') return Math.random();

    // Prefer reducing dangerous totals; otherwise push the next player toward 99.
    score += result.value >= 0
      ? (result.value > 78 ? result.value * 0.8 : result.value * 0.25)
      : result.value * 0.4;
    if (result.value >= 90) score -= (result.value - 89) * 3;
    if (current >= 78 && result.value < current) score += (current - result.value) * 1.8;
    if (isControl) score += current >= 82 ? 14 : -5;
    if (rank === 'K') score -= current >= 90 ? 18 : 7;

    if (target) {
      const targetHandFactor = target.hand.length <= 2 ? 5 : 0;
      score += (target.human ? 5 : 0) + targetHandFactor;
      if (target.human && result.value >= 82) score += 12;
    }

    if (difficulty === 'hard') {
      const player = getCurrentPlayer(game);
      const remainingControlCards = player.hand.filter(item => item.id !== result.card.id
        && ['4', '5', 'J'].includes(item.rank)).length;
      if (isControl && remainingControlCards === 0 && current < 75) score -= 8;
      if (current >= 85 && target && target.human) score += 10;
      if (result.value > 84 && result.value <= 99) score += (99 - distanceFrom99) * 0.25;
      if (target && target.hand.length <= 2) score += 9;
    }
    return score;
  }

  function chooseMove(game, difficulty, rng) {
    const level = DIFFICULTIES.includes(difficulty) ? difficulty : 'normal';
    const moves = getSafeMoves(game);
    if (!moves.length) return null;
    const random = typeof rng === 'function' ? rng : Math.random;
    if (level === 'easy') return moves[Math.floor(random() * moves.length)];
    let best = -Infinity;
    let candidates = [];
    for (const move of moves) {
      const score = getMoveScore(game, move, level);
      if (score > best) {
        best = score;
        candidates = [move];
      } else if (score === best) {
        candidates.push(move);
      }
    }
    return candidates[Math.floor(random() * candidates.length)];
  }

  function isCard(value) {
    return isObject(value) && typeof value.id === 'string'
      && SUITS.includes(value.suit) && RANKS.includes(value.rank)
      && value.id === value.suit + '-' + value.rank;
  }

  function normalizeGame(value) {
    if (!isObject(value)) return null;
    const handSize = value.handSize === undefined ? HAND_SIZE : value.handSize;
    if (value.version !== SAVE_VERSION
      || !HAND_SIZES.includes(handSize)
      || typeof value.matchId !== 'string' || !value.matchId
      || !isInteger(value.playerCount, 2, 4)
      || !DIFFICULTIES.includes(value.difficulty)
      || !Array.isArray(value.players) || value.players.length !== value.playerCount
      || !Array.isArray(value.drawPile) || !Array.isArray(value.discardPile)
      || !isInteger(value.turnNumber, 0, 1000000)
      || !Number.isInteger(value.currentValue) || value.currentValue > 120 || value.currentValue < -10000000
      || ![-1, 1].includes(value.direction)
      || !['active', 'finished'].includes(value.status)) return null;
    if (value.status === 'active' && value.currentValue > 99) return null;

    const ids = new Set();
    let humanCount = 0;
    for (let index = 0; index < value.players.length; index += 1) {
      const player = value.players[index];
      if (!isObject(player) || player.id !== 'p' + index
        || typeof player.name !== 'string' || typeof player.human !== 'boolean'
        || typeof player.alive !== 'boolean' || !Array.isArray(player.hand)) return null;
      if (player.alive && player.hand.length !== handSize) return null;
      if (player.hand.length > handSize) return null;
      if (player.human) humanCount += 1;
      for (const card of player.hand) {
        if (!isCard(card) || ids.has(card.id)) return null;
        ids.add(card.id);
      }
    }
    if (humanCount !== 1 || !value.players[0].human) return null;
    for (const card of [...value.drawPile, ...value.discardPile]) {
      if (!isCard(card) || ids.has(card.id)) return null;
      ids.add(card.id);
    }
    if (ids.size !== 52 || createDeck().some(card => !ids.has(card.id))) return null;

    const alive = activePlayers(value);
    if (value.status === 'active') {
      if (alive.length < 2 || !alive.some(player => player.id === value.currentPlayerId)
        || value.winnerId !== null) return null;
    } else if ((alive.length !== 1 && alive.length !== 0)
      || (alive.length === 1 && value.winnerId !== alive[0].id)
      || (alive.length === 0 && value.winnerId !== null)) return null;

    const validAction = action => isObject(action) && !!getPlayer(value, action.playerId)
      && isCard(action.card) && Number.isInteger(action.value)
      && [null, 'plus', 'minus', 'zero'].includes(action.choice)
      && (action.choice !== 'zero' || action.card.id === 'spades-A')
      && (action.busted === undefined || typeof action.busted === 'boolean')
      && (action.targetId === null || !!getPlayer(value, action.targetId));
    if (value.lastAction !== null && !validAction(value.lastAction)) return null;
    // Old saves only contain the last card; retain it instead of inventing missing history.
    const history = value.history === undefined
      ? (value.lastAction ? [value.lastAction] : [])
      : value.history;
    if (!Array.isArray(history) || history.length > 5 || !history.every(validAction)) return null;
    const eliminated = value.lastEliminatedIds === undefined ? [] : value.lastEliminatedIds;
    if (!Array.isArray(eliminated) || eliminated.length > value.playerCount
      || new Set(eliminated).size !== eliminated.length
      || eliminated.some(id => !getPlayer(value, id) || getPlayer(value, id).alive)) return null;
    return JSON.parse(JSON.stringify(Object.assign({}, value, { handSize, history, lastEliminatedIds: eliminated })));
  }

  function emptyStats() {
    return { games: 0, wins: 0, losses: 0, bestWinStreak: 0, currentWinStreak: 0 };
  }

  function normalizeStats(value) {
    const defaults = emptyStats();
    if (!isObject(value)) return defaults;
    for (const key of Object.keys(defaults)) {
      if (!isInteger(value[key], 0, 1000000)) return defaults;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function normalizePreferences(value) {
    if (!isObject(value)) return { playerCount: 3, difficulty: 'normal', handSize: HAND_SIZE };
    return {
      playerCount: isInteger(value.playerCount, 2, 4) ? value.playerCount : 3,
      handSize: HAND_SIZES.includes(value.handSize) ? value.handSize : HAND_SIZE,
      difficulty: DIFFICULTIES.includes(value.difficulty) ? value.difficulty : 'normal'
    };
  }

  return Object.freeze({
    SAVE_VERSION,
    SUITS,
    RANKS,
    DIFFICULTIES,
    HAND_SIZE,
    HAND_SIZES,
    createDeck,
    createGame,
    getPlayer,
    getCurrentPlayer,
    activePlayers,
    getAvailableMoves,
    getSafeMoves,
    applyMove,
    resolveTurn,
    chooseMove,
    normalizeGame,
    emptyStats,
    normalizeStats,
    normalizePreferences
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NineNineCore;
