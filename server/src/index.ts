import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { sweepTimeouts } from './game.js';
import { importQuestions } from './seed.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);

const { rows } = await db.query('SELECT count(*)::int AS n FROM questions');
if (rows[0].n === 0) {
  const result = await importQuestions(db);
  console.log(`Seeded ${result.questions} questions in ${result.categories} categories`);
}

const app = await buildApp(config, db);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Quiz server listening on :${config.port}${config.adminToken ? ' (admin enabled at /admin)' : ''}`);

const sweep = setInterval(() => {
  sweepTimeouts(db).catch((err) => console.error('sweep failed', err));
}, 5 * 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    clearInterval(sweep);
    await app.close();
    await db.end();
    process.exit(0);
  });
}
