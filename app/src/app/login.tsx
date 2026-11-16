import { Redirect } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';

import { Button, Card, ErrorNote, Screen, Txt } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useColors } from '@/lib/theme';

export default function LoginScreen() {
  const { token, signIn } = useAuth();
  const c = useColors();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) return <Redirect href="/" />;

  const submit = async () => {
    setError(null);
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username.trim())) {
      setError('Username must be 3-16 letters, digits or underscores.');
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await signIn(mode, username.trim(), password);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const input = [styles.input, { backgroundColor: c.bg, borderColor: c.line, color: c.text }];
  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <View style={styles.hero}>
          <Txt size={64} center>
            🍻
          </Txt>
          <Txt size={34} weight="800" center>
            Tavern Trivia
          </Txt>
          <Txt muted center>
            Six rounds. Three questions each. Take your turn whenever you like.
          </Txt>
        </View>
        <Card>
          <Txt size={20} weight="700">
            {mode === 'register' ? 'Create your player' : 'Welcome back'}
          </Txt>
          <TextInput
            testID="username"
            accessibilityLabel="Username"
            placeholder="Username"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={16}
            value={username}
            onChangeText={setUsername}
            style={input}
          />
          <TextInput
            testID="password"
            accessibilityLabel="Password"
            placeholder={mode === 'register' ? 'Password (8+ characters)' : 'Password'}
            placeholderTextColor={c.muted}
            secureTextEntry
            autoCapitalize="none"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={submit}
            style={input}
          />
          {error ? <ErrorNote message={error} /> : null}
          <Button testID="submit" label={mode === 'register' ? 'Start playing' : 'Sign in'} busy={busy} onPress={submit} />
          <Button
            testID="switch-mode"
            kind="ghost"
            label={mode === 'register' ? 'I already have an account' : 'Create a new account'}
            onPress={() => {
              setMode(mode === 'register' ? 'login' : 'register');
              setError(null);
            }}
          />
        </Card>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 20, paddingTop: 24 },
  hero: { gap: 6, alignItems: 'center' },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, minHeight: 50, fontSize: 17 },
});
