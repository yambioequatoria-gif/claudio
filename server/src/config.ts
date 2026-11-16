export const ROUNDS = 6;
export const QUESTIONS_PER_ROUND = 3;
export const CATEGORIES_OFFERED = 3;
export const ANSWER_SECONDS = 20;
/** Allowance for network latency on top of ANSWER_SECONDS. */
export const ANSWER_GRACE_MS = 2500;
/** A player who does not move for this long forfeits the game. */
export const TURN_TIMEOUT_HOURS = 72;
export const MAX_OPEN_GAMES = 20;

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  adminToken: string | null;
  corsOrigins: string[] | null;
  port: number;
  production: boolean;
  rateLimit: boolean;
  webDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET || (production ? '' : 'dev-only-secret-do-not-use-in-production');
  if (production && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production');
  }
  const adminToken = env.ADMIN_TOKEN || null;
  if (adminToken && production && adminToken.length < 24) {
    throw new Error('ADMIN_TOKEN must be at least 24 characters in production');
  }
  return {
    databaseUrl: env.DATABASE_URL || 'postgres://quiz:quiz@localhost:5432/quiz',
    jwtSecret,
    adminToken,
    corsOrigins: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean) : null,
    port: Number(env.PORT || 3000),
    production,
    rateLimit: env.RATE_LIMIT !== 'off',
    webDir: env.WEB_DIR || null,
  };
}
