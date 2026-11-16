import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { sweepTimeouts } from '../src/game.js';
import { importQuestions } from '../src/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://quiz:quiz@localhost:5432/quiz_test';
let db: Db;
let app: FastifyInstance;
let seq = 0;

before(async () => {
  db = createPool(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await importQuestions(db);
  const config = { ...loadConfig({ RATE_LIMIT: 'off', ADMIN_TOKEN: 'test-admin-token' }), databaseUrl };
  app = await buildApp(config, db);
});

after(async () => {
  await app.close();
  await db.end();
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function player(prefix = 'p') {
  const username = `${prefix}_${Date.now() % 100000}_${seq++}`;
  const res = await call('POST', '/api/auth/register', undefined, { username, password: 'correct horse' });
  assert.equal(res.status, 201);
  return { username, token: res.body.token as string };
}

/** Answers the current question, deliberately right or wrong, by looking the answer up in the database. */
async function answer(token: string, gameId: string, right: boolean) {
  const q = await call('POST', `/api/games/${gameId}/question`, token);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.question.answers.length, 4);
  assert.ok(!('correctIndex' in q.body.question), 'question must not leak the answer');
  const { rows } = await db.query('SELECT answers[1] AS correct FROM questions WHERE text = $1', [q.body.question.text]);
  const correctSlot = q.body.question.answers.indexOf(rows[0].correct);
  const choice = right ? correctSlot : (correctSlot + 1) % 4;
  const res = await call('POST', `/api/games/${gameId}/answer`, token, { choice });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.correct, right);
  assert.equal(res.body.correctIndex, correctSlot);
  return res.body;
}

async function playRound(token: string, gameId: string, right: boolean[]) {
  let last;
  for (const r of right) last = await answer(token, gameId, r);
  return last.game;
}

async function pick(token: string, gameId: string) {
  const { body } = await call('GET', `/api/games/${gameId}`, token);
  assert.equal(body.game.action, 'pick');
  assert.equal(body.game.offered.length, 3);
  const res = await call('POST', `/api/games/${gameId}/category`, token, { categoryId: body.game.offered[0].id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.game;
}

test('registration and login', async () => {
  const a = await player('auth');
  assert.equal((await call('POST', '/api/auth/register', undefined, { username: a.username.toUpperCase(), password: 'another pass' })).status, 409);
  assert.equal((await call('POST', '/api/auth/register', undefined, { username: 'ab', password: 'long enough' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', undefined, { username: 'valid_name', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', undefined, { username: a.username, password: 'wrong password' })).status, 401);
  const login = await call('POST', '/api/auth/login', undefined, { username: a.username, password: 'correct horse' });
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/me', login.body.token)).body.user.username, a.username);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/games', 'not-a-token')).status, 401);
  const stored = await db.query('SELECT password_hash FROM users WHERE username = $1', [a.username]);
  assert.ok(!stored.rows[0].password_hash.includes('correct horse'));
});

test('a full game between two players', async () => {
  const a = await player('a');
  const b = await player('b');
  const outsider = await player('c');

  const created = await call('POST', '/api/games', a.token, { opponent: b.username });
  assert.equal(created.status, 201);
  const id = created.body.game.id as string;
  assert.equal(created.body.game.action, 'pick');

  // Only the two players can see the game, and only the player to move can act.
  assert.equal((await call('GET', `/api/games/${id}`, outsider.token)).status, 404);
  assert.equal((await call('GET', `/api/games/${id}`, b.token)).body.game.action, 'wait');
  assert.equal((await call('POST', `/api/games/${id}/question`, b.token)).status, 409);
  assert.equal((await call('POST', `/api/games/${id}/question`, a.token)).status, 409, 'must pick a category first');
  assert.equal((await call('POST', `/api/games/${id}/category`, a.token, { categoryId: 'nope' })).status, 400);

  let aScore = 0;
  let bScore = 0;
  let first = a;
  let second = b;
  for (let round = 1; round <= 6; round++) {
    await pick(first.token, id);
    // The chooser gets two right, the other player one right, so the first chooser of each round gains a point.
    const afterFirst = await playRound(first.token, id, [true, true, false]);
    assert.equal(afterFirst.action, 'wait');
    assert.deepEqual(afterFirst.rounds[round - 1].mine, [true, true, false]);

    // The second player cannot see the first player's results or the questions before playing them.
    const hidden = (await call('GET', `/api/games/${id}`, second.token)).body.game;
    assert.equal(hidden.action, 'answer');
    assert.deepEqual(hidden.rounds[round - 1].theirs, [null, null, null]);
    assert.equal(hidden.rounds[round - 1].theirsHidden, true);
    assert.equal(hidden.rounds[round - 1].questions, undefined);

    const afterSecond = await playRound(second.token, id, [false, true, false]);
    assert.deepEqual(afterSecond.rounds[round - 1].theirs, [true, true, false]);
    assert.equal(afterSecond.rounds[round - 1].questions.length, 3);
    if (first === a) (aScore += 2), (bScore += 1);
    else (bScore += 2), (aScore += 1);
    if (round < 6) {
      assert.equal(afterSecond.action, 'pick', 'second player picks the next category');
      assert.equal(afterSecond.round, round + 1);
    } else {
      assert.equal(afterSecond.action, 'finished');
    }
    [first, second] = [second, first];
  }

  const final = (await call('GET', `/api/games/${id}`, a.token)).body.game;
  assert.equal(final.status, 'finished');
  assert.equal(final.me.score, aScore);
  assert.equal(final.opponent.score, bScore);
  assert.equal(aScore, bScore);
  assert.equal(final.result.outcome, 'draw');
  assert.equal(final.result.ratingDelta, 0);
  assert.equal(final.result.xpGained, aScore * 10 + 25);
  const me = (await call('GET', '/api/me', a.token)).body;
  assert.equal(me.user.draws, 1);
  assert.equal(me.user.xp, aScore * 10 + 25);
  assert.equal(me.categories.reduce((n: number, c: { total: number }) => n + c.total, 0), 18);
  assert.equal((await call('POST', `/api/games/${id}/question`, a.token)).status, 409);
  const used = await db.query('SELECT count(DISTINCT question_id)::int AS n FROM round_questions WHERE game_id = $1', [id]);
  assert.equal(used.rows[0].n, 18, 'no question repeats within a game');
});

test('matchmaking pairs two random players and the winner gains rating', async () => {
  // Clear any open games left over so this test controls the pool.
  await db.query(`DELETE FROM games WHERE status = 'waiting'`);
  const a = await player('m');
  const b = await player('m');
  const g1 = (await call('POST', '/api/games', a.token, {})).body.game;
  assert.equal(g1.status, 'waiting');
  assert.equal(g1.opponent, null);
  assert.equal((await call('POST', '/api/games', a.token, {})).body.game.id, g1.id, 'no second open game');

  // The creator can already play round 1 before anyone joins.
  await pick(a.token, g1.id);
  const waiting = await playRound(a.token, g1.id, [true, true, true]);
  assert.equal(waiting.action, 'wait');

  const joined = (await call('POST', '/api/games', b.token, {})).body.game;
  assert.equal(joined.id, g1.id);
  assert.equal(joined.status, 'active');
  assert.equal(joined.action, 'answer');
  assert.equal(joined.opponent.username, a.username);

  const resigned = await call('POST', `/api/games/${g1.id}/resign`, b.token);
  assert.equal(resigned.body.game.result.outcome, 'loss');
  assert.equal(resigned.body.game.result.reason, 'resigned');
  assert.equal(resigned.body.game.result.ratingDelta, -16);
  const winner = (await call('GET', '/api/me', a.token)).body.user;
  assert.equal(winner.rating, 1216);
  assert.equal(winner.wins, 1);
  assert.equal(winner.streak, 1);
  const board = (await call('GET', '/api/leaderboard', a.token)).body.players;
  assert.equal(board[0].username, a.username);
});

test('the answer timer is enforced on the server', async () => {
  const a = await player('t');
  const b = await player('t');
  const id = (await call('POST', '/api/games', a.token, { opponent: b.username })).body.game.id;
  await pick(a.token, id);

  // Asking again returns the same question with less time, not a fresh one.
  const q1 = (await call('POST', `/api/games/${id}/question`, a.token)).body.question;
  await db.query(`UPDATE answers SET served_at = served_at - interval '5 seconds' WHERE game_id = $1`, [id]);
  const q1again = (await call('POST', `/api/games/${id}/question`, a.token)).body.question;
  assert.equal(q1again.text, q1.text);
  assert.ok(q1again.msLeft <= 15000 && q1again.msLeft > 13000, `msLeft was ${q1again.msLeft}`);

  // A correct answer that arrives too late counts as wrong.
  await db.query(`UPDATE answers SET served_at = served_at - interval '30 seconds' WHERE game_id = $1`, [id]);
  const { rows } = await db.query('SELECT answers[1] AS correct FROM questions WHERE text = $1', [q1.text]);
  const late = await call('POST', `/api/games/${id}/answer`, a.token, { choice: q1.answers.indexOf(rows[0].correct) });
  assert.equal(late.body.timedOut, true);
  assert.equal(late.body.correct, false);
  assert.equal((await call('POST', `/api/games/${id}/answer`, a.token, { choice: 0 })).status, 409, 'no double answers');

  // A question that was shown and then abandoned is marked wrong and the next one is served.
  const q2 = (await call('POST', `/api/games/${id}/question`, a.token)).body.question;
  assert.equal(q2.position, 1);
  await db.query(`UPDATE answers SET served_at = served_at - interval '60 seconds' WHERE game_id = $1 AND pos = 1`, [id]);
  const q3 = (await call('POST', `/api/games/${id}/question`, a.token)).body.question;
  assert.equal(q3.position, 2);
  const state = (await call('GET', `/api/games/${id}`, a.token)).body.game;
  assert.deepEqual(state.rounds[0].mine, [false, false, null]);

  // Abandoning the last question of the round passes the turn once the timer has run out.
  await db.query(`UPDATE answers SET served_at = served_at - interval '60 seconds' WHERE game_id = $1 AND pos = 2`, [id]);
  assert.equal((await call('GET', `/api/games/${id}`, b.token)).body.game.action, 'answer');
});

test('a player who stops playing forfeits', async () => {
  const a = await player('f');
  const b = await player('f');
  const id = (await call('POST', '/api/games', a.token, { opponent: b.username })).body.game.id;
  assert.equal(await sweepTimeouts(db), 0);
  await db.query(`UPDATE games SET turn_started_at = now() - interval '73 hours' WHERE id = $1`, [id]);
  assert.equal(await sweepTimeouts(db), 1);
  const game = (await call('GET', `/api/games/${id}`, b.token)).body.game;
  assert.equal(game.result.outcome, 'win');
  assert.equal(game.result.reason, 'timeout');
});

test('question admin requires the token', async () => {
  assert.equal((await call('GET', '/admin/api/questions')).status, 401);
  assert.equal((await call('GET', '/admin/api/questions', 'wrong')).status, 401);
  const admin = 'test-admin-token';
  const cats = (await call('GET', '/admin/api/categories', admin)).body.categories;
  assert.equal(cats.length, 10);
  assert.ok(cats.every((c: { questions: number }) => c.questions >= 30));
  const q = { categoryId: 'music', text: 'Which test question is this?', answers: ['This one', 'That one', 'Another', 'None'] };
  const created = await call('POST', '/admin/api/questions', admin, q);
  assert.equal(created.status, 201);
  assert.equal((await call('POST', '/admin/api/questions', admin, q)).status, 409);
  assert.equal((await call('POST', '/admin/api/questions', admin, { ...q, text: 'Other?', answers: ['a', 'A', 'b', 'c'] })).status, 400);
  assert.equal((await call('PUT', `/admin/api/questions/${created.body.id}`, admin, { ...q, difficulty: 3 })).status, 200);
  const found = (await call('GET', '/admin/api/questions?search=test%20question', admin)).body.questions;
  assert.equal(found[0].difficulty, 3);
  assert.equal((await call('DELETE', `/admin/api/questions/${created.body.id}`, admin)).body.retired, false);
});
