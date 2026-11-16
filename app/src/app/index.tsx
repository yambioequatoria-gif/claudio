import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Avatar, Button, Card, ErrorNote, Loading, Screen, Txt } from '@/components/ui';
import type { Game, User } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useColors } from '@/lib/theme';
import { usePolled } from '@/lib/use-polled';

function GameRow({ game }: { game: Game }) {
  const c = useColors();
  const name = game.opponent?.username ?? 'Finding an opponent…';
  let status: string;
  let tone = c.muted;
  if (game.result) {
    status = game.result.outcome === 'win' ? 'You won' : game.result.outcome === 'loss' ? 'You lost' : 'Draw';
    tone = game.result.outcome === 'win' ? c.good : game.result.outcome === 'loss' ? c.bad : c.muted;
  } else if (game.myTurn) {
    status = `Your turn · round ${game.round} of ${game.totalRounds}`;
    tone = c.primary;
  } else {
    status = game.opponent ? `Waiting for ${game.opponent.username}` : 'Waiting for someone to join';
  }
  return (
    <Pressable
      testID={`game-${game.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Game against ${name}. ${status}`}
      onPress={() => router.push(`/game/${game.id}`)}
      style={({ pressed }) => [styles.row, { backgroundColor: c.card, borderColor: game.myTurn ? c.primary : c.line, opacity: pressed ? 0.8 : 1 }]}>
      <Avatar name={game.opponent?.username ?? '?'} />
      <View style={{ flex: 1 }}>
        <Txt weight="700" numberOfLines={1}>
          {name}
        </Txt>
        <Txt size={14} color={tone}>
          {status}
        </Txt>
      </View>
      <Txt size={22} weight="800">
        {game.me.score} : {game.opponent?.score ?? 0}
      </Txt>
    </Pressable>
  );
}

function Section({ title, games }: { title: string; games: Game[] }) {
  if (games.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      <Txt size={14} weight="700" muted style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {title}
      </Txt>
      {games.map((g) => (
        <GameRow key={g.id} game={g} />
      ))}
    </View>
  );
}

export default function HomeScreen() {
  const { token, call } = useAuth();
  const c = useColors();
  const [starting, setStarting] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, refresh } = usePolled(async () => {
    if (!token) return null;
    const [me, games] = await Promise.all([
      call<{ user: User }>('/me'),
      call<{ games: Game[] }>('/games'),
    ]);
    return { user: me.user, games: games.games };
  }, 15000);

  if (!token) return <Redirect href="/login" />;
  if (!data) return <Screen>{error ? <ErrorNote message={error} onRetry={refresh} /> : <Loading />}</Screen>;

  const start = async (opponent?: string) => {
    setStarting(true);
    setActionError(null);
    try {
      const res = await call<{ game: Game }>('/games', { body: opponent ? { opponent } : {} });
      setChallenge(null);
      router.push(`/game/${res.game.id}`);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const { user, games } = data;
  const mine = games.filter((g) => g.myTurn);
  const waiting = games.filter((g) => !g.myTurn && g.status !== 'finished');
  const finished = games.filter((g) => g.status === 'finished').slice(0, 10);

  return (
    <Screen>
      <Pressable accessibilityRole="button" accessibilityLabel="Open your profile" onPress={() => router.push('/profile')}>
        <Card style={{ gap: 12 }}>
          <View style={styles.profile}>
            <Avatar name={user.username} size={52} />
            <View style={{ flex: 1 }}>
              <Txt testID="me-name" size={20} weight="800" numberOfLines={1}>
                {user.username}
              </Txt>
              <Txt size={14} muted>
                Level {user.level} · {user.rating} rating
              </Txt>
            </View>
            {user.streak > 1 ? (
              <View style={[styles.pill, { backgroundColor: c.cardAlt }]}>
                <Txt size={14} weight="700">
                  🔥 {user.streak}
                </Txt>
              </View>
            ) : null}
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`${user.xpIntoLevel} of ${user.xpForLevel} experience points to the next level`}
            style={[styles.bar, { backgroundColor: c.cardAlt }]}>
            <View style={[styles.barFill, { backgroundColor: c.gold, width: `${Math.round((user.xpIntoLevel / user.xpForLevel) * 100)}%` }]} />
          </View>
          <Txt size={13} muted>
            {user.xpForLevel - user.xpIntoLevel} XP to level {user.level + 1}
          </Txt>
        </Card>
      </Pressable>

      <Button testID="new-random" label="Play a random opponent" busy={starting && challenge === null} onPress={() => start()} />
      {challenge === null ? (
        <View style={styles.pair}>
          <View style={{ flex: 1 }}>
            <Button testID="new-challenge" kind="secondary" label="Play a friend" onPress={() => setChallenge('')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button testID="leaderboard" kind="secondary" label="Leaderboard" onPress={() => router.push('/leaderboard')} />
          </View>
        </View>
      ) : (
        <Card>
          <Txt weight="700">Who do you want to play?</Txt>
          <TextInput
            testID="challenge-name"
            accessibilityLabel="Friend's username"
            placeholder="Their username"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            value={challenge}
            onChangeText={setChallenge}
            onSubmitEditing={() => challenge.trim() && start(challenge.trim())}
            style={[styles.input, { backgroundColor: c.bg, borderColor: c.line, color: c.text }]}
          />
          <View style={styles.pair}>
            <View style={{ flex: 1 }}>
              <Button kind="secondary" label="Cancel" onPress={() => setChallenge(null)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button testID="challenge-go" label="Challenge" busy={starting} disabled={!challenge.trim()} onPress={() => start(challenge.trim())} />
            </View>
          </View>
        </Card>
      )}
      {actionError ? <ErrorNote message={actionError} /> : null}
      {error ? <ErrorNote message={error} onRetry={refresh} /> : null}

      <Section title="Your turn" games={mine} />
      <Section title="Their turn" games={waiting} />
      <Section title="Finished" games={finished} />
      {games.length === 0 ? (
        <Card>
          <Txt center muted>
            No games yet. Start one above: you play your round now and your opponent answers when they have time.
          </Txt>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, borderWidth: 2 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  bar: { height: 10, borderRadius: 5, overflow: 'hidden' },
  barFill: { height: 10, borderRadius: 5 },
  pair: { flexDirection: 'row', gap: 10 },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, minHeight: 50, fontSize: 17 },
});
