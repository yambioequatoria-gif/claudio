import { Platform } from 'react-native';

const configured = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');
// On the web the server normally hosts the app itself, so relative URLs work.
export const API_URL = configured ?? (Platform.OS === 'web' ? '' : 'http://localhost:3000');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, options: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? 'Something went wrong');
  return data as T;
}

export interface Category {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

export interface User {
  id: string;
  username: string;
  rating: number;
  xp: number;
  level: number;
  xpIntoLevel: number;
  xpForLevel: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
  rank?: number;
}

export interface RoundView {
  number: number;
  category: Category | null;
  chooserIsMe: boolean | null;
  mine: (boolean | null)[];
  theirs: (boolean | null)[];
  theirsHidden: boolean;
  questions?: { text: string; correctAnswer: string; myAnswer: string | null; theirAnswer: string | null }[];
}

export interface Game {
  id: string;
  status: 'waiting' | 'active' | 'finished';
  round: number;
  totalRounds: number;
  questionsPerRound: number;
  answerSeconds: number;
  me: { username: string; rating: number; score: number };
  opponent: { username: string; rating: number; score: number } | null;
  myTurn: boolean;
  action: 'pick' | 'answer' | 'wait' | 'finished';
  offered: Category[];
  rounds: RoundView[];
  result: { outcome: 'win' | 'loss' | 'draw'; reason: string; ratingDelta: number; xpGained: number } | null;
  turnDeadline: string | null;
  updatedAt: string;
}

export interface Question {
  round: number;
  position: number;
  total: number;
  category: Category;
  text: string;
  answers: string[];
  msLeft: number;
  answerSeconds: number;
}

export interface AnswerResult {
  correct: boolean;
  timedOut: boolean;
  correctIndex: number;
  roundComplete: boolean;
  game: Game;
}
