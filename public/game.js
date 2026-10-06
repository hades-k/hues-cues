// Game rules, shared by the server (online rooms) and the browser (pass-and-play on one device).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HuesGame = factory();
})(this, function () {
  const COLS = 30;
  const ROWS = 16;
  const MAX_PLAYERS = 12;
  // The board game forbids naming the color outright.
  const BANNED_WORDS = new Set([
    'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'black', 'white', 'gray', 'grey',
  ]);

  function newRoom(extra) {
    return Object.assign(
      {
        code: '',
        players: [], // { id, name, score, connected }
        hostId: null,
        local: false, // one shared device: whoever holds it may do host actions
        phase: 'lobby', // lobby | cue1 | guess1 | cue2 | guess2 | reveal | gameover
        order: [],
        turn: 0,
        totalTurns: 0,
        card: null,
        target: null,
        cues: [],
        guesses: {},
        done: new Set(), // players who have guessed in the current guess phase
        roundScores: null,
      },
      extra,
    );
  }

  const giverId = (room) => room.order[room.turn % room.order.length];
  const getPlayer = (room, id) => room.players.find((p) => p.id === id);

  function cleanName(name) {
    return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, 16) : '';
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function drawCard() {
    const seen = new Set();
    const card = [];
    while (card.length < 4) {
      const r = Math.floor(Math.random() * ROWS);
      const c = Math.floor(Math.random() * COLS);
      if (seen.has(r * COLS + c)) continue;
      seen.add(r * COLS + c);
      card.push({ r, c });
    }
    return card;
  }

  function beginTurn(room) {
    // Skip cue givers who have dropped out.
    while (room.turn < room.totalTurns && !getPlayer(room, giverId(room))?.connected) room.turn++;
    if (room.turn >= room.totalTurns) {
      room.phase = 'gameover';
      return;
    }
    room.phase = 'cue1';
    room.card = drawCard();
    room.target = null;
    room.cues = [];
    room.guesses = {};
    room.done = new Set();
    room.roundScores = null;
  }

  function scoreRound(room) {
    const t = room.target;
    const scores = {};
    let giverPoints = 0;
    for (const [pid, guesses] of Object.entries(room.guesses)) {
      let points = 0;
      for (const g of guesses) {
        const d = Math.max(Math.abs(g.r - t.r), Math.abs(g.c - t.c));
        points += d === 0 ? 3 : d === 1 ? 2 : d === 2 ? 1 : 0;
        if (d <= 1) giverPoints++;
      }
      scores[pid] = points;
    }
    scores[giverId(room)] = giverPoints;
    for (const [pid, points] of Object.entries(scores)) {
      const p = getPlayer(room, pid);
      if (p) p.score += points;
    }
    room.roundScores = scores;
  }

  // Moves on once every connected guesser has locked in.
  function maybeAdvance(room) {
    if (room.phase !== 'guess1' && room.phase !== 'guess2') return;
    const giver = giverId(room);
    const needed = room.players.filter((p) => p.connected && p.id !== giver);
    if (!needed.length || !needed.every((p) => room.done.has(p.id))) return;
    room.done = new Set();
    if (room.phase === 'guess1') {
      room.phase = 'cue2';
    } else {
      scoreRound(room);
      room.phase = 'reveal';
    }
  }

  // What a given player is allowed to see.
  function view(room, pid) {
    const inRound = room.phase !== 'lobby' && room.phase !== 'gameover';
    const giver = inRound ? giverId(room) : null;
    const isGiver = pid === giver;
    const revealed = room.phase === 'reveal';
    const guesses = {};
    if (inRound) {
      for (const [id, g] of Object.entries(room.guesses)) {
        // Picks stay hidden from other players until everyone has locked in.
        guesses[id] = !revealed && id !== pid && room.done.has(id) ? g.slice(0, -1) : g;
      }
    }
    return {
      code: room.code,
      phase: room.phase,
      you: pid,
      hostId: room.local ? pid : room.hostId,
      giverId: giver,
      turn: Math.min(room.turn + 1, room.totalTurns),
      totalTurns: room.totalTurns,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        done: room.done.has(p.id),
      })),
      cues: inRound ? room.cues : [],
      card: inRound && isGiver ? room.card : null,
      target: inRound && (isGiver || revealed) ? room.target : null,
      guesses,
      roundScores: revealed ? room.roundScores : null,
    };
  }

  function parseCue(text, maxWords) {
    if (typeof text !== 'string') return { error: 'Type a cue first.' };
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { error: 'Type a cue first.' };
    if (words.length > maxWords) {
      return { error: maxWords === 1 ? 'The first cue must be a single word.' : 'The second cue can be at most two words.' };
    }
    for (const w of words) {
      if (w.length > 24 || !/^[\p{L}\p{N}'’-]+$/u.test(w)) return { error: 'Cues can only contain letters and numbers.' };
      if (BANNED_WORDS.has(w.toLowerCase())) return { error: `"${w}" is a basic color name — try something more creative.` };
    }
    return { cue: words.join(' ') };
  }

  // Applies a player's move. Returns null if the move is ignored, { error } if it is
  // rejected with a message, or {} if the room changed.
  function act(room, pid, m) {
    const isHost = room.local || room.hostId === pid;
    const inRound = room.phase !== 'lobby' && room.phase !== 'gameover';
    const isGiver = inRound && giverId(room) === pid;

    switch (m.t) {
      case 'start': {
        if (!isHost || room.phase !== 'lobby') return null;
        const active = room.players.filter((p) => p.connected);
        if (active.length < 2) return { error: 'You need at least 2 players to start.' };
        room.players = active;
        for (const p of room.players) p.score = 0;
        room.order = shuffle(active.map((p) => p.id));
        // As in the board game: fewer players means everyone gives cues more than once.
        room.totalTurns = room.order.length * (room.order.length >= 7 ? 1 : 2);
        room.turn = 0;
        beginTurn(room);
        return {};
      }
      case 'cue': {
        if (!isGiver) return null;
        if (room.phase === 'cue1') {
          const target = room.card[m.pick];
          if (!target) return { error: 'Pick one of your four colors first.' };
          const { cue, error } = parseCue(m.text, 1);
          if (error) return { error };
          room.target = target;
          room.cues = [cue];
          room.phase = 'guess1';
          return {};
        }
        if (room.phase === 'cue2') {
          const { cue, error } = parseCue(m.text, 2);
          if (error) return { error };
          room.cues.push(cue);
          room.phase = 'guess2';
          return {};
        }
        return null;
      }
      case 'guess': {
        if ((room.phase !== 'guess1' && room.phase !== 'guess2') || isGiver || room.done.has(pid)) return null;
        const { r, c } = m;
        if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
        const mine = (room.guesses[pid] ||= []);
        if (mine.some((g) => g.r === r && g.c === c)) return { error: 'You already have a marker there.' };
        mine.push({ r, c });
        room.done.add(pid);
        maybeAdvance(room);
        return {};
      }
      case 'next': {
        if (!isHost || room.phase !== 'reveal') return null;
        room.turn++;
        beginTurn(room);
        return {};
      }
      case 'skip': {
        if (!isHost || !inRound || room.phase === 'reveal') return null;
        room.turn++;
        beginTurn(room);
        return {};
      }
      case 'again': {
        if (!isHost || room.phase !== 'gameover') return null;
        room.phase = 'lobby';
        room.players = room.players.filter((p) => p.connected);
        for (const p of room.players) p.score = 0;
        return {};
      }
    }
    return null;
  }

  return { COLS, ROWS, MAX_PLAYERS, newRoom, giverId, getPlayer, cleanName, maybeAdvance, view, act };
});
