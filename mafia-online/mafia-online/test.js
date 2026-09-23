'use strict';
// Automated test: bots play complete games against the real server (FAST mode = 1s phases).
// Run:  FAST=1 node test.js
process.env.FAST = '1';
const http = require('http');
const assert = require('assert');
const { server, rooms, generateClue, CLUE_TIERS, CONDITIONS, rollAttackOutcome, softenOutcome, mafiaActionsAvailable, MAFIA_ACTIONS, OUTCOME_ORDER } = require('./server');

const PORT = 3999;
const base = { hostname: '127.0.0.1', port: PORT };
let HOLD = false;
const wait = ms => new Promise(r => setTimeout(r, ms));

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ ...base, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : {} }));
    });
    req.on('error', reject); req.end(data);
  });
}

class Bot {
  constructor(name, gender) { this.name = name; this.gender = gender; this.state = null; this.chat = []; this.pings = null; this.signals = []; this.errors = []; this.sawRolesLeak = false; }
  async create() { const r = await post('/api/create', { name: this.name, gender: this.gender }); Object.assign(this, r.body); }
  async join(code) { const r = await post('/api/join', { code, name: this.name, gender: this.gender }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); Object.assign(this, r.body); }
  act(type, extra) { return post('/api/act', { room: this.code, pid: this.pid, token: this.token, type, ...extra }).then(r => r.body); }
  connect() {
    return new Promise(resolve => {
      const req = http.get({ ...base, path: `/api/events?room=${this.code}&pid=${this.pid}&token=${this.token}` }, res => {
        assert.strictEqual(res.statusCode, 200);
        this.res = res; let buf = '';
        res.on('data', c => {
          buf += c; let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /event: (\w+)/.exec(block), data = /data: (.*)/.exec(block);
            if (ev && data) this.onEvent(ev[1], JSON.parse(data[1]));
          }
        });
        resolve();
      });
      this.req = req;
    });
  }
  disconnect() { this.req.destroy(); }
  onEvent(ev, d) {
    if (ev === 'state') { this.state = d; this.checkLeaks(d); this.react(d); }
    else if (ev === 'chat') this.chat.push(d);
    else if (ev === 'chatlog') this.chat.push(...d);
    else if (ev === 'pings') this.pings = d;
    else if (ev === 'signal') this.signals.push(d);
  }
  checkLeaks(s) {
    // A player must never learn another living player's role unless they are Mafia teammates (or the game is over).
    const me = s.players.find(p => p.id === s.meId);
    const myMafia = s.you.role === 'mafia' || s.you.role === 'godfather';
    for (const p of s.players) {
      if (p.id === s.meId || p.role == null || s.phase === 'over') continue;
      const teammate = myMafia && (p.role === 'mafia' || p.role === 'godfather');
      if (p.alive && !teammate) { this.sawRolesLeak = true; }
      // Phase 0 foundation: `condition` is not yet broadcast to other players, only to yourself.
      if ('condition' in p) this.sawConditionLeak = true;
    }
    // My own condition should always be present, valid, and in sync with `alive`.
    if (s.you.condition != null) {
      if (!CONDITIONS.includes(s.you.condition)) this.badCondition = true;
      if ((s.you.condition === 'dead') !== !s.you.alive) this.badCondition = true;
    }
    // A Detective's own investigation history should only ever contain Stage-1-shaped results —
    // never a raw faction/role boolean (that would defeat the whole point of staging it).
    if (Array.isArray(s.you.det)) {
      for (const d of s.you.det) {
        if ('mafia' in d) this.sawRawDetectiveLeak = true;
        if (!['suspicious', 'not_suspicious', 'inconclusive'].includes(d.result)) this.badDetectiveResult = true;
      }
    }
  }
  react(s) {
    if (this.stopped || this.disconnected) return;
    const key = s.phase + ':' + s.night + ':' + (s.vote ? s.vote.round : 0);
    if (this.lastKey === key) return; this.lastKey = key;
    setTimeout(() => {
      if (this.stopped || this.disconnected) return;
      const st = this.state; if (!st || st.phase !== s.phase) return;
      if (HOLD && st.phase === 'night') { this.lastKey = null; return; }
      if (st.phase === 'night' && st.you.action && st.you.action.kind !== 'decoy') {
        const a = st.you.action; const opts = a.options;
        if (a.kind === 'mafia') {
          // Mostly attack, so games still play out at a normal pace, but exercise every other
          // action often enough that the test suite actually sees them fire across 8 games.
          const avail = a.actions || ['attack', 'wait'];
          const roll = Math.random();
          let action = 'wait';
          if (roll < 0.65 && avail.includes('attack')) action = 'attack';
          else if (roll < 0.72 && avail.includes('delayed_attack')) action = 'delayed_attack';
          else if (roll < 0.80 && avail.includes('frame')) action = 'frame';
          else if (roll < 0.88 && avail.includes('sabotage')) action = 'sabotage';
          else if (roll < 0.96 && avail.includes('observe')) action = 'observe';
          else if (avail.includes('attack')) action = 'attack';     // fallback keeps games from stalling forever
          const needsTarget = ['attack', 'delayed_attack', 'frame', 'observe'].includes(action);
          const target = needsTarget && opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
          this.act('night', { action, target });
        } else if (a.kind === 'vigilante' && Math.random() < 0.5) this.act('night', { target: 'hold' });
        else if (opts.length) this.act('night', { target: opts[Math.floor(Math.random() * opts.length)] });
      } else if (st.phase === 'day' && st.you.alive) {
        if (Math.random() < 0.9) this.act('ready');
      } else if (st.phase === 'vote' && st.you.alive) {
        const c = st.vote.cands.filter(id => id !== st.meId);
        if (Math.random() < 0.15 || !c.length) this.act('vote', { target: 'skip' });
        else this.act('vote', { target: c[Math.floor(Math.random() * c.length)] });
      }
    }, 20 + Math.random() * 60);
  }
}

async function until(fn, ms = 20000, what = 'condition') {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await wait(25); }
  throw new Error('timeout waiting for ' + what);
}

function testCluePipeline() {
  // Every draw must be one of the declared tiers, and skewed weights should visibly bias the outcome.
  const counts = {};
  for (let i = 0; i < 4000; i++) { const c = generateClue({ kind: 'attack' }); assert.ok(CLUE_TIERS.includes(c.tier)); counts[c.tier] = (counts[c.tier] || 0) + 1; }
  assert.ok(Object.keys(counts).length >= 4, 'default weights should produce a spread of tiers, not one dominant tier');
  const forcedNone = {};
  const onlyNone = { clear: 0, weak: 0, indirect: 0, ambiguous: 0, none: 1 };
  for (let i = 0; i < 500; i++) { const c = generateClue({ kind: 'attack', weights: onlyNone }); forcedNone[c.tier] = (forcedNone[c.tier] || 0) + 1; }
  assert.deepStrictEqual(Object.keys(forcedNone), ['none'], 'zeroing every other tier must always return "none"');
  console.log('clue pipeline unit test passed:', counts);
}

function testAttackOutcomes() {
  const healthy = { condition: 'good' }, hurt = { condition: 'mediocre' }, dying = { condition: 'critical' };
  const tally = (target, n, opts) => { const c = {}; for (let i = 0; i < n; i++) { const t = rollAttackOutcome(target, opts); assert.ok(OUTCOME_ORDER.includes(t)); c[t] = (c[t] || 0) + 1; } return c; };
  const healthyOut = tally(healthy, 3000, {});
  const hurtOut = tally(hurt, 3000, {});
  const dyingOut = tally(dying, 3000, {});
  assert.ok((hurtOut.dead || 0) > (healthyOut.dead || 0), 'an already-wounded target should be more likely to die from a fresh attack');
  assert.ok((dyingOut.dead || 0) > (hurtOut.dead || 0), 'a critical target should be even more likely to die than a merely wounded one');
  const strongOut = tally(healthy, 3000, { strong: true });
  assert.ok((strongOut.fail || 0) === 0, 'a resolved delayed (strong) attack should never simply fail');
  assert.ok((strongOut.dead || 0) > (healthyOut.dead || 0), 'a strong attack should be deadlier than a normal one');
  // softenOutcome always moves exactly one step toward surviving, and 'fail' has nowhere further to go
  assert.strictEqual(softenOutcome('dead'), 'critical');
  assert.strictEqual(softenOutcome('critical'), 'mediocre');
  assert.strictEqual(softenOutcome('mediocre'), 'fail');
  assert.strictEqual(softenOutcome('fail'), 'fail');
  console.log('attack outcome unit test passed:', { healthyOut, hurtOut, dyingOut, strongOut });
}

function testMafiaActionAvailability() {
  const fresh = { night: 3, mafiaCooldowns: {}, mafiaCountdown: null };
  const avail = mafiaActionsAvailable(fresh);
  for (const a of ['wait', 'observe', 'attack', 'delayed_attack', 'frame', 'sabotage']) assert.ok(avail.includes(a), `${a} should be available with no cooldowns/countdown active`);
  const midCountdown = { night: 4, mafiaCooldowns: {}, mafiaCountdown: { target: 'x', resolvesOnNight: 6 } };
  const avail2 = mafiaActionsAvailable(midCountdown);
  assert.ok(!avail2.includes('attack') && !avail2.includes('delayed_attack'), 'attack/delayed_attack must be blocked while a countdown is already in flight');
  assert.ok(avail2.includes('frame') && avail2.includes('sabotage') && avail2.includes('wait') && avail2.includes('observe'), 'everything else should still be usable during a countdown');
  const onCooldown = { night: 3, mafiaCooldowns: { frame: 5, sabotage: 4 }, mafiaCountdown: null };
  const avail3 = mafiaActionsAvailable(onCooldown);
  assert.ok(!avail3.includes('frame') && !avail3.includes('sabotage'), 'frame/sabotage must be unavailable while on cooldown');
  const offCooldown = { night: 5, mafiaCooldowns: { frame: 5, sabotage: 4 }, mafiaCountdown: null };
  const avail4 = mafiaActionsAvailable(offCooldown);
  assert.ok(avail4.includes('frame') && avail4.includes('sabotage'), 'frame/sabotage must return once the cooldown night is reached');
  console.log('mafia action availability unit test passed');
}

async function main() {
  testCluePipeline();
  testAttackOutcomes();
  testMafiaActionAvailability();
  await new Promise(r => server.listen(PORT, r));
  const names = ['Ava', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'];
  const bots = names.map((n, i) => new Bot(n, ['male', 'female', 'neutral'][i % 3]));
  const host = bots[0];
  await host.create();
  for (const b of bots.slice(1)) await b.join(host.code);
  // duplicate names & bad codes are rejected
  assert.strictEqual((await post('/api/join', { code: host.code, name: 'ava', gender: 'male' })).status, 409);
  assert.strictEqual((await post('/api/join', { code: 'ZZZZZ', name: 'X', gender: 'male' })).status, 404);
  assert.strictEqual((await post('/api/join', { code: host.code, name: '', gender: 'male' })).status, 400);
  for (const b of bots) await b.connect();
  await until(() => bots.every(b => b.state && b.state.players.length === 9), 5000, 'lobby full');

  // only the host may change settings / start
  assert.ok((await bots[1].act('start')).error);
  assert.ok((await bots[1].act('settings', { settings: { jester: true } })).error);
  assert.ok((await host.act('settings', { settings: { godfather: true, bodyguard: true, vigilante: true, jester: true, serialkiller: true, tie: 'revote', nightSec: 6, daySec: 3, voteSec: 3 } })).ok);

  let gamesPlayed = 0; const winners = {}; const allLogText = [];
  for (let g = 0; g < 8; g++) {
    // lobby chat is public
    await bots[2].act('chat', { text: 'hello lobby ' + g });
    assert.ok((await host.act('start')).ok, 'start');
    await until(() => bots.every(b => b.state.phase === 'reveal'), 3000, 'reveal');
    const roles = bots.map(b => b.state.you.role);
    assert.strictEqual(roles.filter(r => r === 'mafia' || r === 'godfather').length, 2);
    assert.ok(roles.includes('detective') && roles.includes('doctor') && roles.includes('serialkiller') && roles.includes('jester'));

    let sawNightChat = false;
    // during the game, exercise chat rules and lag handling once
    if (g === 0) {
      HOLD = true;
      await until(() => bots.every(b => b.state.phase === 'night'), 5000, 'night');
      const mafiaBots = bots.filter(b => ['mafia', 'godfather'].includes(b.state.you.role));
      const townBot = bots.find(b => !['mafia', 'godfather'].includes(b.state.you.role));
      const before = townBot.chat.length;
      const r1 = await mafiaBots[0].act('chat', { text: 'secret plan' });
      assert.ok(r1.ok, 'mafia can talk at night');
      const r2 = await townBot.act('chat', { text: 'can anyone hear me' });
      assert.ok(r2.error, 'town cannot talk at night');
      await wait(100);
      assert.ok(mafiaBots[1].chat.some(m => m.text === 'secret plan'), 'mafia teammate got the secret chat');
      assert.ok(!townBot.chat.some(m => m.text === 'secret plan'), 'town did NOT get the mafia chat');
      // voice policy: mafia only hear each other at night, town hear nobody
      const mv = mafiaBots[0].state.voice; assert.deepStrictEqual(mv.to, [mafiaBots[1].pid]);
      assert.deepStrictEqual(townBot.state.voice.to, []); assert.deepStrictEqual(townBot.state.voice.from, []);
      // signaling relay
      await bots[3].act('signal', { to: bots[4].pid, data: { hello: 1 } });
      await wait(60);
      assert.ok(bots[4].signals.some(s => s.from === bots[3].pid && s.data.hello === 1), 'signal relayed');
      // high ping: message shown to everyone, player NOT removed
      const lag = bots[5];
      await lag.act('hb', { ms: 900 }); await lag.act('hb', { ms: 900 });
      await wait(80);
      assert.ok(host.chat.some(m => m.ch === 'sys' && /high ping/.test(m.text)), 'high-ping notice broadcast');
      assert.ok(host.state.players.some(p => p.id === lag.pid), 'laggy player still seated');
      await until(() => host.pings && host.pings[lag.pid] && host.pings[lag.pid].ms >= 250, 4000, 'ping broadcast to everyone');
      // a disconnect + reconnect keeps the seat and role
      const dropper = bots[6]; const roleBefore = dropper.state.you.role;
      dropper.disconnected = true; dropper.disconnect();
      await wait(150);
      assert.ok(host.state.players.find(p => p.id === dropper.pid), 'dropped player keeps seat');
      assert.strictEqual(host.state.players.find(p => p.id === dropper.pid).connected, false);
      dropper.disconnected = false; dropper.lastKey = null;
      await dropper.connect(); await wait(100);
      assert.strictEqual(dropper.state.you.role, roleBefore, 'role kept after reconnect');
      assert.strictEqual(host.state.players.find(p => p.id === dropper.pid).connected, true);
      HOLD = false; bots.forEach(b => { b.lastKey = null; if (b.state) b.react(b.state); });
    }

    await until(() => bots[0].state.phase === 'over', 60000, 'game over');
    await until(() => bots.every(b => b.state.phase === 'over'), 3000, 'all over');
    const w = bots[0].state.winner.key; winners[w] = (winners[w] || 0) + 1; gamesPlayed++;
    assert.ok(['town', 'mafia', 'sk', 'jester', 'draw'].includes(w));
    // after game over everyone sees everything
    assert.ok(bots[0].state.recap.roster.every(r => r.role), 'roles revealed at end');
    allLogText.push(bots[0].state.recap.log.map(e => e.text).join(' | '));
    assert.ok((await host.act('again')).ok);
    await until(() => bots.every(b => b.state.phase === 'lobby'), 3000, 'back to lobby');
  }
  assert.ok(bots.every(b => !b.sawRolesLeak), 'no player ever saw a hidden living role');
  assert.ok(bots.every(b => !b.sawConditionLeak), 'no player ever saw another player\'s condition (self-only for now)');
  assert.ok(bots.every(b => !b.badCondition), 'every player\'s own condition was valid and matched `alive`');
  assert.ok(bots.every(b => !b.sawRawDetectiveLeak), 'Detective results must never be a raw mafia:boolean, only a Stage-1 result');
  assert.ok(bots.every(b => !b.badDetectiveResult), 'every Detective result was one of the valid Stage-1 outcomes');
  console.log('games played:', gamesPlayed, 'winners:', winners);

  // Over 8 games' worth of night logs, we should see real variety: not just plain kills.
  const blob = allLogText.join(' || ');
  assert.ok(/\(mediocre\)|\(critical\)/.test(blob), 'expected at least one non-lethal (mediocre/critical) attack outcome across 8 games');
  assert.ok(/planted misleading evidence|set something in motion|interfered with tonight|Detective .* investigated/.test(blob), 'expected at least one non-attack Mafia action or a Detective investigation in the logs');
  console.log('night-log variety check passed');

  // player who leaves in the lobby is removed; host migrates
  await bots[8].act('leave');
  await until(() => host.state.players.length === 8, 3000, 'leave');

  // reveal setting off hides dead roles
  bots.forEach(b => { b.stopped = true; b.disconnect(); });
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
