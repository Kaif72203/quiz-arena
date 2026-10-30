const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { QUESTIONS } = require('../questions');
let child, base;
async function request(route, body, token) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Player-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {}; try { data = await response.json(); } catch {}
  return { status: response.status, data };
}
before(async () => {
  const port = 31000 + crypto.randomInt(10000); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), REVEAL_MS: '15' }, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready, 'server should start for smoke tests');
});
after(() => { if (child && !child.killed) child.kill('SIGTERM'); });
test('room rules, host permissions, hidden answer, locking and speed scoring', async () => {
  const created = await request('/api/rooms', { name: 'Host Player' }); assert.equal(created.status, 201); const { code } = created.data.room;
  const tooEarly = await request(`/api/rooms/${code}/start`, {}, created.data.token); assert.equal(tooEarly.status, 409);
  const joined = await request('/api/rooms/join', { code, name: 'Guest Player' }); assert.equal(joined.status, 201);
  const forbidden = await request(`/api/rooms/${code}/start`, {}, joined.data.token); assert.equal(forbidden.status, 403);
  const started = await request(`/api/rooms/${code}/start`, {}, created.data.token); assert.equal(started.status, 200);
  const state = await request(`/api/rooms/${code}/state`, undefined, created.data.token); assert.equal(state.data.phase, 'question'); assert.equal(state.data.question.options.length, 4); assert.equal(Object.hasOwn(state.data.question, 'correctIndex'), false);
  const source = QUESTIONS.find(q => q.question === state.data.question.question); assert.ok(source);
  const first = await request(`/api/rooms/${code}/answer`, { answer: source.answer }, created.data.token); assert.equal(first.status, 200);
  const duplicate = await request(`/api/rooms/${code}/answer`, { answer: (source.answer + 1) % 4 }, created.data.token); assert.equal(duplicate.status, 409);
  const second = await request(`/api/rooms/${code}/answer`, { answer: (source.answer + 1) % 4 }, joined.data.token); assert.equal(second.status, 200);
  const reveal = await request(`/api/rooms/${code}/state`, undefined, created.data.token); assert.equal(reveal.data.phase, 'reveal'); assert.equal(reveal.data.question.correctIndex, source.answer);
  const hostResult = reveal.data.lastResult.rows.find(r => r.name === 'Host Player'); assert.equal(hostResult.points, 150);
});
test('room capacity is limited to eight players', async () => {
  const created = await request('/api/rooms', { name: 'Capacity Host' }); const code = created.data.room.code;
  for (let i = 2; i <= 8; i++) { const joined = await request('/api/rooms/join', { code, name: `Player ${i}` }); assert.equal(joined.status, 201); }
  const ninth = await request('/api/rooms/join', { code, name: 'Ninth Player' }); assert.equal(ninth.status, 409);
});


test('a tied match launches a sudden-death tie-break question after 15 rounds', async () => {
  const host = await request('/api/rooms', { name: 'Tie Host' }); const code = host.data.room.code;
  const guest = await request('/api/rooms/join', { code, name: 'Tie Guest' });
  await request(`/api/rooms/${code}/start`, {}, host.data.token);
  for (let i = 0; i < 15; i++) {
    let state;
    for (let tries = 0; tries < 50; tries++) { state = (await request(`/api/rooms/${code}/state`, undefined, host.data.token)).data; if (state.phase === 'question' && state.questionIndex === i) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(state.phase, 'question'); assert.equal(state.questionIndex, i);
    await request(`/api/rooms/${code}/answer`, { answer: 0 }, host.data.token);
    await request(`/api/rooms/${code}/answer`, { answer: 0 }, guest.data.token);
  }
  let tieState;
  for (let tries = 0; tries < 50; tries++) { tieState = (await request(`/api/rooms/${code}/state`, undefined, host.data.token)).data; if (tieState.phase === 'question' && tieState.tieBreak) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(tieState.phase, 'question'); assert.equal(tieState.tieBreak, true); assert.equal(tieState.questionIndex, 15);
});
