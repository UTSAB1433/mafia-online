'use strict';
/*
 * MAFIA ONLINE — server
 * Zero dependencies. Node 18+.
 *
 * The server IS the moderator: it deals roles, runs the night/day cycle, resolves actions,
 * counts votes and decides who wins. Players only ever receive the information their role
 * is allowed to see.
 *
 * Transport: Server-Sent Events (server -> client) + JSON POST (client -> server).
 * Voice: browsers connect to each other with WebRTC; this server only relays the signaling,
 * and tells each client who it may talk to / listen to in the current phase.
 *
 * Nobody is ever kicked for lag. Ping is measured and shown; a slow or dropped player keeps
 * their seat and is waited for. They can rejoin with the same browser at any time.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const FAST = process.env.FAST === '1';                      // used by the automated test only
const MIN_PLAYERS = +process.env.MIN_PLAYERS || (FAST ? 4 : 5);
const MAX_PLAYERS = 15;
const HIGH_MS = 250;                                        // "high ping" threshold
const STALE_MS = 8000;                                      // no heartbeat for this long = unstable connection
const GRACE_MS = 15000;                                     // extra wait for lagging players (once per phase)
const T = s => (FAST ? 1 : s);

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
if (process.env.TURN_URL) {
  ICE.push({ urls: process.env.TURN_URL.split(',').map(s => s.trim()), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
}

const DEFAULTS = { reveal: true, selfHeal: true, tie: 'none', nightSec: 60, daySec: 150, voteSec: 45,
  announceSave: true, mafiaAuto: true, mafiaCount: 2, doctor: true, detective: true,
  godfather: true, bodyguard: false, vigilante: false, jester: false, serialkiller: false };
const COLORS = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#a06cd5', '#f08a4b', '#3a86ff', '#ef476f', '#06d6a0', '#c77dff', '#f4a261', '#4cc9f0', '#b5838d', '#90be6d', '#ff9f1c'];

const rooms = new Map();
const isM = p => p.role === 'mafia' || p.role === 'godfather';
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString('hex');
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickOne = a => a[crypto.randomInt(a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v) || lo));

/* ------------------------------------------------------------------ player condition (foundation for Phase 1+)
 * Every player has a `condition` alongside the legacy `alive` boolean. `alive` stays in sync
 * (alive === condition !== 'dead') so nothing that already reads `alive` needs to change.
 * Phase 1 (attack outcomes) will start writing 'mediocre' / 'critical' instead of jumping
 * straight to 'dead'; nothing does that yet, so behavior today is unchanged.
 */
const CONDITIONS = ['good', 'mediocre', 'critical', 'dead'];
function setCondition(p, cond) {
  if (!CONDITIONS.includes(cond)) throw new Error(`Unknown condition: ${cond}`);
  p.condition = cond;
  p.alive = cond !== 'dead';       // keep every existing `alive`-based check correct
}

/* ------------------------------------------------------------------ case file (Phase 2)
 * A room-scoped, append-only, publicly-visible record — every living AND dead player sees the
 * same entries (this is deliberately not secret info like a role or a condition). Populated two
 * ways: automatically, for already-public events (deaths, injuries, vote outcomes — see
 * resolveNight() and tally()), and by player action, via the 'claim' and 'respond' handlers below.
 * Reset every startGame() so it never carries over between games in the same room.
 */
function newCaseFile() { return { entries: [] }; }
function addCaseEntry(room, entry) {
  const e = { id: rid(4), ts: now(), ...entry };
  room.caseFile.entries.push(e);
  return e;
}

/* ------------------------------------------------------------------ clue pipeline (foundation for Phase 1+)
 * A single, tunable source of "how much does this event reveal?" so the newspaper,
 * Detective, and Watcher (added in later phases) all draw from the same weighted logic
 * instead of each system inventing its own probability. Nothing calls this yet.
 */
const CLUE_TIERS = ['clear', 'weak', 'indirect', 'ambiguous', 'none'];
const DEFAULT_CLUE_WEIGHTS = { clear: 0.30, weak: 0.25, indirect: 0.20, ambiguous: 0.15, none: 0.10 };
function pickWeighted(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [key, w] of entries) { r -= w; if (r <= 0) return key; }
  return entries.length ? entries[entries.length - 1][0] : 'none';
}
// context: { kind: string, weights?: partial override of DEFAULT_CLUE_WEIGHTS }
// returns: { tier, kind } — callers attach their own tier-specific wording.
function generateClue(context = {}) {
  const weights = { ...DEFAULT_CLUE_WEIGHTS, ...(context.weights || {}) };
  return { tier: pickWeighted(weights), kind: context.kind || 'general' };
}

/* ------------------------------------------------------------------ attack outcomes (Phase 1)
 * A resolved attack lands on one of four tiers instead of an automatic kill. 'fail' leaves the
 * target's condition untouched; the other three write straight onto the condition system above.
 * Doctor protection softens the roll by one tier rather than guaranteeing a save outright.
 */
const ATTACK_OUTCOME_WEIGHTS = { dead: 0.55, critical: 0.25, mediocre: 0.12, fail: 0.08 };
const STRONG_ATTACK_OUTCOME_WEIGHTS = { dead: 0.75, critical: 0.20, mediocre: 0.05, fail: 0 };   // resolved delayed attacks
const OUTCOME_ORDER = ['dead', 'critical', 'mediocre', 'fail'];
function rollAttackOutcome(target, opts = {}) {
  const weights = { ...(opts.strong ? STRONG_ATTACK_OUTCOME_WEIGHTS : ATTACK_OUTCOME_WEIGHTS) };
  if (target.condition === 'mediocre') weights.dead = (weights.dead || 0) + 0.15;   // already hurt = more vulnerable
  if (target.condition === 'critical') weights.dead = (weights.dead || 0) + 0.35;
  return pickWeighted(weights);
}
function softenOutcome(tier) {                                   // shift one step toward surviving unharmed
  const i = OUTCOME_ORDER.indexOf(tier);
  return OUTCOME_ORDER[Math.min(OUTCOME_ORDER.length - 1, i + 1)];
}
// Public wording for a death/critical-injury report, gated by how much the clue pipeline decided to reveal.
// The victim's name is always public (a body/injury is discovered); the attacker/method is not.
function attackPublicNote(t, tier, clueTier, src) {
  const headline = tier === 'dead' ? `${t.name} was found dead` : `${t.name} was found badly hurt`;
  switch (clueTier) {
    case 'clear': return `${headline}. Evidence points clearly to ${src}.`;
    case 'weak': return `${headline}. There are signs it may have been ${src}.`;
    case 'indirect': return `${headline} under suspicious circumstances.`;
    case 'ambiguous': return `${headline}. What happened is unclear.`;
    default: return `${headline}.`;
  }
}

/* ------------------------------------------------------------------ Mafia action menu (Phase 1)
 * Every Mafia member submits a preferred {action, target}; the team's action for the night is
 * whichever (action, target) pair the most teammates picked (ties broken at random) — the same
 * plurality rule the old kill-target vote already used, just generalized to more than one verb.
 * 'attack' and 'delayed_attack' are mutually exclusive with an in-flight countdown; 'frame' and
 * 'sabotage' each carry their own cooldown so a powerful move always has an opportunity cost.
 */
const MAFIA_ACTIONS = ['attack', 'delayed_attack', 'frame', 'sabotage', 'observe', 'wait'];
const MAFIA_TARGETED_ACTIONS = ['attack', 'delayed_attack', 'frame', 'observe'];
const FRAME_COOLDOWN_NIGHTS = 2;
const SABOTAGE_COOLDOWN_NIGHTS = 1;
const DELAYED_ATTACK_NIGHTS = 2;
function mafiaActionsAvailable(room) {
  const avail = ['wait', 'observe'];
  if (!room.mafiaCountdown) avail.push('attack', 'delayed_attack');   // can't stack two lethal plans at once
  if (room.night >= (room.mafiaCooldowns.frame || 0)) avail.push('frame');
  if (room.night >= (room.mafiaCooldowns.sabotage || 0)) avail.push('sabotage');
  return avail;
}
// Used on night `n`, blocked for `blockedNights` full nights, available again after that.
// e.g. nextCooldownNight(3, 2) => 6: unavailable on nights 4 and 5, available again on night 6.
function nextCooldownNight(n, blockedNights) { return n + blockedNights + 1; }

/* ------------------------------------------------------------------ rooms & players */
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = ''; for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
function newPlayer(room, name, gender) {
  const used = new Set([...room.players.values()].map(p => p.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[room.players.size % COLORS.length];
  const p = { id: rid(4), token: rid(16), name, gender: ['male', 'female', 'neutral'].includes(gender) ? gender : 'neutral', color,
    connected: false, res: null, lastSeen: now(), lostAt: 0, lostNotice: false, ping: null, highNoticeAt: 0,
    alive: true, condition: 'good', role: null, bullets: 0, left: false, ready: false, det: [], chatTimes: [], sigTimes: [], sigQueue: [], claimTimes: [] };
  room.players.set(p.id, p); room.order.push(p.id);
  return p;
}
function createRoom(name, gender) {
  const code = makeCode();
  const room = { code, players: new Map(), order: [], hostId: null, phase: 'lobby', settings: { ...DEFAULTS }, night: 0,
    timer: null, phaseStart: now(), phaseEnd: 0, extended: false, picks: {}, votes: {}, voteCands: [], voteRound: 1,
    dawn: null, result: null, winner: null, log: [], chat: [], lastActive: now(), jesterWin: null,
    caseFile: newCaseFile(), evidence: [],
    mafiaCooldowns: {}, mafiaCountdown: null, mafiaFrames: [], sabotageActiveNight: 0 };
  const p = newPlayer(room, name, gender);
  room.hostId = p.id;
  rooms.set(code, room);
  return { room, p };
}

/* ------------------------------------------------------------------ messaging */
function send(p, ev, data) {
  if (!p.res) return;
  try { p.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* connection gone; close handler will clean up */ }
}
function pushState(room) { for (const p of room.players.values()) if (p.res) send(p, 'state', view(room, p)); }
function pingsPayload(room) {
  const o = {};
  for (const p of room.players.values()) o[p.id] = { ms: p.ping, c: p.connected && !p.left, st: p.connected && now() - p.lastSeen > STALE_MS, left: p.left };
  return o;
}
function pushPings(room) { const d = pingsPayload(room); for (const p of room.players.values()) if (p.res) send(p, 'pings', d); }

function chatChannel(room, p) {              // where can this player talk right now?
  const ph = room.phase;
  if (ph === 'lobby' || ph === 'over' || ph === 'reveal') return 'all';
  if (p.left) return null;
  if (!p.alive) return 'dead';
  if (ph === 'night') return isM(p) ? 'mafia' : null;
  return 'all';
}
function canSee(room, p, m) {
  if (m.ch === 'sys' || m.ch === 'all') return true;
  if (room.phase === 'over') return true;
  if (m.ch === 'mafia') return p.alive && isM(p);
  if (m.ch === 'dead') return !p.alive;
  return false;
}
function addChat(room, m) {
  m.id = rid(4); m.ts = now();
  room.chat.push(m); if (room.chat.length > 150) room.chat.shift();
  for (const p of room.players.values()) if (p.res && canSee(room, p, m)) send(p, 'chat', m);
}
function sys(room, text) { addChat(room, { ch: 'sys', text }); }

function voicePolicy(room, p) {
  const others = [...room.players.values()].filter(q => q.id !== p.id && !q.left);
  const ph = room.phase;
  if (ph === 'lobby' || ph === 'over' || ph === 'reveal') { const all = others.map(q => q.id); return { to: all, from: all }; }
  if (ph === 'night') {
    if (p.alive && isM(p)) { const m = others.filter(q => q.alive && isM(q)).map(q => q.id); return { to: m, from: m }; }
    return { to: [], from: [] };
  }
  if (p.alive) { const a = others.filter(q => q.alive).map(q => q.id); return { to: a, from: a }; }
  return { to: others.filter(q => !q.alive).map(q => q.id), from: others.map(q => q.id) };   // ghosts hear everyone, speak only to ghosts
}

/* ------------------------------------------------------------------ views (what each player may know) */
function nightKind(p) {
  if (isM(p)) return 'mafia';
  if (['doctor', 'bodyguard', 'detective', 'serialkiller'].includes(p.role)) return p.role;
  if (p.role === 'vigilante' && p.bullets > 0) return 'vigilante';
  return 'decoy';
}
function optionsFor(room, p, kind) {
  const alive = [...room.players.values()].filter(x => x.alive);
  if (kind === 'decoy') return [];
  if (kind === 'mafia') return alive.filter(x => !isM(x)).map(x => x.id);
  if (kind === 'doctor' && room.settings.selfHeal) return alive.map(x => x.id);
  return alive.filter(x => x.id !== p.id).map(x => x.id);
}
function visibleRole(room, viewer, q) {
  if (room.phase === 'lobby') return null;
  if (q.id === viewer.id) return q.role;
  if (room.phase === 'over') return q.role;
  if (!q.alive && (room.settings.reveal || q.role === 'jester')) return q.role;
  if (isM(viewer) && isM(q)) return q.role;
  return null;
}
function view(room, p) {
  const inGame = room.phase !== 'lobby';
  const v = {
    now: now(), game: room.gameNo || 0, code: room.code, phase: room.phase, phaseStart: room.phaseStart, phaseEnd: room.phaseEnd, night: room.night,
    settings: room.settings, hostId: room.hostId, meId: p.id, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, highMs: HIGH_MS,
    players: room.order.map(id => {
      const q = room.players.get(id);
      return { id: q.id, name: q.name, gender: q.gender, color: q.color, alive: q.alive, host: q.id === room.hostId,
        connected: q.connected && !q.left, left: q.left, ping: q.ping, stale: q.connected && now() - q.lastSeen > STALE_MS,
        role: inGame ? visibleRole(room, p, q) : null, ready: room.phase === 'day' ? q.ready : false };
    }),
    you: { role: p.role, alive: p.alive, condition: p.condition, bullets: p.bullets, det: p.det, action: null },
    channel: chatChannel(room, p), voice: voicePolicy(room, p), caseFile: room.caseFile.entries
  };
  if (room.phase === 'night' && p.alive) {
    const kind = nightKind(p);
    const sel = room.picks[p.id];
    const a = { kind, options: optionsFor(room, p, kind), selected: sel === undefined ? null : sel, locked: kind === 'detective' && sel != null };
    if (kind === 'mafia') {
      a.actions = mafiaActionsAvailable(room);
      a.countdown = room.mafiaCountdown;
      a.team = {};
      for (const q of room.players.values()) if (q.alive && isM(q) && room.picks[q.id] !== undefined) a.team[q.id] = room.picks[q.id];
    }
    v.you.action = a;
  }
  if (room.phase === 'lobby') v.plan = planInfo(room);
  if (room.phase === 'day') {
    const el = [...room.players.values()].filter(q => q.alive && q.connected && !q.left);
    v.ready = { count: el.filter(q => q.ready).length, need: Math.floor(el.length / 2) + 1 };
  }
  if (room.phase === 'vote') v.vote = { cands: room.voteCands, votes: room.votes, round: room.voteRound };
  if (room.phase === 'dawn') v.dawn = { deaths: room.dawn.deaths, injured: room.dawn.injured, saves: room.settings.announceSave ? room.dawn.saves : [], notice: room.dawn.notices[p.id] || null };
  if (room.phase === 'result') v.result = room.result;
  if (room.phase === 'over') {
    v.winner = room.winner;
    v.recap = { roster: room.order.map(id => { const q = room.players.get(id); return { id, name: q.name, role: q.role, alive: q.alive }; }), log: room.log };
  }
  return v;
}

/* ------------------------------------------------------------------ game engine (the moderator) */
/*
 * Role plan (what the host controls in the lobby):
 *  - Doctor is in by default; the host can switch it off.
 *  - Detective is only in the game when there are 2 or more Mafia (and the host has not switched it off).
 *  - Mafia count is auto-balanced by default; the host can choose it instead (1 to 3). It is always kept low enough
 *    that the Mafia cannot already control the vote at the start. The Mafia team makes 1 kill per night.
 *  - Godfather (if on) is one of the Mafia, so it needs 2+ Mafia.
 *  - Optional roles are added only if there is room for them.
 */
const MAX_MAFIA = 3;                                             // never more than 3 Mafia
const maxTeam = n => Math.max(1, Math.min(MAX_MAFIA, Math.floor((n - 1) / 2)));
const autoTeam = n => Math.min(MAX_MAFIA, Math.max(1, Math.floor((n + 2) / 4)));
const teamFor = (n, s) => s.mafiaAuto ? Math.min(autoTeam(n), maxTeam(n)) : Math.max(1, Math.min(maxTeam(n), Math.round(+s.mafiaCount) || 1));
function composePlan(n, s) {
  const team = teamFor(n, s), roles = []; let mafia = team;
  if (s.godfather && team >= 2) { roles.push('godfather'); mafia--; }
  for (let i = 0; i < mafia; i++) roles.push('mafia');
  if (s.doctor) roles.push('doctor');
  const optional = [];
  if (s.detective && team >= 2) optional.push('detective');
  if (s.bodyguard && n >= 8) optional.push('bodyguard');
  if (s.vigilante && n >= 8) optional.push('vigilante');
  if (s.jester && n >= 7) optional.push('jester');
  if (s.serialkiller && n >= 9) optional.push('serialkiller');
  for (const r of optional) if (roles.length < n) roles.push(r);
  while (roles.length < n) roles.push('villager');
  return roles.slice(0, n);
}
function planInfo(room) {
  const n = [...room.players.values()].filter(p => !p.left).length;
  const counts = {}; composePlan(n, room.settings).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  return { n, team: teamFor(n, room.settings), autoTeam: Math.min(autoTeam(n), maxTeam(n)), maxTeam: maxTeam(n), counts };
}
const composeRoles = (n, s) => shuffle(composePlan(n, s));
function setDeadline(room, at) {
  room.phaseEnd = at;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => onDeadline(room), Math.max(0, at - now()));
}
function setPhase(room, phase, sec) {
  room.phase = phase; room.phaseStart = now(); room.extended = false;
  for (const p of room.players.values()) p.ready = false;
  setDeadline(room, now() + sec * 1000);
  pushState(room);
}
function startGame(room) {
  const seated = [...room.players.values()].filter(p => !p.left);
  const roles = composeRoles(seated.length, room.settings);
  seated.forEach((p, i) => { p.role = roles[i]; setCondition(p, 'good'); p.bullets = p.role === 'vigilante' ? 1 : 0; p.det = []; p.detCounts = {}; });
  room.gameNo = (room.gameNo || 0) + 1;
  room.night = 0; room.log = []; room.winner = null; room.jesterWin = null; room.dawn = null; room.result = null;
  room.mafiaCooldowns = {}; room.mafiaCountdown = null; room.mafiaFrames = []; room.sabotageActiveNight = 0;
  room.caseFile = newCaseFile();
  sys(room, 'The roles have been dealt. Check yours.');
  setPhase(room, 'reveal', T(12));
}
function startNight(room) {
  room.night++; room.picks = {};
  setPhase(room, 'night', room.settings.nightSec);
}
function requiredActors(room) {
  const list = [...room.players.values()].filter(p => p.alive && !p.left);
  if (room.phase === 'night') return list.filter(p => nightKind(p) !== 'decoy');
  if (room.phase === 'vote') return list;
  return [];
}
function acted(room, p) {
  if (room.phase === 'night') return room.picks[p.id] !== undefined;
  if (room.phase === 'vote') return room.votes[p.id] !== undefined;
  return true;
}
function laggards(room) {
  return requiredActors(room).filter(p => !acted(room, p) &&
    (p.connected ? (p.ping || 0) >= HIGH_MS || now() - p.lastSeen > STALE_MS : now() - p.lastSeen < 45000));
}
function onDeadline(room) {
  if (room.phase === 'night' || room.phase === 'vote') {
    const lag = laggards(room);
    if (lag.length && !room.extended) {           // never punish lag: wait a little longer, once
      room.extended = true;
      setDeadline(room, now() + GRACE_MS);
      sys(room, `Waiting a few more seconds for ${lag.map(p => p.name).join(', ')} (high ping or reconnecting).`);
      pushState(room);
      return;
    }
  }
  switch (room.phase) {
    case 'reveal': return startNight(room);
    case 'night': return resolveNight(room);
    case 'dawn': return afterDawn(room);
    case 'day': return startVote(room, [...room.players.values()].filter(p => p.alive).map(p => p.id), 1);
    case 'vote': return tally(room);
    case 'result': return afterResult(room);
  }
}
function maybeAdvance(room) {
  const ph = room.phase;
  // Night intentionally has no early-advance: it always runs its full configured length, even
  // once every required actor has acted, so timing never leaks who has (or lacks) a night ability.
  if (ph === 'vote') {
    const req = requiredActors(room).filter(p => p.connected);
    if (req.every(p => acted(room, p)) && room.phaseEnd - now() > 2000) setDeadline(room, now() + 2000);
  } else if (ph === 'day') {
    const el = [...room.players.values()].filter(q => q.alive && q.connected && !q.left);
    if (el.filter(q => q.ready).length * 2 > el.length && room.phaseEnd - now() > 1500) setDeadline(room, now() + 1500);
  }
}

function resolveNight(room) {
  const P = room.players, n = room.night, notes = [];
  const alive = [...P.values()].filter(p => p.alive);
  const picks = alive.map(p => ({ p, kind: nightKind(p), raw: room.picks[p.id] })).filter(x => x.kind !== 'decoy' && x.raw !== undefined && x.raw !== 'hold');

  // ---- Mafia team action: plurality of {action,target} among submitted picks (ties -> random) ----
  const mafiaPicks = picks.filter(x => x.kind === 'mafia');
  let mafiaChoice = { action: 'wait', target: null };
  if (mafiaPicks.length) {
    const counts = {};
    mafiaPicks.forEach(x => { const key = x.raw.action + '|' + (x.raw.target || ''); counts[key] = (counts[key] || 0) + 1; });
    const max = Math.max(...Object.values(counts));
    const top = Object.keys(counts).filter(k => counts[k] === max);
    const [action, target] = pickOne(top).split('|');
    mafiaChoice = { action, target: target || null };
  }

  const attacks = [];   // { t, src, strong }

  // a delayed attack started on an earlier night resolves on its own schedule, regardless of tonight's choice
  if (room.mafiaCountdown && room.mafiaCountdown.resolvesOnNight === n) {
    attacks.push({ t: room.mafiaCountdown.target, src: 'The Mafia', strong: true });
    notes.push('A delayed Mafia plan came to a head tonight.');
    room.mafiaCountdown = null;
  }

  switch (mafiaChoice.action) {
    case 'attack':
      if (mafiaChoice.target) attacks.push({ t: mafiaChoice.target, src: 'The Mafia', strong: false });
      break;
    case 'delayed_attack':
      if (mafiaChoice.target && !room.mafiaCountdown) {
        room.mafiaCountdown = { target: mafiaChoice.target, resolvesOnNight: n + DELAYED_ATTACK_NIGHTS };
        notes.push('The Mafia set something in motion. Its effects are not yet clear.');
      }
      break;
    case 'frame':
      if (mafiaChoice.target) {
        room.mafiaFrames.push({ target: mafiaChoice.target, expiresNight: n + FRAME_COOLDOWN_NIGHTS });
        room.mafiaCooldowns.frame = nextCooldownNight(n, FRAME_COOLDOWN_NIGHTS);
        const tp = P.get(mafiaChoice.target);
        notes.push('The Mafia planted misleading evidence.');
        addChat(room, { ch: 'mafia', text: `You planted misleading evidence pointing at ${tp ? tp.name : 'someone'}.` });
      }
      break;
    case 'sabotage':
      room.sabotageActiveNight = n;
      room.mafiaCooldowns.sabotage = nextCooldownNight(n, SABOTAGE_COOLDOWN_NIGHTS);
      notes.push('The Mafia interfered with tonight\'s evidence.');
      addChat(room, { ch: 'mafia', text: 'You interfered with tonight\'s evidence.' });
      break;
    case 'observe': {
      const tp = mafiaChoice.target && P.get(mafiaChoice.target);
      if (tp) {
        const c = generateClue({ kind: 'observe' });
        const hint = c.tier === 'none' ? `You learned nothing useful about ${tp.name} tonight.` : `Something about ${tp.name}'s behavior stood out, though it's hard to say what it means.`;
        addChat(room, { ch: 'mafia', text: hint });
      }
      break;
    }
    default: break;   // 'wait' — doing nothing is a legitimate strategic choice
  }

  picks.filter(x => x.kind === 'vigilante').forEach(x => { x.p.bullets = 0; attacks.push({ t: x.raw, src: `Vigilante ${x.p.name}`, strong: false }); });
  picks.filter(x => x.kind === 'serialkiller').forEach(x => attacks.push({ t: x.raw, src: `Serial Killer ${x.p.name}`, strong: false }));
  picks.filter(x => x.kind === 'doctor').forEach(x => notes.push(`Doctor ${x.p.name} treated ${P.get(x.raw)?.name || 'someone'}.`));
  picks.filter(x => x.kind === 'bodyguard').forEach(x => notes.push(`Bodyguard ${x.p.name} guarded ${P.get(x.raw)?.name || 'someone'}.`));

  // ---- Detective, Stage 1: "appears suspicious" / "does not appear suspicious" — never a faction reveal ----
  picks.filter(x => x.kind === 'detective').forEach(x => {
    const target = P.get(x.raw);
    if (!target) return;
    x.p.detCounts = x.p.detCounts || {};
    x.p.detCounts[target.id] = (x.p.detCounts[target.id] || 0) + 1;
    let result;
    if (room.sabotageActiveNight === n) {
      result = 'inconclusive';                       // this night's Sabotage muddied every investigation
    } else {
      const framed = room.mafiaFrames.some(f => f.target === target.id && f.expiresNight >= n);
      let susp = target.role === 'godfather' ? 0.30 : isM(target) ? 0.65 : target.role === 'serialkiller' ? 0.55 : 0.30;
      if (framed) susp = Math.min(0.9, susp + 0.3);
      const c = generateClue({ kind: 'investigation', weights: { clear: susp, none: 1 - susp } });
      result = c.tier === 'clear' ? 'suspicious' : 'not_suspicious';
    }
    x.p.det.push({ night: n, target: target.id, stage: 1, result });
    notes.push(`Detective ${x.p.name} investigated ${target.name}.`);
  });

  const healed = new Set(picks.filter(x => x.kind === 'doctor').map(x => x.raw));
  const guards = picks.filter(x => x.kind === 'bodyguard');
  const deadSet = new Set(), saves = [], notices = {};
  const deaths = [], injured = [];

  for (const a of attacks) {
    const t = P.get(a.t);
    if (!t || t.condition === 'dead' || deadSet.has(t.id)) continue;
    const rawTier = rollAttackOutcome(t, { strong: a.strong });
    const wasHealed = healed.has(t.id);
    const tier = wasHealed ? softenOutcome(rawTier) : rawTier;
    const actuallySaved = wasHealed && tier !== rawTier;   // only a "save" if the heal changed the outcome
    const gd = guards.find(x => x.raw === t.id && !deadSet.has(x.p.id) && x.p.condition !== 'dead');
    const applyTo = gd ? gd.p : t;
    if (actuallySaved && !saves.includes(t.id)) {
      saves.push(t.id); notices[t.id] = { type: 'saved', id: t.id };
      picks.filter(x => x.kind === 'doctor' && x.raw === t.id).forEach(x => { if (!notices[x.p.id]) notices[x.p.id] = { type: 'patient', id: t.id }; });
    }
    if (gd) notes.push(`${a.src} attacked ${t.name}. Bodyguard ${gd.p.name} stepped in.`);
    if (tier === 'fail') { notes.push(`${a.src} attacked ${applyTo.name}, but the attack failed.`); continue; }
    if (tier === 'dead') { deadSet.add(applyTo.id); setCondition(applyTo, 'dead'); deaths.push({ id: applyTo.id, src: a.src }); }
    else { setCondition(applyTo, tier); injured.push({ id: applyTo.id, src: a.src, tier }); }
    notes.push(`${a.src} attacked ${applyTo.name} (${tier}).`);
  }
  if (!attacks.length) notes.push('Nobody was attacked.');
  notes.forEach(text => room.log.push({ label: `Night ${n}`, text }));

  // ---- public dawn report: how much gets revealed is decided by the clue pipeline, not guaranteed ----
  const sabotaged = room.sabotageActiveNight === n;
  const deathReports = deaths.map(d => {
    const t = P.get(d.id);
    const c = sabotaged ? { tier: 'none' } : generateClue({ kind: 'attack' });
    return { id: d.id, role: room.settings.reveal ? t.role : null, note: attackPublicNote(t, 'dead', c.tier, d.src) };
  });
  const injuredReports = injured.filter(x => x.tier === 'critical').map(x => {
    const t = P.get(x.id);
    const c = sabotaged ? { tier: 'none' } : generateClue({ kind: 'attack' });
    return { id: x.id, note: attackPublicNote(t, 'critical', c.tier, x.src) };
  });

  room.dawn = { deaths: deathReports, injured: injuredReports, saves, notices };
  // These are already public dawn news, so they enter the Case File automatically as VERIFIED FACT —
  // unlike a Detective's result or a Doctor's save, which stay private until a player formally claims them.
  deathReports.forEach(d => addCaseEntry(room, { type: 'event', category: 'death', night: n, about: d.id, role: d.role, text: d.note || `${P.get(d.id).name} was found dead.` }));
  injuredReports.forEach(x => addCaseEntry(room, { type: 'event', category: 'injury', night: n, about: x.id, text: x.note || `${P.get(x.id).name} was found badly hurt.` }));
  setPhase(room, 'dawn', T(Math.min(22, 4.5 + 3.6 * (deathReports.length + injuredReports.length + saves.length))));
}
function checkWin(room) {
  const al = [...room.players.values()].filter(p => p.alive);
  if (!al.length) return { key: 'draw' };
  const m = al.filter(isM).length, sk = al.filter(p => p.role === 'serialkiller').length;
  if (m === 0 && sk === 0) return { key: 'town' };
  if (m === 0 && sk > 0 && al.length <= 2) return { key: 'sk' };
  const others = al.length - m;
  if (sk === 0 && m >= others) return { key: 'mafia' };
  if (sk > 0 && m > others) return { key: 'mafia' };
  return null;
}
function finish(room, w) {
  clearTimeout(room.timer);
  room.winner = w; room.phase = 'over'; room.phaseStart = now(); room.phaseEnd = 0;
  sys(room, 'Game over.');
  pushState(room);
}
function afterDawn(room) {
  const w = checkWin(room);
  if (w) return finish(room, w);
  setPhase(room, 'day', room.settings.daySec);
}
function startVote(room, cands, round) {
  room.votes = {}; room.voteCands = cands; room.voteRound = round;
  setPhase(room, 'vote', round === 2 ? Math.min(30, room.settings.voteSec) : room.settings.voteSec);
}
function tally(room) {
  const P = room.players, cands = room.voteCands, counts = {}; let skip = 0;
  for (const [vid, t] of Object.entries(room.votes)) {
    const v = P.get(vid); if (!v || !v.alive) continue;
    if (t === 'skip') skip++; else if (cands.includes(t)) counts[t] = (counts[t] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  const snapshot = { counts, skip, votes: { ...room.votes } };
  const none = note => {
    room.log.push({ label: `Day ${room.night}`, text: note });
    room.result = { pid: null, note, ...snapshot };
    addCaseEntry(room, { type: 'vote', night: room.night, round: room.voteRound, counts, skip, eliminated: null, note });
    setPhase(room, 'result', T(7));
  };
  if (max === 0 || skip >= max) return none('The town chose not to eliminate anyone.');
  const top = Object.keys(counts).filter(k => counts[k] === max);
  let victim = null, note = '';
  if (top.length === 1) victim = top[0];
  else if (room.settings.tie === 'revote' && room.voteRound === 1) {
    addCaseEntry(room, { type: 'vote', night: room.night, round: room.voteRound, counts, skip, eliminated: null, note: 'The vote was tied. Revoting between the tied players.', tied: top });
    sys(room, 'Tie! Vote again. Only the tied players are on the ballot.');
    return startVote(room, top, 2);
  } else if (room.settings.tie === 'random') { victim = pickOne(top); note = 'The vote was tied, so one tied player was picked at random.'; }
  else return none('The vote was tied. Nobody is eliminated.');
  const v = P.get(victim); setCondition(v, 'dead');
  room.log.push({ label: `Day ${room.night}`, text: `${v.name} was voted out (${v.role}).` });
  if (v.role === 'jester') room.jesterWin = v;
  const revealed = (room.settings.reveal || v.role === 'jester') ? v.role : null;
  room.result = { pid: v.id, role: revealed, note, ...snapshot };
  addCaseEntry(room, { type: 'vote', night: room.night, round: room.voteRound, counts, skip, eliminated: v.id, role: revealed, note: note || `${v.name} was voted out.` });
  setPhase(room, 'result', T(7));
}
function afterResult(room) {
  if (room.jesterWin) return finish(room, { key: 'jester', name: room.jesterWin.name });
  const w = checkWin(room);
  if (w) return finish(room, w);
  startNight(room);
}

/* ------------------------------------------------------------------ connection bookkeeping */
function setConn(room, p, c) {
  p.connected = c; p.lastSeen = now();
  if (c) {
    p.lostAt = 0;
    if (p.lostNotice) { p.lostNotice = false; sys(room, `${p.name} is back.`); }
  } else {
    p.lostAt = now(); p.ping = null;
    setTimeout(() => {                                     // only announce a real drop, not a page refresh
      if (!p.connected && p.lostAt && !p.lostNotice && !p.left && rooms.has(room.code)) {
        p.lostNotice = true;
        sys(room, `${p.name} lost connection. Their seat is kept. They can rejoin any time.`);
      }
    }, 5000);
  }
  pushState(room);
}

/* ------------------------------------------------------------------ actions */
function auth(b) {
  const room = rooms.get(String(b.room || '').toUpperCase());
  const p = room && room.players.get(String(b.pid || ''));
  if (!room || !p || p.token !== b.token) return null;
  return { room, p };
}
function removePlayer(room, p) {
  room.players.delete(p.id); room.order = room.order.filter(id => id !== p.id);
  if (p.res) { try { p.res.end(); } catch (e) {} p.res = null; }
  if (!room.players.size) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = [...room.players.values()].find(q => q.connected)?.id || room.order[0];
  pushState(room);
}

function handleAct(room, p, b) {
  room.lastActive = now();
  switch (b.type) {
    case 'hb': {
      const ms = Math.max(0, Math.min(9999, Math.round(+b.ms)));
      p.lastSeen = now();
      if (Number.isFinite(ms)) {
        p.ping = p.ping == null ? ms : Math.round(p.ping * 0.5 + ms * 0.5);
        if (p.ping >= HIGH_MS && now() - p.highNoticeAt > 45000 && room.phase !== 'lobby') {
          p.highNoticeAt = now();
          sys(room, `${p.name} has high ping (${p.ping} ms). They are not being kicked. The game will wait for them.`);
        }
      }
      return { ok: true, now: now() };
    }
    case 'settings': {
      if (p.id !== room.hostId || room.phase !== 'lobby') return { error: 'Only the host can change settings in the lobby.' };
      const s = b.settings || {}, o = room.settings;
      for (const k of ['reveal', 'selfHeal', 'announceSave', 'mafiaAuto', 'doctor', 'detective', 'godfather', 'bodyguard', 'vigilante', 'jester', 'serialkiller']) if (typeof s[k] === 'boolean') o[k] = s[k];
      if (s.mafiaCount != null) o.mafiaCount = clamp(s.mafiaCount, 1, MAX_MAFIA);
      if (['none', 'revote', 'random'].includes(s.tie)) o.tie = s.tie;
      if (s.nightSec != null) o.nightSec = clamp(s.nightSec, FAST ? 1 : 30, 180);
      if (s.daySec != null) o.daySec = clamp(s.daySec, FAST ? 1 : 30, 600);
      if (s.voteSec != null) o.voteSec = clamp(s.voteSec, FAST ? 1 : 15, 180);
      pushState(room); return { ok: true };
    }
    case 'start': {
      if (p.id !== room.hostId) return { error: 'Only the host can start the game.' };
      if (room.phase !== 'lobby') return { error: 'Already started.' };
      const seated = [...room.players.values()].filter(q => !q.left && q.connected);
      if (seated.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} connected players.` };
      for (const q of [...room.players.values()]) if (!q.connected) removePlayer(room, q);   // absent lobby seats are released
      startGame(room); return { ok: true };
    }
    case 'again': {
      if (p.id !== room.hostId || room.phase !== 'over') return { error: 'Not available.' };
      clearTimeout(room.timer);
      for (const q of room.players.values()) { q.role = null; setCondition(q, 'good'); q.bullets = 0; q.det = []; q.ready = false; }
      room.phase = 'lobby'; room.phaseStart = now(); room.phaseEnd = 0; room.winner = null; room.night = 0;
      sys(room, 'Back in the lobby.'); pushState(room); return { ok: true };
    }
    case 'chat': {
      const text = String(b.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
      if (!text) return { error: 'Empty message.' };
      const t = now(); p.chatTimes = p.chatTimes.filter(x => t - x < 5000);
      if (p.chatTimes.length >= 5) return { error: 'Slow down a little.' };
      p.chatTimes.push(t);
      const ch = chatChannel(room, p);
      if (!ch) return { error: 'You cannot talk right now.' };
      addChat(room, { ch, from: p.id, name: p.name, gender: p.gender, text });
      return { ok: true };
    }
    // A formal claim is deliberately not the same as chat: chat is a rolling 150-message window
    // and nothing is kept once it scrolls off; a claim is a permanent Case File entry everyone
    // (living, dead, and future viewers of the recap) can always see and respond to.
    case 'claim': {
      if (!['day', 'vote', 'result', 'dawn'].includes(room.phase)) return { error: 'Not now.' };
      if (!p.alive) return { error: 'The dead cannot add to the case file.' };
      const text = String(b.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 280);
      if (!text) return { error: 'Say something first.' };
      const t = now(); p.claimTimes = p.claimTimes.filter(x => t - x < 30000);
      if (p.claimTimes.length >= 4) return { error: 'Slow down — too many formal claims.' };
      p.claimTimes.push(t);
      const about = b.about && room.players.has(String(b.about)) ? String(b.about) : null;
      const entry = addCaseEntry(room, { type: 'claim', by: p.id, text, about, night: room.night, phase: room.phase });
      sys(room, `${p.name} put a formal claim on the record.`);
      pushState(room); return { ok: true, entryId: entry.id };
    }
    case 'respond': {
      if (!['day', 'vote', 'result', 'dawn'].includes(room.phase)) return { error: 'Not now.' };
      if (!p.alive) return { error: 'The dead cannot add to the case file.' };
      const target = room.caseFile.entries.find(e => e.id === String(b.entryId || '') && e.type === 'claim');
      if (!target) return { error: 'That claim is not on the record.' };
      if (target.by === p.id) return { error: 'You cannot respond to your own claim.' };
      if (!['confirm', 'deny', 'challenge'].includes(b.stance)) return { error: 'Unknown response.' };
      const text = String(b.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 280);
      const t = now(); p.claimTimes = p.claimTimes.filter(x => t - x < 30000);
      if (p.claimTimes.length >= 4) return { error: 'Slow down — too many formal claims.' };
      p.claimTimes.push(t);
      const entry = addCaseEntry(room, { type: 'response', by: p.id, refersTo: target.id, stance: b.stance, text, night: room.night, phase: room.phase });
      const verb = b.stance === 'confirm' ? 'confirmed' : b.stance === 'deny' ? 'denied' : 'challenged';
      sys(room, `${p.name} ${verb} a claim on the record.`);
      pushState(room); return { ok: true, entryId: entry.id };
    }
    case 'signal': {
      const t = now(); p.sigTimes = p.sigTimes.filter(x => t - x < 5000);
      if (p.sigTimes.length >= 250) return { error: 'Too many signals.' };
      p.sigTimes.push(t);
      const target = room.players.get(String(b.to || ''));
      if (target && target.id !== p.id) {
        if (target.res) send(target, 'signal', { from: p.id, data: b.data });
        else if (!target.left) { target.sigQueue.push({ from: p.id, data: b.data, t: now() }); if (target.sigQueue.length > 80) target.sigQueue.shift(); }   // hold it until they connect
      }
      return { ok: true };
    }
    case 'night': {
      if (room.phase !== 'night' || !p.alive) return { error: 'Not now.' };
      const kind = nightKind(p);
      if (kind === 'decoy') return { ok: true };
      if (kind === 'detective' && room.picks[p.id] != null) return { error: 'You already investigated tonight.' };
      if (kind === 'mafia') {
        const action = b.action;
        if (!MAFIA_ACTIONS.includes(action)) return { error: 'Unknown action.' };
        if (!mafiaActionsAvailable(room).includes(action)) return { error: 'That action is not available right now.' };
        let target = null;
        if (MAFIA_TARGETED_ACTIONS.includes(action)) {
          target = b.target;
          if (!optionsFor(room, p, 'mafia').includes(target)) return { error: 'Invalid target.' };
        }
        room.picks[p.id] = { action, target };
        pushState(room); maybeAdvance(room); return { ok: true };
      }
      const target = b.target;
      if (target === 'hold' && kind === 'vigilante') room.picks[p.id] = 'hold';
      else {
        if (!optionsFor(room, p, kind).includes(target)) return { error: 'Invalid target.' };
        room.picks[p.id] = target;
      }
      pushState(room); maybeAdvance(room); return { ok: true };
    }
    case 'ready': {
      if (room.phase !== 'day' || !p.alive) return { error: 'Not now.' };
      p.ready = !p.ready; pushState(room); maybeAdvance(room); return { ok: true };
    }
    case 'vote': {
      if (room.phase !== 'vote' || !p.alive) return { error: 'Not now.' };
      const t = b.target;
      if (t === null || t === undefined) delete room.votes[p.id];
      else if (t === 'skip' || (room.voteCands.includes(t) && t !== p.id)) room.votes[p.id] = t;
      else return { error: 'Invalid vote.' };
      pushState(room); maybeAdvance(room); return { ok: true };
    }
    case 'leave': {
      if (room.phase === 'lobby' || room.phase === 'over') { removePlayer(room, p); return { ok: true }; }
      p.left = true; p.connected = false; p.ping = null;
      if (p.res) { try { p.res.end(); } catch (e) {} p.res = null; }
      sys(room, `${p.name} left the game.`);
      pushState(room); maybeAdvance(room); return { ok: true };
    }
  }
  return { error: 'Unknown action.' };
}

/* ------------------------------------------------------------------ HTTP */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/ping') { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { iceServers: ICE });
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const a = auth({ room: url.searchParams.get('room'), pid: url.searchParams.get('pid'), token: url.searchParams.get('token') });
      if (!a) { res.writeHead(401); return res.end(); }
      const { room, p } = a;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      if (p.res) { try { p.res.end(); } catch (e) {} }
      p.res = res;
      setConn(room, p, true);
      send(p, 'chatlog', room.chat.filter(m => canSee(room, p, m)));
      send(p, 'pings', pingsPayload(room));
      { const t0 = now(); for (const m of p.sigQueue.splice(0)) if (t0 - m.t < 60000) send(p, 'signal', { from: m.from, data: m.data }); }
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(hb); if (p.res === res) { p.res = null; if (rooms.has(room.code) && room.players.has(p.id)) setConn(room, p, false); } });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await readJson(req); const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: 'Enter a name first.' });
      const { room, p } = createRoom(name, b.gender);
      return json(res, 200, { code: room.code, pid: p.id, token: p.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readJson(req);
      const room = rooms.get(String(b.code || '').trim().toUpperCase());
      const name = cleanName(b.name);
      if (!room) return json(res, 404, { error: 'No room with that code.' });
      if (!name) return json(res, 400, { error: 'Enter a name first.' });
      if (room.phase !== 'lobby') return json(res, 409, { error: 'That game has already started.' });
      if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: 'That room is full.' });
      if ([...room.players.values()].some(q => q.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'Someone in the room already has that name.' });
      const p = newPlayer(room, name, b.gender);
      pushState(room);
      return json(res, 200, { code: room.code, pid: p.id, token: p.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/resume') {
      const b = await readJson(req); const a = auth({ room: b.code, pid: b.pid, token: b.token });
      if (!a || a.p.left) return json(res, 404, { error: 'That session is over.' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/room') {   // lobby peek for the join page
      const b = await readJson(req); const room = rooms.get(String(b.code || '').trim().toUpperCase());
      if (!room) return json(res, 404, { error: 'No room with that code.' });
      return json(res, 200, { code: room.code, players: room.players.size, started: room.phase !== 'lobby', full: room.players.size >= MAX_PLAYERS });
    }
    if (req.method === 'POST' && url.pathname === '/api/act') {
      const b = await readJson(req); const a = auth(b);
      if (!a) return json(res, 401, { error: 'Session expired.' });
      return json(res, 200, handleAct(a.room, a.p, b));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: 'Bad request.' });
  }
});

/* periodic: pings to everyone, host hand-over, housekeeping. Never removes anyone for lag. */
setInterval(() => {
  for (const room of rooms.values()) {
    pushPings(room);
    if ((room.phase === 'lobby' || room.phase === 'over')) {
      const host = room.players.get(room.hostId);
      if (host && !host.connected && now() - host.lostAt > 20000) {
        const nh = [...room.players.values()].find(q => q.connected);
        if (nh) { room.hostId = nh.id; sys(room, `${nh.name} is now the host.`); pushState(room); }
      }
    }
    if (room.phase === 'lobby') {           // release lobby seats that have been empty for a minute (a live game never does this)
      for (const q of [...room.players.values()]) if (!q.connected && q.lostAt && now() - q.lostAt > 60000) removePlayer(room, q);
    }
    const anyone = [...room.players.values()].some(q => q.connected);
    if (!anyone && now() - room.lastActive > 3 * 3600 * 1000) { clearTimeout(room.timer); rooms.delete(room.code); }
  }
}, 2000);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Mafia online listening on http://localhost:${PORT}`));
}
module.exports = { server, rooms, composePlan, autoTeam, maxTeam, generateClue, CLUE_TIERS, CONDITIONS, addCaseEntry,
  rollAttackOutcome, softenOutcome, mafiaActionsAvailable, MAFIA_ACTIONS, OUTCOME_ORDER, nextCooldownNight,
  FRAME_COOLDOWN_NIGHTS, SABOTAGE_COOLDOWN_NIGHTS, resolveNight };
