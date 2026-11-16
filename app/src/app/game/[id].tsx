import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Dots, ErrorNote, Loading, Screen, Txt } from '@/components/ui';
import type { Game, RoundView } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useColors } from '@/lib/theme';
import { usePolled } from '@/lib/use-polled';

function timeLeft(deadline: string) {
  const hours = Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 3600_000));
  return hours >= 24 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
}

function Round({ round, current }: { round: RoundView; current: boolean }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const canOpen = !!round.questions?.length;
  return (
    <Pressable
      disabled={!canOpen}
      accessibilityRole={canOpen ? 'button' : undefined}
      accessibilityLabel={`Round ${round.number}${round.category ? `, ${round.category.name}` : ''}${canOpen ? ', show questions' : ''}`}
      onPress={() => setOpen(!open)}
      style={[styles.round, { borderColor: current ? c.primary : c.line, backgroundColor: c.card }]}>
      <View style={styles.roundRow}>
        <Dots results={round.mine} />
        <View style={styles.roundMiddle}>
          <Txt size={12} muted weight="700">
            ROUND {round.number}
          </Txt>
          <Txt size={15} weight="700" center numberOfLines={1} color={round.category?.color}>
            {round.category ? `${round.category.emoji} ${round.category.name}` : '—'}
          </Txt>
        </View>
        {round.theirsHidden ? (
          <Txt size={13} muted style={{ width: 66, textAlign: 'right' }}>
            hidden
          </Txt>
        ) : (
          <Dots results={round.theirs} />
        )}
      </View>
      {open && round.questions
        ? round.questions.map((q, i) => (
            <View key={i} style={[styles.review, { borderTopColor: c.line }]}>
              <Txt size={14} weight="600">
                {q.text}
              </Txt>
              <Txt size={14} color={c.good}>
                ✓ {q.correctAnswer}
              </Txt>
              {q.myAnswer !== q.correctAnswer ? (
                <Txt size={14} color={c.bad}>
                  You: {q.myAnswer ?? 'ran out of time'}
                </Txt>
              ) : null}
            </View>
          ))
        : null}
    </Pressable>
  );
}

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, call } = useAuth();
  const c = useColors();
  const [confirmResign, setConfirmResign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: game, error, refresh, setData } = usePolled(
    async () => (token ? (await call<{ game: Game }>(`/games/${id}`)).game : null),
    8000,
  );

  if (!token) return <Redirect href="/login" />;
  if (!game) {
    return (
      <Screen title="Game" back="/">
        {error ? <ErrorNote message={error} onRetry={refresh} /> : <Loading />}
      </Screen>
    );
  }

  const resign = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await call<{ game: Game | null }>(`/games/${id}/resign`, { method: 'POST' });
      if (res.game) setData(res.game);
      else router.replace('/');
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmResign(false);
    }
  };

  const rematch = async () => {
    if (!game.opponent) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await call<{ game: Game }>('/games', { body: { opponent: game.opponent.username } });
      router.replace(`/game/${res.game.id}`);
    } catch (e) {
      setActionError((e as Error).message);
      setBusy(false);
    }
  };

  const result = game.result;
  const headline = result
    ? result.outcome === 'win'
      ? '🏆 You won!'
      : result.outcome === 'loss'
        ? 'You lost'
        : "It's a draw"
    : null;
  const reason =
    result?.reason === 'resigned'
      ? result.outcome === 'win'
        ? 'Your opponent resigned.'
        : 'You resigned.'
      : result?.reason === 'timeout'
        ? result.outcome === 'win'
          ? 'Your opponent ran out of time.'
          : 'You ran out of time to play.'
        : null;

  return (
    <Screen title="Game" back="/">
      <Card>
        <View style={styles.scoreRow}>
          <View style={styles.player}>
            <Avatar name={game.me.username} size={56} />
            <Txt weight="700" numberOfLines={1}>
              {game.me.username}
            </Txt>
            <Txt size={13} muted>
              {game.me.rating}
            </Txt>
          </View>
          <Txt testID="score" size={44} weight="800">
            {game.me.score} : {game.opponent?.score ?? 0}
          </Txt>
          <View style={styles.player}>
            <Avatar name={game.opponent?.username ?? '?'} size={56} />
            <Txt weight="700" numberOfLines={1}>
              {game.opponent?.username ?? '???'}
            </Txt>
            <Txt size={13} muted>
              {game.opponent?.rating ?? ''}
            </Txt>
          </View>
        </View>
      </Card>

      {result ? (
        <Card style={{ alignItems: 'center' }}>
          <Txt testID="result" size={28} weight="800" color={result.outcome === 'win' ? c.good : result.outcome === 'loss' ? c.bad : c.text}>
            {headline}
          </Txt>
          {reason ? <Txt muted>{reason}</Txt> : null}
          <Txt weight="700">
            +{result.xpGained} XP · {result.ratingDelta >= 0 ? '+' : ''}
            {result.ratingDelta} rating
          </Txt>
          <View style={{ alignSelf: 'stretch' }}>
            <Button label="Rematch" busy={busy} onPress={rematch} />
          </View>
        </Card>
      ) : game.myTurn ? (
        <Button
          testID="play"
          label={game.action === 'pick' ? `Pick a category for round ${game.round}` : `Play round ${game.round}`}
          onPress={() => router.replace(`/play/${game.id}`)}
        />
      ) : (
        <Card>
          <Txt testID="waiting" center weight="700">
            {game.opponent ? `Waiting for ${game.opponent.username} to play` : 'Looking for an opponent'}
          </Txt>
          <Txt center muted size={14}>
            {game.opponent && game.turnDeadline
              ? `They have ${timeLeft(game.turnDeadline)} left before they forfeit.`
              : 'Your round is saved. The game continues as soon as someone joins.'}
          </Txt>
        </Card>
      )}
      {game.myTurn && game.turnDeadline ? (
        <Txt center muted size={13}>
          You have {timeLeft(game.turnDeadline)} to take your turn.
        </Txt>
      ) : null}
      {actionError ? <ErrorNote message={actionError} /> : null}
      {error ? <ErrorNote message={error} onRetry={refresh} /> : null}

      <View style={{ gap: 8 }}>
        {game.rounds.map((r) => (
          <Round key={r.number} round={r} current={!result && r.number === game.round} />
        ))}
      </View>
      <Txt center muted size={13}>
        Tap a finished round to review its questions.
      </Txt>

      {!result ? (
        confirmResign ? (
          <View style={styles.pair}>
            <View style={{ flex: 1 }}>
              <Button kind="secondary" label="Keep playing" onPress={() => setConfirmResign(false)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button kind="danger" label={game.opponent ? 'Resign and lose' : 'Cancel game'} busy={busy} onPress={resign} />
            </View>
          </View>
        ) : (
          <Button kind="ghost" label={game.opponent ? 'Resign' : 'Cancel this game'} onPress={() => setConfirmResign(true)} />
        )
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  player: { alignItems: 'center', gap: 2, width: 96 },
  round: { borderWidth: 2, borderRadius: 16, padding: 12, gap: 8 },
  roundRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  roundMiddle: { flex: 1, alignItems: 'center' },
  review: { borderTopWidth: 1, paddingTop: 8, gap: 2 },
  pair: { flexDirection: 'row', gap: 10 },
});
