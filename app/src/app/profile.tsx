import { Redirect } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Avatar, Button, Card, ErrorNote, Loading, Screen, Txt } from '@/components/ui';
import type { Category, User } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useColors } from '@/lib/theme';
import { usePolled } from '@/lib/use-polled';

type CategoryStat = Category & { total: number; correct: number };

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.stat}>
      <Txt size={22} weight="800">
        {value}
      </Txt>
      <Txt size={12} muted>
        {label}
      </Txt>
    </View>
  );
}

export default function ProfileScreen() {
  const { token, call, signOut } = useAuth();
  const c = useColors();
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { data, error, refresh } = usePolled(
    async () => (token ? call<{ user: User; categories: CategoryStat[] }>('/me') : null),
    60000,
  );

  if (!token) return <Redirect href="/login" />;
  if (!data) {
    return (
      <Screen title="Profile" back="/">
        {error ? <ErrorNote message={error} onRetry={refresh} /> : <Loading />}
      </Screen>
    );
  }

  const { user, categories } = data;
  const played = user.wins + user.losses + user.draws;
  const answered = categories.reduce((n, x) => n + x.total, 0);
  const correct = categories.reduce((n, x) => n + x.correct, 0);

  const deleteAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    try {
      await call('/me', { method: 'DELETE', body: { password } });
      signOut();
    } catch (e) {
      setDeleteError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Screen title="Profile" back="/">
      <Card style={{ alignItems: 'center' }}>
        <Avatar name={user.username} size={72} />
        <Txt size={24} weight="800">
          {user.username}
        </Txt>
        <Txt muted>
          Level {user.level} · {user.xp} XP · rank #{user.rank}
        </Txt>
        <View style={styles.stats}>
          <Stat label="Rating" value={user.rating} />
          <Stat label="Games" value={played} />
          <Stat label="Wins" value={user.wins} />
          <Stat label="Best streak" value={user.bestStreak} />
        </View>
      </Card>

      <Card>
        <Txt size={18} weight="800">
          Your categories
        </Txt>
        {answered === 0 ? (
          <Txt muted>Play a round to see where you are strongest.</Txt>
        ) : (
          <>
            <Txt muted size={14}>
              {correct} of {answered} answers correct ({Math.round((correct / answered) * 100)}%)
            </Txt>
            {[...categories]
              .sort((a, b) => b.correct / b.total - a.correct / a.total)
              .map((cat) => {
                const pct = Math.round((cat.correct / cat.total) * 100);
                return (
                  <View key={cat.id} style={{ gap: 4 }}>
                    <View style={styles.catRow}>
                      <Txt size={15} weight="600">
                        {cat.emoji} {cat.name}
                      </Txt>
                      <Txt size={15} weight="700">
                        {pct}%
                      </Txt>
                    </View>
                    <View style={[styles.bar, { backgroundColor: c.cardAlt }]}>
                      <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: cat.color }]} />
                    </View>
                  </View>
                );
              })}
          </>
        )}
      </Card>

      <Button testID="sign-out" kind="secondary" label="Sign out" onPress={signOut} />
      {deleting ? (
        <Card>
          <Txt weight="700">Delete your account?</Txt>
          <Txt muted size={14}>
            Your name is removed and you can no longer sign in. Games you played stay visible to your opponents under an
            anonymous name. This cannot be undone.
          </Txt>
          <TextInput
            accessibilityLabel="Password"
            placeholder="Your password"
            placeholderTextColor={c.muted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={[styles.input, { backgroundColor: c.bg, borderColor: c.line, color: c.text }]}
          />
          {deleteError ? <ErrorNote message={deleteError} /> : null}
          <View style={styles.pair}>
            <View style={{ flex: 1 }}>
              <Button kind="secondary" label="Cancel" onPress={() => setDeleting(false)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button kind="danger" label="Delete" busy={busy} disabled={!password} onPress={deleteAccount} />
            </View>
          </View>
        </Card>
      ) : (
        <Button kind="ghost" label="Delete account" onPress={() => setDeleting(true)} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', alignSelf: 'stretch', justifyContent: 'space-around', marginTop: 6 },
  stat: { alignItems: 'center' },
  catRow: { flexDirection: 'row', justifyContent: 'space-between' },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  pair: { flexDirection: 'row', gap: 10 },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, minHeight: 50, fontSize: 17 },
});
