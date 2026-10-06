const { COLS, ROWS } = HuesGame;
const ROW_LABELS = 'ABCDEFGHIJKLMNOP';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const coord = (r, c) => ROW_LABELS[r] + (c + 1);

// Hue runs left to right, light pastels at the top down to deep shades at the bottom.
function colorAt(r, c) {
  const t = (r + 0.5) / ROWS;
  const L = 0.93 - 0.6 * t;
  const C = 0.04 + 0.17 * Math.sin(Math.PI * t);
  const H = (20 + c * 12) % 360;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H})`;
}

// ---------- session ----------

function store(kind, key, value) {
  try {
    const s = kind === 'session' ? sessionStorage : localStorage;
    if (value === undefined) return s.getItem(key);
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {}
  return null;
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Per-tab id, so a reload (or a dropped phone connection) rejoins as the same player.
let pid = store('session', 'hc_pid');
if (!pid) {
  pid = newId();
  store('session', 'hc_pid', pid);
}
let myName = store('local', 'hc_name') || '';
let myCode = store('session', 'hc_code') || '';

let ws = null;
let local = null; // pass-and-play game on this device: { room, active, handoff }
let setup = false; // showing the pass-and-play player list
let state = null;
let selected = null; // pending guess, not yet locked in
let cardPick = null; // cue giver's chosen card option
let phaseKey = '';
let lastPanel = '';

// ---------- connection ----------

const openedAsFile = location.protocol === 'file:';

function connect() {
  if (openedAsFile) {
    // Opened straight from disk: there is no game server behind this page.
    const el = $('homeError');
    el.innerHTML = 'This page was opened as a file, so online games are unavailable (pass &amp; play still works). To play online, run <b>npm start</b> and open <a href="http://localhost:3000">http://localhost:3000</a>.';
    el.hidden = false;
    return;
  }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    $('offline').hidden = true;
    if (myCode && myName) send({ t: 'join', code: myCode, name: myName, pid });
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (local) return;
    if (m.t === 'state') {
      state = m.s;
      myCode = state.code;
      store('session', 'hc_code', myCode);
      if (location.hash.slice(1) !== myCode) history.replaceState(null, '', '#' + myCode);
      render();
    } else if (m.t === 'error') {
      if (m.fatal) {
        leave(false);
        showError('homeError', m.msg);
      } else {
        showError('toast', m.msg);
      }
    }
  };
  ws.onclose = () => {
    $('offline').hidden = false;
    setTimeout(connect, 1000);
  };
}

function send(msg) {
  if (local) return localAct(msg);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el.timer);
  el.timer = setTimeout(() => (el.hidden = true), 4000);
}

function leave(reconnect = true) {
  if (local) {
    local = null;
    state = null;
    store('session', 'hc_local', null);
    return render();
  }
  myCode = '';
  state = null;
  store('session', 'hc_code', null);
  history.replaceState(null, '', location.pathname);
  if (reconnect && ws) ws.close();
  render();
}

// ---------- board ----------

const cells = [];
let frame3, frame5;

function buildBoard() {
  const board = $('board');
  for (let c = 0; c < COLS; c++) {
    const l = document.createElement('div');
    l.className = 'lbl';
    l.textContent = c + 1;
    l.style.gridArea = `1 / ${c + 2}`;
    board.append(l);
  }
  for (let r = 0; r < ROWS; r++) {
    const l = document.createElement('div');
    l.className = 'lbl';
    l.textContent = ROW_LABELS[r];
    l.style.gridArea = `${r + 2} / 1`;
    board.append(l);
    cells.push([]);
    for (let c = 0; c < COLS; c++) {
      const b = document.createElement('button');
      b.className = 'cell';
      b.style.background = colorAt(r, c);
      b.style.gridArea = `${r + 2} / ${c + 2}`;
      b.dataset.r = r;
      b.dataset.c = c;
      b.setAttribute('aria-label', coord(r, c));
      board.append(b);
      cells[r].push(b);
    }
  }
  frame3 = document.createElement('div');
  frame3.id = 'frame3';
  frame5 = document.createElement('div');
  frame5.id = 'frame5';
  frame3.className = frame5.className = 'frame';
  board.append(frame5, frame3);

  board.addEventListener('click', (ev) => {
    const cell = ev.target.closest('.cell');
    if (!cell || !state) return;
    const r = +cell.dataset.r;
    const c = +cell.dataset.c;
    if (canGuess()) {
      selected = { r, c };
    } else if (state.phase === 'cue1' && state.card) {
      const i = state.card.findIndex((o) => o.r === r && o.c === c);
      if (i < 0) return;
      cardPick = i;
    } else {
      return;
    }
    render();
  });
}

function placeFrame(el, t, radius) {
  const r0 = Math.max(0, t.r - radius);
  const r1 = Math.min(ROWS - 1, t.r + radius);
  const c0 = Math.max(0, t.c - radius);
  const c1 = Math.min(COLS - 1, t.c + radius);
  el.style.gridArea = `${r0 + 2} / ${c0 + 2} / ${r1 + 3} / ${c1 + 3}`;
  el.hidden = false;
}

function me() {
  return state.players.find((p) => p.id === state.you);
}

function canGuess() {
  return (
    !!state &&
    (state.phase === 'guess1' || state.phase === 'guess2') &&
    state.giverId !== state.you &&
    !me()?.done
  );
}

function renderBoard() {
  const s = state;
  const show = s.phase !== 'lobby' && s.phase !== 'gameover' && !local?.handoff;
  $('boardWrap').hidden = !show;
  if (!show) return;

  const names = Object.fromEntries(s.players.map((p) => [p.id, p.name]));
  const marks = new Map();
  for (const [id, guesses] of Object.entries(s.guesses)) {
    for (const g of guesses) {
      const key = g.r * COLS + g.c;
      if (!marks.has(key)) marks.set(key, []);
      marks.get(key).push(id);
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = cells[r][c];
      cell.className = 'cell';
      cell.replaceChildren();
      cell.title = coord(r, c);
      const ids = marks.get(r * COLS + c);
      if (!ids) continue;
      const mk = document.createElement('span');
      mk.className = 'mk' + (ids.includes(s.you) ? ' mine' : '');
      mk.textContent = ids.length > 1 ? ids.length : (names[ids[0]] || '?').slice(0, 1).toUpperCase();
      cell.append(mk);
      cell.title = `${coord(r, c)} — ${ids.map((id) => names[id] || '?').join(', ')}`;
    }
  }

  if (s.phase === 'cue1' && s.card) {
    s.card.forEach((o, i) => cells[o.r][o.c].classList.add(i === cardPick ? 'sel' : 'card'));
  }
  if (selected && canGuess()) cells[selected.r][selected.c].classList.add('sel');

  frame3.hidden = frame5.hidden = true;
  if (s.target) {
    cells[s.target.r][s.target.c].classList.add('target');
    placeFrame(frame3, s.target, 1);
    placeFrame(frame5, s.target, 2);
  }
  $('board').classList.toggle('pickable', canGuess());
}

// ---------- panel ----------

const swatch = (o, cls = '') => `<span class="swatch ${cls}" style="background:${colorAt(o.r, o.c)}"></span>`;

function panelHTML() {
  const s = state;
  const isHost = s.hostId === s.you;
  const isGiver = s.giverId === s.you;
  const giver = s.players.find((p) => p.id === s.giverId);
  const gname = giver ? esc(giver.name) : '';
  const cues = s.cues.length
    ? `<div class="cues">${s.cues.map((c) => `<span class="cue">${esc(c)}</span>`).join('')}</div>`
    : '';
  const skip = isHost ? `<button class="link" data-action="skip">Skip this turn</button>` : '';
  const guessers = s.players.filter((p) => p.connected && p.id !== s.giverId);
  const waiting = `${guessers.filter((p) => p.done).length}/${guessers.length} locked in`;

  if (local?.handoff) {
    const guessing = s.phase === 'guess1' || s.phase === 'guess2';
    return `
      <div class="handoff">
        ${guessing ? cues : ''}
        <p>Pass the device to</p>
        <h2>${esc(me().name)}</h2>
        <p>${isGiver ? 'Cue giver — everyone else, look away!' : 'Your turn to guess.'}</p>
        <button class="primary" data-action="ready">I'm ${esc(me().name)} — show me</button>
      </div>`;
  }

  switch (s.phase) {
    case 'lobby':
      return `
        <h2>Invite your friends</h2>
        <p>They open this site on their own device and enter the code:</p>
        <div class="bigcode">${esc(s.code)}</div>
        ${
          isHost
            ? `<div class="row"><button class="primary" data-action="start" ${s.players.length < 2 ? 'disabled' : ''}>Start game</button>
               <p>${s.players.length < 2 ? 'Waiting for at least one more player…' : `${s.players.length} players ready`}</p></div>`
            : `<p>Waiting for the host to start the game…</p>`
        }`;

    case 'cue1':
      if (!isGiver) return `<h2>${gname} is picking a color…</h2><p>Get ready to guess from a one-word cue.</p>${skip}`;
      return `
        <h2>You're the cue giver! Pick one color to describe</h2>
        <div class="options">${s.card
          .map(
            (o, i) =>
              `<button class="option ${i === cardPick ? 'on' : ''}" data-action="pick" data-i="${i}">${swatch(o)}${coord(o.r, o.c)}</button>`,
          )
          .join('')}</div>
        <form class="row" data-action="cue">
          <input id="cueInput" maxlength="24" autocomplete="off" placeholder="One-word cue (no basic color names)">
          <button class="primary" ${cardPick === null ? 'disabled' : ''}>Give cue</button>
        </form>${skip}`;

    case 'cue2':
      if (!isGiver) return `${cues}<h2>${gname} is thinking of a second cue…</h2>${skip}`;
      return `
        ${cues}
        <h2>Now narrow it down ${swatch(s.target, 'sm')} ${coord(s.target.r, s.target.c)}</h2>
        <form class="row" data-action="cue">
          <input id="cueInput" maxlength="49" autocomplete="off" placeholder="Second cue: one or two words">
          <button class="primary">Give cue</button>
          <button type="button" data-action="endRound">No second cue — reveal</button>
        </form>${skip}`;

    case 'guess1':
    case 'guess2': {
      const nth = s.phase === 'guess1' ? 'first' : 'second';
      if (isGiver) return `${cues}<h2>Players are placing their ${nth} guess…</h2><p>${waiting}</p>${skip}`;
      if (me()?.done) return `${cues}<h2>Locked in!</h2><p>Waiting for the others — ${waiting}</p>${skip}`;
      return `
        ${cues}
        <h2>${local ? `${esc(me().name)}, place` : 'Place'} your ${nth} guess</h2>
        <div class="row">${
          selected
            ? `${swatch(selected)} <b>${coord(selected.r, selected.c)}</b> <button class="primary" data-action="lock">Lock in</button>`
            : `<p>Tap a color on the board.</p>`
        }</div>${skip}`;
    }

    case 'reveal': {
      const last = s.turn >= s.totalTurns;
      const rows = s.players
        .filter((p) => p.id in (s.roundScores || {}))
        .sort((a, b) => s.roundScores[b.id] - s.roundScores[a.id])
        .map((p) => {
          const where =
            p.id === s.giverId
              ? 'cue giver'
              : (s.guesses[p.id] || []).map((g) => `${swatch(g, 'sm')}${coord(g.r, g.c)}`).join(' ');
          return `<div class="result"><b>${esc(p.name)}</b><span class="where">${where}</span><span class="pts">+${s.roundScores[p.id]}</span></div>`;
        })
        .join('');
      return `
        ${cues}
        <h2>It was ${swatch(s.target)} ${coord(s.target.r, s.target.c)}</h2>
        <div class="results">${rows}</div>
        ${
          isHost
            ? `<div class="row"><button class="primary" data-action="next">${last ? 'See final scores' : 'Next round'}</button></div>`
            : `<p>Waiting for the host…</p>`
        }`;
    }

    case 'gameover': {
      const ranked = [...s.players].sort((a, b) => b.score - a.score);
      const top = ranked[0].score;
      const winners = ranked.filter((p) => p.score === top).map((p) => esc(p.name));
      return `
        <h2>🏆 ${winners.join(' & ')} ${winners.length > 1 ? 'win' : 'wins'}!</h2>
        <div class="results">${ranked
          .map((p, i) => `<div class="result"><span>${i + 1}.</span><b>${esc(p.name)}</b><span class="pts">${p.score}</span></div>`)
          .join('')}</div>
        ${isHost ? `<div class="row"><button class="primary" data-action="again">Play again</button></div>` : `<p>Waiting for the host…</p>`}`;
    }
  }
  return '';
}

function renderPlayers() {
  const s = state;
  $('players').innerHTML = s.players
    .map((p) => {
      const tags = [];
      if (p.id === s.hostId && !local) tags.push('host');
      if (p.id === s.giverId) tags.push('🎨 cue giver');
      else if (p.done) tags.push('✓');
      if (!p.connected) tags.push('offline');
      return `<div class="player ${p.id === s.you ? 'me' : ''} ${p.connected ? '' : 'off'}">
        <b>${esc(p.name)}</b>${s.phase === 'lobby' ? '' : `<span class="score">${p.score}</span>`}
        <span class="tag">${tags.join(' · ')}</span></div>`;
    })
    .join('');
}

function render() {
  $('home').hidden = !!state || setup;
  $('local').hidden = !!state || !setup;
  $('game').hidden = !state;
  if (!state) return;

  const key = `${state.turn}:${state.phase}:${state.you}`;
  if (key !== phaseKey) {
    phaseKey = key;
    selected = null;
    cardPick = null;
  }

  $('roomCode').textContent = state.code;
  $('shareBtn').hidden = !!local;
  const inRound = state.phase !== 'lobby' && state.phase !== 'gameover';
  $('turnInfo').textContent = inRound ? `Round ${state.turn} of ${state.totalTurns}` : '';

  const html = panelHTML();
  if (html !== lastPanel) {
    // Keep whatever the cue giver has typed so far across re-renders.
    const typed = $('cueInput')?.value;
    const hadFocus = document.activeElement?.id === 'cueInput';
    $('panel').innerHTML = html;
    lastPanel = html;
    const input = $('cueInput');
    if (input && typed) input.value = typed;
    if (input && hadFocus) input.focus();
  }
  renderBoard();
  renderPlayers();
}

// ---------- events ----------

$('panel').addEventListener('click', (ev) => {
  const el = ev.target.closest('button[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'ready') {
    local.handoff = false;
    saveLocal();
    render();
  } else if (action === 'pick') {
    cardPick = +el.dataset.i;
    render();
  } else if (action === 'lock') {
    if (selected) send({ t: 'guess', r: selected.r, c: selected.c });
  } else {
    send({ t: action });
  }
});

$('panel').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (ev.target.dataset.action !== 'cue') return;
  send({ t: 'cue', pick: cardPick, text: $('cueInput').value });
});

// ---------- pass & play on one device ----------

function saveLocal() {
  store('session', 'hc_local', JSON.stringify({ ...local, room: { ...local.room, done: [...local.room.done] } }));
}

function loadLocal() {
  try {
    const saved = JSON.parse(store('session', 'hc_local'));
    if (!saved) return;
    saved.room.done = new Set(saved.room.done);
    local = saved;
    state = HuesGame.view(local.room, local.active);
  } catch {}
}

function localAct(m) {
  const room = local.room;
  // There is no lobby on a shared device: playing again restarts straight away.
  if (m.t === 'again') {
    HuesGame.act(room, local.active, m);
    m = { t: 'start' };
  }
  const before = room.phase;
  const result = HuesGame.act(room, local.active, m);
  if (!result) return;
  if (result.error) return showError('toast', result.error);

  // Work out who needs the device next.
  const giver = HuesGame.giverId(room);
  let holder = local.active;
  if (room.phase === 'cue1' || room.phase === 'cue2') {
    holder = giver;
  } else if (room.phase === 'guess1' || room.phase === 'guess2') {
    holder = room.players.find((p) => p.id !== giver && !room.done.has(p.id))?.id ?? holder;
  }
  if (holder !== local.active || (room.phase === 'cue1' && before !== 'cue1')) local.handoff = true;
  local.active = holder;
  saveLocal();
  state = HuesGame.view(room, holder);
  render();
}

function addNameInput(value = '') {
  const box = $('localNames');
  if (box.children.length >= HuesGame.MAX_PLAYERS) return;
  const input = document.createElement('input');
  input.maxLength = 16;
  input.autocomplete = 'off';
  input.placeholder = `Player ${box.children.length + 1}`;
  input.value = value;
  box.append(input);
  $('addPlayerBtn').hidden = box.children.length >= HuesGame.MAX_PLAYERS;
}

$('localBtn').addEventListener('click', () => {
  setup = true;
  if (!$('localNames').children.length) {
    addNameInput($('nameInput').value.trim());
    addNameInput();
    addNameInput();
  }
  render();
});
$('addPlayerBtn').addEventListener('click', () => addNameInput());
$('backBtn').addEventListener('click', () => {
  setup = false;
  render();
});
$('startLocalBtn').addEventListener('click', () => {
  const names = [...$('localNames').children].map((i) => HuesGame.cleanName(i.value)).filter(Boolean);
  if (names.length < 2) return showError('localError', 'Enter at least 2 player names.');
  const room = HuesGame.newRoom({ local: true, code: 'LOCAL' });
  room.players = names.map((name, i) => ({ id: 'p' + i, name, score: 0, connected: true }));
  local = { room, active: 'p0', handoff: false };
  setup = false;
  localAct({ t: 'start' });
});

function enter(create) {
  if (openedAsFile) return;
  if (!ws || ws.readyState !== 1) return showError('homeError', 'Not connected to the game server yet — is it running?');
  myName = $('nameInput').value.trim();
  if (!myName) return showError('homeError', 'Enter your name first.');
  store('local', 'hc_name', myName);
  if (create) return send({ t: 'create', name: myName, pid });
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return showError('homeError', 'Enter the 4-letter room code.');
  send({ t: 'join', code, name: myName, pid });
}

$('createBtn').addEventListener('click', () => enter(true));
$('joinBtn').addEventListener('click', () => enter(false));
$('codeInput').addEventListener('keydown', (ev) => ev.key === 'Enter' && enter(false));
$('leaveBtn').addEventListener('click', () => leave());
$('shareBtn').addEventListener('click', async () => {
  const link = `${location.origin}/#${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    showError('toast', 'Invite link copied!');
  } catch {
    prompt('Share this link:', link);
  }
});

$('nameInput').value = myName;
// An invite link carries the room code in the hash.
if (!myCode && /^#[A-Za-z]{4}$/.test(location.hash)) $('codeInput').value = location.hash.slice(1).toUpperCase();

buildBoard();
loadLocal();
render();
connect();
