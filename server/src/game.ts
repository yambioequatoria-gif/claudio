import {
  ANSWER_GRACE_MS,
  ANSWER_SECONDS,
  CATEGORIES_OFFERED,
  MAX_OPEN_GAMES,
  QUESTIONS_PER_ROUND,
  ROUNDS,
  TURN_TIMEOUT_HOURS,
} from './config.js';
import type { Db, Tx } from './db.js';
import { tx } from './db.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface GameRow {
  id: string;
  player1: string;
  player2: string | null;
  status: 'waiting' | 'active' | 'finished';
  current_round: number;
  turn: string | null;
  turn_started_at: Date;
  winner: string | null;
  finish_reason: string | null;
  p1_score: number;
  p2_score: number;
  p1_rating_delta: number;
  p2_rating_delta: number;
  p1_xp: number;
  p2_xp: number;
  updated_at: Date;
}

const ANSWER_LIMIT_MS = ANSWER_SECONDS * 1000 + ANSWER_GRACE_MS;

export function levelForXp(xp: number) {
  const level = Math.floor(Math.sqrt(xp / 50)) + 1;
  const floor = 50 * (level - 1) ** 2;
  const next = 50 * level ** 2;
  return { level, xpIntoLevel: xp - floor, xpForLevel: next - floor };
}

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function lockGame(c: Tx, gameId: string, userId: string): Promise<GameRow> {
  const { rows } = await c.query<GameRow>('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
  const game = rows[0];
  // Same response for "missing" and "not yours" so game ids cannot be probed.
  if (!game || (game.player1 !== userId && game.player2 !== userId)) {
    throw new HttpError(404, 'not_found', 'Game not found');
  }
  return game;
}

async function createRound(c: Tx, gameId: string, number: number, chooser: string) {
  const { rows } = await c.query<{ id: string }>(
    `SELECT c.id FROM categories c
      WHERE (SELECT count(*) FROM questions q
              WHERE q.category_id = c.id AND q.active
                AND q.id NOT IN (SELECT question_id FROM round_questions WHERE game_id = $1)) >= $2
      ORDER BY random() LIMIT $3`,
    [gameId, QUESTIONS_PER_ROUND, CATEGORIES_OFFERED],
  );
  if (rows.length === 0) throw new HttpError(503, 'no_questions', 'No questions are available yet');
  await c.query('INSERT INTO rounds (game_id, number, chooser, offered) VALUES ($1, $2, $3, $4)', [
    gameId,
    number,
    chooser,
    rows.map((r) => r.id),
  ]);
}

/** Marks questions that were shown but not answered in time as wrong. */
async function expireStale(c: Tx, gameId: string) {
  await c.query(
    `UPDATE answers SET answered_at = served_at + make_interval(secs => $2), correct = false, chosen = NULL
      WHERE game_id = $1 AND answered_at IS NULL AND served_at < now() - make_interval(secs => $3)`,
    [gameId, ANSWER_SECONDS, ANSWER_LIMIT_MS / 1000],
  );
}

async function finishGame(c: Tx, game: GameRow, reason: string, forcedWinner?: string) {
  if (!game.player2) throw new Error('cannot finish a game without an opponent');
  const { rows: scoreRows } = await c.query<{ user_id: string; n: number }>(
    'SELECT user_id, count(*)::int AS n FROM answers WHERE game_id = $1 AND correct GROUP BY user_id',
    [game.id],
  );
  const score = (id: string) => scoreRows.find((r) => r.user_id === id)?.n ?? 0;
  const s1 = score(game.player1);
  const s2 = score(game.player2);
  const winner = forcedWinner ?? (s1 > s2 ? game.player1 : s2 > s1 ? game.player2 : null);

  // Lock both users in a stable order so two games finishing at once cannot deadlock.
  const { rows: users } = await c.query<{ id: string; rating: number }>(
    'SELECT id, rating FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE',
    [[game.player1, game.player2]],
  );
  const r1 = users.find((u) => u.id === game.player1)!.rating;
  const r2 = users.find((u) => u.id === game.player2)!.rating;
  const outcome1 = winner === null ? 0.5 : winner === game.player1 ? 1 : 0;
  const expected1 = 1 / (1 + 10 ** ((r2 - r1) / 400));
  const d1 = Math.round(32 * (outcome1 - expected1));
  const d2 = -d1;
  const xp = (correct: number, outcome: number) => correct * 10 + (outcome === 1 ? 50 : outcome === 0.5 ? 25 : 10);
  const xp1 = xp(s1, outcome1);
  const xp2 = xp(s2, 1 - outcome1);

  const applyUser = (id: string, delta: number, gained: number, outcome: number) =>
    c.query(
      `UPDATE users SET rating = GREATEST(100, rating + $2), xp = xp + $3,
              wins = wins + $4, draws = draws + $5, losses = losses + $6,
              streak = CASE WHEN $4 = 1 THEN streak + 1 WHEN $6 = 1 THEN 0 ELSE streak END,
              best_streak = GREATEST(best_streak, CASE WHEN $4 = 1 THEN streak + 1 ELSE streak END)
        WHERE id = $1`,
      [id, delta, gained, outcome === 1 ? 1 : 0, outcome === 0.5 ? 1 : 0, outcome === 0 ? 1 : 0],
    );
  await applyUser(game.player1, d1, xp1, outcome1);
  await applyUser(game.player2, d2, xp2, 1 - outcome1);

  await c.query(
    `UPDATE games SET status = 'finished', turn = NULL, winner = $2, finish_reason = $3,
            p1_score = $4, p2_score = $5, p1_rating_delta = $6, p2_rating_delta = $7,
            p1_xp = $8, p2_xp = $9, updated_at = now()
      WHERE id = $1`,
    [game.id, winner, reason, s1, s2, d1, d2, xp1, xp2],
  );
}

/** Moves the game forward after answers were recorded: passes the turn, opens the next round or finishes. */
async function advance(c: Tx, game: GameRow) {
  if (game.status === 'finished') return;
  const { rows } = await c.query<{ user_id: string; n: number }>(
    `SELECT user_id, count(*)::int AS n FROM answers
      WHERE game_id = $1 AND round = $2 AND answered_at IS NOT NULL GROUP BY user_id`,
    [game.id, game.current_round],
  );
  const done = (id: string | null) => !!id && (rows.find((r) => r.user_id === id)?.n ?? 0) >= QUESTIONS_PER_ROUND;
  const done1 = done(game.player1);
  const done2 = done(game.player2);

  if (done1 && done2) {
    if (game.current_round >= ROUNDS) {
      await finishGame(c, game, 'completed');
      return;
    }
    // Whoever played second picks the next category and keeps the turn.
    const { rows: r } = await c.query<{ chooser: string }>(
      'SELECT chooser FROM rounds WHERE game_id = $1 AND number = $2',
      [game.id, game.current_round],
    );
    const next = r[0].chooser === game.player1 ? game.player2! : game.player1;
    await createRound(c, game.id, game.current_round + 1, next);
    await c.query(
      'UPDATE games SET current_round = current_round + 1, turn = $2, turn_started_at = now(), updated_at = now() WHERE id = $1',
      [game.id, next],
    );
    return;
  }
  if (game.turn && done(game.turn)) {
    const other = game.turn === game.player1 ? game.player2 : game.player1;
    await c.query('UPDATE games SET turn = $2, turn_started_at = now(), updated_at = now() WHERE id = $1', [
      game.id,
      other,
    ]);
  }
}

async function settle(c: Tx, gameId: string, userId: string): Promise<GameRow> {
  const game = await lockGame(c, gameId, userId);
  if (game.status === 'finished') return game;
  await expireStale(c, gameId);
  await advance(c, game);
  return (await c.query<GameRow>('SELECT * FROM games WHERE id = $1', [gameId])).rows[0];
}

function requireTurn(game: GameRow, userId: string) {
  if (game.status === 'finished') throw new HttpError(409, 'game_finished', 'This game is over');
  if (game.turn !== userId) throw new HttpError(409, 'not_your_turn', 'It is not your turn');
}

// ---------------------------------------------------------------------------------------------
// Views

async function buildView(c: Tx, game: GameRow, userId: string, detail: boolean) {
  const isP1 = game.player1 === userId;
  const opponentId = isP1 ? game.player2 : game.player1;
  const { rows: users } = await c.query<{ id: string; username: string; rating: number; xp: number }>(
    'SELECT id, username, rating, xp FROM users WHERE id = ANY($1)',
    [[game.player1, game.player2].filter(Boolean)],
  );
  const { rows: rounds } = await c.query(
    `SELECT r.number, r.chooser, r.offered, r.category_id FROM rounds r WHERE r.game_id = $1 ORDER BY r.number`,
    [game.id],
  );
  const { rows: answers } = await c.query(
    `SELECT a.round, a.pos, a.user_id, a.chosen, a.correct, a.answered_at IS NOT NULL AS done
       FROM answers a WHERE a.game_id = $1`,
    [game.id],
  );
  const { rows: categories } = await c.query('SELECT id, name, emoji, color FROM categories');
  const category = (id: string | null) => categories.find((x) => x.id === id) ?? null;
  const questions = detail
    ? (
        await c.query(
          `SELECT rq.round, rq.pos, rq.answer_order, q.text, q.answers
             FROM round_questions rq JOIN questions q ON q.id = rq.question_id WHERE rq.game_id = $1`,
          [game.id],
        )
      ).rows
    : [];

  const finished = game.status === 'finished';
  let myScore = 0;
  let theirScore = 0;
  const roundViews = [];
  for (let n = 1; n <= ROUNDS; n++) {
    const round = rounds.find((r) => r.number === n);
    const results = (uid: string | null) =>
      Array.from({ length: QUESTIONS_PER_ROUND }, (_, pos) => {
        const a = answers.find((x) => x.round === n && x.pos === pos && x.user_id === uid && x.done);
        return a ? (a.correct as boolean) : null;
      });
    const mine = results(userId);
    const iAmDone = mine.every((x) => x !== null);
    // The opponent's answers stay hidden until you have played the same questions.
    const theirsVisible = iAmDone || finished;
    const theirs = theirsVisible ? results(opponentId) : results(null);
    myScore += mine.filter(Boolean).length;
    theirScore += theirs.filter(Boolean).length;
    const view: Record<string, unknown> = {
      number: n,
      category: round ? category(round.category_id) : null,
      chooserIsMe: round ? round.chooser === userId : null,
      mine,
      theirs,
      theirsHidden: !theirsVisible && !!round,
    };
    if (detail && round && theirsVisible) {
      view.questions = questions
        .filter((q) => q.round === n)
        .sort((a, b) => a.pos - b.pos)
        .map((q) => {
          const pick = (uid: string | null) => {
            const a = answers.find((x) => x.round === n && x.pos === q.pos && x.user_id === uid && x.done);
            return a && a.chosen !== null ? (q.answers[q.answer_order[a.chosen]] as string) : null;
          };
          return { text: q.text, correctAnswer: q.answers[0], myAnswer: pick(userId), theirAnswer: pick(opponentId) };
        });
    }
    roundViews.push(view);
  }

  const current = rounds.find((r) => r.number === game.current_round);
  let action: 'pick' | 'answer' | 'wait' | 'finished';
  if (finished) action = 'finished';
  else if (game.turn !== userId) action = 'wait';
  else action = current && current.category_id ? 'answer' : 'pick';

  const me = users.find((u) => u.id === userId)!;
  const opp = users.find((u) => u.id === opponentId);
  const result = finished
    ? {
        outcome: game.winner === null ? 'draw' : game.winner === userId ? 'win' : 'loss',
        reason: game.finish_reason,
        ratingDelta: isP1 ? game.p1_rating_delta : game.p2_rating_delta,
        xpGained: isP1 ? game.p1_xp : game.p2_xp,
      }
    : null;

  return {
    id: game.id,
    status: game.status,
    round: game.current_round,
    totalRounds: ROUNDS,
    questionsPerRound: QUESTIONS_PER_ROUND,
    answerSeconds: ANSWER_SECONDS,
    me: { username: me.username, rating: me.rating, score: myScore },
    opponent: opp ? { username: opp.username, rating: opp.rating, score: theirScore } : null,
    myTurn: game.turn === userId && !finished,
    action,
    offered: action === 'pick' && current ? (current.offered as string[]).map(category).filter(Boolean) : [],
    rounds: roundViews,
    result,
    turnDeadline:
      game.status === 'active'
        ? new Date(game.turn_started_at.getTime() + TURN_TIMEOUT_HOURS * 3600_000).toISOString()
        : null,
    updatedAt: game.updated_at.toISOString(),
  };
}

export type GameView = Awaited<ReturnType<typeof buildView>>;

export function getGame(db: Db, gameId: string, userId: string): Promise<GameView> {
  return tx(db, async (c) => buildView(c, await settle(c, gameId, userId), userId, true));
}

export function listGames(db: Db, userId: string): Promise<GameView[]> {
  return tx(db, async (c) => {
    const { rows } = await c.query<GameRow>(
      `SELECT * FROM games
        WHERE (player1 = $1 OR player2 = $1)
          AND (status <> 'finished' OR updated_at > now() - interval '14 days')
        ORDER BY updated_at DESC LIMIT 60`,
      [userId],
    );
    const views = [];
    for (const game of rows) views.push(await buildView(c, game, userId, false));
    return views;
  });
}

// ---------------------------------------------------------------------------------------------
// Starting games

async function openGameCount(c: Tx, userId: string) {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM games WHERE status <> 'finished' AND (player1 = $1 OR player2 = $1)`,
    [userId],
  );
  return rows[0].n;
}

/** Joins the oldest open game from another player, or opens a new one that the next player will join. */
export function startRandomGame(db: Db, userId: string): Promise<GameView> {
  return tx(db, async (c) => {
    // One matchmaking request per user at a time, so double taps cannot open two games.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    if ((await openGameCount(c, userId)) >= MAX_OPEN_GAMES) {
      throw new HttpError(409, 'too_many_games', `You can have at most ${MAX_OPEN_GAMES} games in progress`);
    }
    const { rows: mine } = await c.query<GameRow>(
      `SELECT * FROM games WHERE status = 'waiting' AND player1 = $1 LIMIT 1`,
      [userId],
    );
    if (mine[0]) return buildView(c, mine[0], userId, true);

    // Prefer opponents this player is not already playing, and games whose creator has finished round 1.
    const { rows: open } = await c.query<GameRow>(
      `SELECT * FROM games g
        WHERE g.status = 'waiting' AND g.player1 <> $1
        ORDER BY EXISTS (SELECT 1 FROM games o WHERE o.status = 'active'
                          AND ((o.player1 = $1 AND o.player2 = g.player1) OR (o.player2 = $1 AND o.player1 = g.player1))),
                 (g.turn IS NULL) DESC, g.created_at
        LIMIT 1 FOR UPDATE OF g SKIP LOCKED`,
      [userId],
    );
    if (open[0]) {
      const { rows } = await c.query<GameRow>(
        `UPDATE games SET player2 = $2, status = 'active', turn = COALESCE(turn, $2),
                turn_started_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [open[0].id, userId],
      );
      return buildView(c, rows[0], userId, true);
    }
    const { rows } = await c.query<GameRow>('INSERT INTO games (player1, turn) VALUES ($1, $1) RETURNING *', [userId]);
    await createRound(c, rows[0].id, 1, userId);
    return buildView(c, rows[0], userId, true);
  });
}

export function startChallenge(db: Db, userId: string, opponentName: string): Promise<GameView> {
  return tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    const { rows: opp } = await c.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [
      opponentName,
    ]);
    if (!opp[0]) throw new HttpError(404, 'user_not_found', 'No player with that name');
    if (opp[0].id === userId) throw new HttpError(400, 'self_challenge', 'You cannot challenge yourself');
    if ((await openGameCount(c, userId)) >= MAX_OPEN_GAMES) {
      throw new HttpError(409, 'too_many_games', `You can have at most ${MAX_OPEN_GAMES} games in progress`);
    }
    const { rows: existing } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM games WHERE status = 'active'
          AND ((player1 = $1 AND player2 = $2) OR (player1 = $2 AND player2 = $1))`,
      [userId, opp[0].id],
    );
    if (existing[0].n >= 2) {
      throw new HttpError(409, 'already_playing', 'You already have two games running against this player');
    }
    const { rows } = await c.query<GameRow>(
      `INSERT INTO games (player1, player2, status, turn) VALUES ($1, $2, 'active', $1) RETURNING *`,
      [userId, opp[0].id],
    );
    await createRound(c, rows[0].id, 1, userId);
    return buildView(c, rows[0], userId, true);
  });
}

// ---------------------------------------------------------------------------------------------
// Playing

export function pickCategory(db: Db, gameId: string, userId: string, categoryId: string): Promise<GameView> {
  return tx(db, async (c) => {
    const game = await settle(c, gameId, userId);
    requireTurn(game, userId);
    const { rows } = await c.query<{ offered: string[]; category_id: string | null; chooser: string }>(
      'SELECT offered, category_id, chooser FROM rounds WHERE game_id = $1 AND number = $2',
      [gameId, game.current_round],
    );
    const round = rows[0];
    if (!round || round.category_id || round.chooser !== userId) {
      throw new HttpError(409, 'no_pick_pending', 'There is no category to pick right now');
    }
    if (!round.offered.includes(categoryId)) {
      throw new HttpError(400, 'invalid_category', 'That category was not offered');
    }
    // Prefer questions neither player has seen in earlier games.
    const { rows: qs } = await c.query<{ id: string }>(
      `SELECT q.id FROM questions q
        WHERE q.category_id = $1 AND q.active
          AND q.id NOT IN (SELECT question_id FROM round_questions WHERE game_id = $2)
        ORDER BY (SELECT count(*) FROM round_questions rq JOIN answers a USING (game_id, round, pos)
                   WHERE rq.question_id = q.id AND a.user_id = ANY($3)), random()
        LIMIT $4`,
      [categoryId, gameId, [game.player1, game.player2].filter(Boolean), QUESTIONS_PER_ROUND],
    );
    if (qs.length < QUESTIONS_PER_ROUND) throw new HttpError(503, 'no_questions', 'Not enough questions in this category');
    for (let pos = 0; pos < qs.length; pos++) {
      await c.query(
        'INSERT INTO round_questions (game_id, round, pos, question_id, answer_order) VALUES ($1, $2, $3, $4, $5)',
        [gameId, game.current_round, pos, qs[pos].id, shuffled([0, 1, 2, 3])],
      );
    }
    await c.query('UPDATE rounds SET category_id = $3 WHERE game_id = $1 AND number = $2', [
      gameId,
      game.current_round,
      categoryId,
    ]);
    await c.query('UPDATE games SET updated_at = now() WHERE id = $1', [gameId]);
    return buildView(c, game, userId, true);
  });
}

/**
 * Hands out the player's next question and starts its timer. Calling it again while the timer is
 * running returns the same question with the remaining time, so reloading does not buy extra time.
 */
export function serveQuestion(db: Db, gameId: string, userId: string) {
  return tx(db, async (c) => {
    const game = await settle(c, gameId, userId);
    requireTurn(game, userId);
    const { rows } = await c.query(
      `SELECT rq.pos, rq.answer_order, q.text, q.answers, cat.id AS cat_id, cat.name, cat.emoji, cat.color,
              a.served_at, a.answered_at
         FROM round_questions rq
         JOIN questions q ON q.id = rq.question_id
         JOIN categories cat ON cat.id = q.category_id
         LEFT JOIN answers a ON a.game_id = rq.game_id AND a.round = rq.round AND a.pos = rq.pos AND a.user_id = $3
        WHERE rq.game_id = $1 AND rq.round = $2
        ORDER BY rq.pos`,
      [gameId, game.current_round, userId],
    );
    if (rows.length === 0) throw new HttpError(409, 'pick_first', 'Pick a category first');
    const q = rows.find((r) => !r.answered_at);
    if (!q) throw new HttpError(409, 'not_your_turn', 'It is not your turn');
    let servedAt: Date = q.served_at;
    if (!servedAt) {
      servedAt = (
        await c.query<{ served_at: Date }>(
          'INSERT INTO answers (game_id, round, pos, user_id) VALUES ($1, $2, $3, $4) RETURNING served_at',
          [gameId, game.current_round, q.pos, userId],
        )
      ).rows[0].served_at;
    }
    const { rows: now } = await c.query<{ now: Date }>('SELECT now() AS now');
    const elapsed = now[0].now.getTime() - servedAt.getTime();
    return {
      round: game.current_round,
      position: q.pos as number,
      total: QUESTIONS_PER_ROUND,
      category: { id: q.cat_id, name: q.name, emoji: q.emoji, color: q.color },
      text: q.text as string,
      answers: (q.answer_order as number[]).map((i) => q.answers[i] as string),
      msLeft: Math.max(0, ANSWER_SECONDS * 1000 - elapsed),
      answerSeconds: ANSWER_SECONDS,
    };
  });
}

/** Records the answer to the question currently being shown. `choice` is the tapped slot, or null on timeout. */
export function submitAnswer(db: Db, gameId: string, userId: string, choice: number | null) {
  return tx(db, async (c) => {
    const game = await lockGame(c, gameId, userId);
    requireTurn(game, userId);
    const { rows } = await c.query(
      `SELECT a.pos, rq.answer_order, (now() - a.served_at) > make_interval(secs => $4) AS late
         FROM answers a JOIN round_questions rq USING (game_id, round, pos)
        WHERE a.game_id = $1 AND a.round = $2 AND a.user_id = $3 AND a.answered_at IS NULL`,
      [gameId, game.current_round, userId, ANSWER_LIMIT_MS / 1000],
    );
    const pending = rows[0];
    if (!pending) throw new HttpError(409, 'no_question', 'There is no question waiting for an answer');
    const order = pending.answer_order as number[];
    const timedOut = pending.late || choice === null;
    const correct = !timedOut && order[choice!] === 0;
    await c.query(
      `UPDATE answers SET chosen = $5, correct = $6, answered_at = now()
        WHERE game_id = $1 AND round = $2 AND pos = $3 AND user_id = $4`,
      [gameId, game.current_round, pending.pos, userId, timedOut ? null : choice, correct],
    );
    await advance(c, game);
    const after = (await c.query<GameRow>('SELECT * FROM games WHERE id = $1', [gameId])).rows[0];
    return {
      correct,
      timedOut,
      correctIndex: order.indexOf(0),
      roundComplete: pending.pos === QUESTIONS_PER_ROUND - 1,
      game: await buildView(c, after, userId, true),
    };
  });
}

export function resign(db: Db, gameId: string, userId: string): Promise<GameView | null> {
  return tx(db, async (c) => {
    const game = await lockGame(c, gameId, userId);
    if (game.status === 'finished') throw new HttpError(409, 'game_finished', 'This game is over');
    if (!game.player2) {
      // Nobody joined yet: just withdraw the game.
      await c.query('DELETE FROM games WHERE id = $1', [gameId]);
      return null;
    }
    await finishGame(c, game, 'resigned', game.player1 === userId ? game.player2 : game.player1);
    const after = (await c.query<GameRow>('SELECT * FROM games WHERE id = $1', [gameId])).rows[0];
    return buildView(c, after, userId, true);
  });
}

/** Forfeits games whose player to move has been silent for too long and drops stale unjoined games. */
export async function sweepTimeouts(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM games WHERE status = 'active' AND turn_started_at < now() - make_interval(hours => $1) LIMIT 200`,
    [TURN_TIMEOUT_HOURS],
  );
  let forfeited = 0;
  for (const { id } of rows) {
    await tx(db, async (c) => {
      const game = (
        await c.query<GameRow>(
          `SELECT * FROM games WHERE id = $1 AND status = 'active'
              AND turn_started_at < now() - make_interval(hours => $2) FOR UPDATE`,
          [id, TURN_TIMEOUT_HOURS],
        )
      ).rows[0];
      if (!game || !game.turn) return;
      await finishGame(c, game, 'timeout', game.turn === game.player1 ? game.player2! : game.player1);
      forfeited++;
    });
  }
  await db.query(`DELETE FROM games WHERE status = 'waiting' AND updated_at < now() - interval '14 days'`);
  return forfeited;
}
