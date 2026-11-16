import { Redirect } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Avatar, ErrorNote, Loading, Screen, Txt } from '@/components/ui';
import type { User } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useColors } from '@/lib/theme';
import { usePolled } from '@/lib/use-polled';

interface Entry {
  rank: number;
  username: string;
  rating: number;
  level: number;
  wins: number;
  losses: number;
  draws: number;
}

export default function LeaderboardScreen() {
  const { token, call } = useAuth();
  const c = useColors();
  const { data, error, refresh } = usePolled(async () => {
    if (!token) return null;
    const [board, me] = await Promise.all([call<{ players: Entry[] }>('/leaderboard'), call<{ user: User }>('/me')]);
    return { players: board.players, me: me.user };
  }, 60000);

  if (!token) return <Redirect href="/login" />;
  return (
    <Screen title="Leaderboard" back="/">
      {error ? <ErrorNote message={error} onRetry={refresh} /> : null}
      {!data ? (
        error ? null : (
          <Loading />
        )
      ) : (
        <>
          <Txt muted>
            You are ranked #{data.me.rank} with a rating of {data.me.rating}.
          </Txt>
          {data.players.map((p) => {
            const isMe = p.username === data.me.username;
            const medal = p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : `${p.rank}`;
            return (
              <View key={p.username} style={[styles.row, { backgroundColor: c.card, borderColor: isMe ? c.primary : c.line }]}>
                <Txt size={p.rank <= 3 ? 22 : 16} weight="800" center style={{ width: 34 }}>
                  {medal}
                </Txt>
                <Avatar name={p.username} size={38} />
                <View style={{ flex: 1 }}>
                  <Txt weight="700" numberOfLines={1}>
                    {p.username}
                  </Txt>
                  <Txt size={13} muted>
                    Level {p.level} · {p.wins}W {p.draws}D {p.losses}L
                  </Txt>
                </View>
                <Txt size={18} weight="800">
                  {p.rating}
                </Txt>
              </View>
            );
          })}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 16, borderWidth: 2 },
});
