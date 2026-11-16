CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  rating int NOT NULL DEFAULT 1200,
  xp int NOT NULL DEFAULT 0,
  wins int NOT NULL DEFAULT 0,
  losses int NOT NULL DEFAULT 0,
  draws int NOT NULL DEFAULT 0,
  streak int NOT NULL DEFAULT 0,
  best_streak int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
CREATE INDEX users_rating ON users (rating DESC);

CREATE TABLE categories (
  id text PRIMARY KEY,
  name text NOT NULL,
  emoji text NOT NULL DEFAULT '❓',
  color text NOT NULL DEFAULT '#6C5CE7'
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id text NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  text text NOT NULL,
  -- answers[1] is the correct one; the order shown to players is shuffled per game
  answers text[] NOT NULL CHECK (array_length(answers, 1) = 4),
  difficulty smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, text)
);

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player1 uuid NOT NULL REFERENCES users (id),
  player2 uuid REFERENCES users (id),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'finished')),
  current_round int NOT NULL DEFAULT 1,
  turn uuid,
  turn_started_at timestamptz NOT NULL DEFAULT now(),
  winner uuid,
  finish_reason text,
  p1_score int NOT NULL DEFAULT 0,
  p2_score int NOT NULL DEFAULT 0,
  p1_rating_delta int NOT NULL DEFAULT 0,
  p2_rating_delta int NOT NULL DEFAULT 0,
  p1_xp int NOT NULL DEFAULT 0,
  p2_xp int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX games_player1 ON games (player1, updated_at DESC);
CREATE INDEX games_player2 ON games (player2, updated_at DESC);
CREATE INDEX games_status ON games (status, turn_started_at);

CREATE TABLE rounds (
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  number int NOT NULL,
  chooser uuid NOT NULL,
  offered text[] NOT NULL,
  category_id text REFERENCES categories (id),
  PRIMARY KEY (game_id, number)
);

CREATE TABLE round_questions (
  game_id uuid NOT NULL,
  round int NOT NULL,
  pos int NOT NULL,
  question_id uuid NOT NULL REFERENCES questions (id),
  -- permutation of 0..3: answer_order[i+1] is the index into questions.answers shown at slot i
  answer_order int[] NOT NULL,
  PRIMARY KEY (game_id, round, pos),
  FOREIGN KEY (game_id, round) REFERENCES rounds (game_id, number) ON DELETE CASCADE
);
CREATE INDEX round_questions_question ON round_questions (question_id);

CREATE TABLE answers (
  game_id uuid NOT NULL,
  round int NOT NULL,
  pos int NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  -- slot the player tapped (as shown to them); NULL means the timer ran out
  chosen smallint,
  correct boolean NOT NULL DEFAULT false,
  served_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  PRIMARY KEY (game_id, round, pos, user_id),
  FOREIGN KEY (game_id, round, pos) REFERENCES round_questions (game_id, round, pos) ON DELETE CASCADE
);
CREATE INDEX answers_user ON answers (user_id);
