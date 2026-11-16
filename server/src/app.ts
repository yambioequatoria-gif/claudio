import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { hashPassword, safeEqual, verifyPassword } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import {
  getGame,
  HttpError,
  levelForXp,
  listGames,
  pickCategory,
  resign,
  serveQuestion,
  startChallenge,
  startRandomGame,
  submitAnswer,
} from './game.js';

const credentials = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{3,16}$/, 'Username must be 3-16 letters, digits or underscores'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});
const uuid = z.string().uuid();

const userFields = 'id, username, rating, xp, wins, losses, draws, streak, best_streak';
function publicUser(u: any) {
  return {
    id: u.id,
    username: u.username,
    rating: u.rating,
    xp: u.xp,
    ...levelForXp(u.xp),
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    streak: u.streak,
    bestStreak: u.best_streak,
  };
}

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.production, trustProxy: true, bodyLimit: 64 * 1024 });

  await app.register(cors, { origin: config.corsOrigins ?? !config.production });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '30d' } });
  if (config.rateLimit) {
    await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  }
  // Brute-force protection for credential and admin-token guessing.
  const strict = config.rateLimit ? { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } : {};

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_input', message: err.issues[0]?.message ?? 'Invalid input' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    }
    app.log.error(err);
    if (!config.production) console.error(err);
    return reply.status(500).send({ error: 'server_error', message: 'Something went wrong' });
  });

  const userId = async (req: FastifyRequest): Promise<string> => {
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      return payload.sub;
    } catch {
      throw new HttpError(401, 'unauthorized', 'Please sign in again');
    }
  };

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // ------------------------------------------------------------------ accounts

  app.post('/api/auth/register', strict, async (req, reply) => {
    const { username, password } = credentials.parse(req.body);
    const hash = await hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (lower(username)) DO NOTHING RETURNING ${userFields}`,
      [username, hash],
    );
    if (!rows[0]) throw new HttpError(409, 'username_taken', 'That username is taken');
    return reply.status(201).send({ token: app.jwt.sign({ sub: rows[0].id }), user: publicUser(rows[0]) });
  });

  app.post('/api/auth/login', strict, async (req) => {
    const body = z.object({ username: z.string().max(50), password: z.string().max(200) }).parse(req.body);
    const { rows } = await db.query(`SELECT ${userFields}, password_hash FROM users WHERE lower(username) = lower($1)`, [
      body.username.trim(),
    ]);
    // Hash even when the user is unknown so response time does not reveal which usernames exist.
    const ok = rows[0]
      ? await verifyPassword(body.password, rows[0].password_hash)
      : (await hashPassword(body.password), false);
    if (!ok) throw new HttpError(401, 'bad_credentials', 'Wrong username or password');
    return { token: app.jwt.sign({ sub: rows[0].id }), user: publicUser(rows[0]) };
  });

  app.get('/api/me', async (req) => {
    const id = await userId(req);
    const { rows } = await db.query(`SELECT ${userFields} FROM users WHERE id = $1 AND password_hash <> 'deleted'`, [id]);
    if (!rows[0]) throw new HttpError(401, 'unauthorized', 'Please sign in again');
    const { rows: stats } = await db.query(
      `SELECT c.id, c.name, c.emoji, c.color, count(*)::int AS total, count(*) FILTER (WHERE a.correct)::int AS correct
         FROM answers a
         JOIN round_questions rq USING (game_id, round, pos)
         JOIN questions q ON q.id = rq.question_id
         JOIN categories c ON c.id = q.category_id
        WHERE a.user_id = $1 AND a.answered_at IS NOT NULL
        GROUP BY c.id ORDER BY c.name`,
      [id],
    );
    const { rows: rank } = await db.query('SELECT count(*)::int + 1 AS rank FROM users WHERE rating > $1', [
      rows[0].rating,
    ]);
    return { user: { ...publicUser(rows[0]), rank: rank[0].rank }, categories: stats };
  });

  app.delete('/api/me', async (req, reply) => {
    const id = await userId(req);
    const body = z.object({ password: z.string().max(200) }).parse(req.body);
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [id]);
    if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash))) {
      throw new HttpError(401, 'bad_credentials', 'Wrong password');
    }
    // Games are shared with opponents, so the account is anonymised rather than removed.
    await db.query(
      `UPDATE users SET username = 'deleted_' || substr(md5(random()::text), 1, 8), password_hash = 'deleted' WHERE id = $1`,
      [id],
    );
    await db.query(`DELETE FROM games WHERE status = 'waiting' AND player1 = $1`, [id]);
    return reply.status(204).send();
  });

  app.get('/api/leaderboard', async (req) => {
    await userId(req);
    const { rows } = await db.query(
      `SELECT username, rating, xp, wins, losses, draws FROM users
        WHERE password_hash <> 'deleted' ORDER BY rating DESC, wins DESC, username LIMIT 50`,
    );
    return {
      players: rows.map((r, i) => ({ rank: i + 1, ...r, level: levelForXp(r.xp).level })),
    };
  });

  // ------------------------------------------------------------------ games

  app.get('/api/games', async (req) => ({ games: await listGames(db, await userId(req)) }));

  app.post('/api/games', async (req, reply) => {
    const id = await userId(req);
    const body = z.object({ opponent: z.string().trim().min(1).max(50).optional() }).parse(req.body ?? {});
    const game = body.opponent ? await startChallenge(db, id, body.opponent) : await startRandomGame(db, id);
    return reply.status(201).send({ game });
  });

  const gameId = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);

  app.get('/api/games/:id', async (req) => ({ game: await getGame(db, gameId(req), await userId(req)) }));

  app.post('/api/games/:id/category', async (req) => {
    const id = await userId(req);
    const body = z.object({ categoryId: z.string().max(100) }).parse(req.body);
    return { game: await pickCategory(db, gameId(req), id, body.categoryId) };
  });

  app.post('/api/games/:id/question', async (req) => ({
    question: await serveQuestion(db, gameId(req), await userId(req)),
  }));

  app.post('/api/games/:id/answer', async (req) => {
    const id = await userId(req);
    const body = z.object({ choice: z.number().int().min(0).max(3).nullable() }).parse(req.body);
    return submitAnswer(db, gameId(req), id, body.choice);
  });

  app.post('/api/games/:id/resign', async (req) => ({ game: await resign(db, gameId(req), await userId(req)) }));

  // ------------------------------------------------------------------ question admin

  if (config.adminToken) {
    const adminToken = config.adminToken;
    const requireAdmin = (req: FastifyRequest) => {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), adminToken)) {
        throw new HttpError(401, 'unauthorized', 'Invalid admin token');
      }
    };
    const question = z.object({
      categoryId: z.string().min(1).max(100),
      text: z.string().trim().min(5).max(500),
      answers: z
        .array(z.string().trim().min(1).max(200))
        .length(4)
        .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === 4, 'Answers must be different'),
      difficulty: z.number().int().min(1).max(3).default(2),
      active: z.boolean().default(true),
    });
    const adminHtml = path.join(import.meta.dirname, '..', 'public', 'admin.html');

    app.get('/admin', async (_req, reply) => reply.type('text/html').send(await readFile(adminHtml, 'utf8')));

    app.get('/admin/api/categories', strict, async (req) => {
      requireAdmin(req);
      const { rows } = await db.query(
        `SELECT c.*, (SELECT count(*)::int FROM questions q WHERE q.category_id = c.id AND q.active) AS questions
           FROM categories c ORDER BY c.name`,
      );
      return { categories: rows };
    });

    app.post('/admin/api/categories', strict, async (req) => {
      requireAdmin(req);
      const body = z
        .object({
          id: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Id must be lowercase letters, digits and dashes'),
          name: z.string().trim().min(1).max(60),
          emoji: z.string().trim().min(1).max(8),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must look like #1A2B3C'),
        })
        .parse(req.body);
      await db.query(
        `INSERT INTO categories (id, name, emoji, color) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, color = EXCLUDED.color`,
        [body.id, body.name, body.emoji, body.color],
      );
      return { ok: true };
    });

    app.get('/admin/api/questions', async (req) => {
      requireAdmin(req);
      const query = z
        .object({ category: z.string().optional(), search: z.string().optional() })
        .parse(req.query);
      const { rows } = await db.query(
        `SELECT id, category_id AS "categoryId", text, answers, difficulty, active FROM questions
          WHERE ($1::text IS NULL OR category_id = $1)
            AND ($2::text IS NULL OR text ILIKE '%' || $2 || '%' OR array_to_string(answers, ' ') ILIKE '%' || $2 || '%')
          ORDER BY created_at DESC, text LIMIT 500`,
        [query.category || null, query.search || null],
      );
      return { questions: rows };
    });

    const duplicate = (err: any) =>
      err?.code === '23505'
        ? new HttpError(409, 'duplicate', 'This question already exists in that category')
        : err?.code === '23503'
          ? new HttpError(400, 'invalid_category', 'Unknown category')
          : err;

    app.post('/admin/api/questions', async (req, reply) => {
      requireAdmin(req);
      const q = question.parse(req.body);
      const { rows } = await db
        .query(
          'INSERT INTO questions (category_id, text, answers, difficulty, active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [q.categoryId, q.text, q.answers, q.difficulty, q.active],
        )
        .catch((e) => {
          throw duplicate(e);
        });
      return reply.status(201).send({ id: rows[0].id });
    });

    app.put('/admin/api/questions/:id', async (req) => {
      requireAdmin(req);
      const q = question.parse(req.body);
      const { rowCount } = await db
        .query('UPDATE questions SET category_id = $2, text = $3, answers = $4, difficulty = $5, active = $6 WHERE id = $1', [
          gameId(req),
          q.categoryId,
          q.text,
          q.answers,
          q.difficulty,
          q.active,
        ])
        .catch((e) => {
          throw duplicate(e);
        });
      if (!rowCount) throw new HttpError(404, 'not_found', 'Question not found');
      return { ok: true };
    });

    app.delete('/admin/api/questions/:id', async (req) => {
      requireAdmin(req);
      const id = gameId(req);
      // Questions already used in a game are kept for history and only retired.
      const { rows } = await db.query('SELECT 1 FROM round_questions WHERE question_id = $1 LIMIT 1', [id]);
      if (rows[0]) await db.query('UPDATE questions SET active = false WHERE id = $1', [id]);
      else await db.query('DELETE FROM questions WHERE id = $1', [id]);
      return { ok: true, retired: !!rows[0] };
    });
  }

  // ------------------------------------------------------------------ web app (optional)

  if (config.webDir && existsSync(path.join(config.webDir, 'index.html'))) {
    const root = path.resolve(config.webDir);
    await app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/admin')) {
        return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));
  }

  return app;
}
