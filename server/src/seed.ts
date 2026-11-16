import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createPool, migrate, tx, type Db } from './db.js';

const QUESTIONS_DIR = path.join(import.meta.dirname, '..', 'questions');

const fileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  emoji: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  questions: z.array(
    z.object({
      q: z.string().min(5),
      // First answer is the correct one.
      a: z.array(z.string().min(1)).length(4),
      d: z.number().int().min(1).max(3).default(2),
    }),
  ),
});

/** Loads every questions/*.json file. Safe to run repeatedly: existing questions are updated, not duplicated. */
export async function importQuestions(db: Db, dir = QUESTIONS_DIR): Promise<{ categories: number; questions: number }> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  let count = 0;
  await tx(db, async (c) => {
    for (const file of files) {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.message}`);
      const cat = parsed.data;
      await c.query(
        `INSERT INTO categories (id, name, emoji, color) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, color = EXCLUDED.color`,
        [cat.id, cat.name, cat.emoji, cat.color],
      );
      for (const q of cat.questions) {
        if (new Set(q.a.map((x) => x.toLowerCase())).size !== 4) throw new Error(`${file}: duplicate answers in "${q.q}"`);
        await c.query(
          `INSERT INTO questions (category_id, text, answers, difficulty) VALUES ($1, $2, $3, $4)
           ON CONFLICT (category_id, text) DO UPDATE SET answers = EXCLUDED.answers, difficulty = EXCLUDED.difficulty`,
          [cat.id, q.q, q.a, q.d],
        );
        count++;
      }
    }
  });
  return { categories: files.length, questions: count };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool(loadConfig().databaseUrl);
  await migrate(db);
  const result = await importQuestions(db);
  console.log(`Imported ${result.questions} questions in ${result.categories} categories`);
  await db.end();
}
