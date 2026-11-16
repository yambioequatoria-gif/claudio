import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useColors } from '@/lib/theme';

const MAX_WIDTH = 560;

export function Screen({
  title,
  back,
  replaceOnBack,
  right,
  scroll = true,
  children,
}: {
  title?: string;
  /** Route to return to; shows a back button. */
  back?: string;
  /** Always navigate to `back` instead of popping the history (for screens opened with replace). */
  replaceOnBack?: boolean;
  right?: ReactNode;
  scroll?: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  const header = (title || back) && (
    <View style={styles.header}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          onPress={() => (!replaceOnBack && router.canGoBack() ? router.back() : router.replace(back as never))}
          style={[styles.back, { backgroundColor: c.card, borderColor: c.line }]}>
          <Text style={{ color: c.text, fontSize: 18, fontWeight: '700' }}>‹</Text>
        </Pressable>
      ) : null}
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: c.text }]}>
        {title}
      </Text>
      {right}
    </View>
  );
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.column}>
            {header}
            {children}
          </View>
        </ScrollView>
      ) : (
        <View style={[styles.scroll, { flex: 1 }]}>
          <View style={[styles.column, { flex: 1 }]}>
            {header}
            {children}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

export function Txt({
  size = 16,
  weight = '500',
  muted,
  color,
  center,
  style,
  ...rest
}: TextProps & { size?: number; weight?: '400' | '500' | '600' | '700' | '800'; muted?: boolean; color?: string; center?: boolean }) {
  const c = useColors();
  return (
    <Text
      style={[
        { fontSize: size, lineHeight: Math.round(size * 1.35), fontWeight: weight, color: color ?? (muted ? c.muted : c.text) },
        center && { textAlign: 'center' },
        style,
      ]}
      {...rest}
    />
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.card, borderColor: c.line }, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  small,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  testID?: string;
}) {
  const c = useColors();
  const bg = kind === 'primary' ? c.primary : kind === 'danger' ? c.bad : kind === 'secondary' ? c.cardAlt : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? c.onPrimary : kind === 'ghost' ? c.primary : c.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: small ? 14 : 17, fontWeight: '700', textAlign: 'center' }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Loading() {
  const c = useColors();
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={c.primary} />
    </View>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <View accessibilityRole="alert" style={[styles.error, { borderColor: c.bad }]}>
      <Txt color={c.bad} size={15} style={{ flex: 1 }}>
        {message}
      </Txt>
      {onRetry ? <Button small kind="secondary" label="Retry" onPress={onRetry} /> : null}
    </View>
  );
}

/** Three dots showing how a player did in one round. */
export function Dots({ results }: { results: (boolean | null)[] }) {
  const c = useColors();
  return (
    <View style={styles.dots}>
      {results.map((r, i) => (
        <View
          key={i}
          style={[styles.dot, { backgroundColor: r === null ? c.cardAlt : r ? c.good : c.bad, borderColor: c.line }]}
        />
      ))}
    </View>
  );
}

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  // Stable colour per name so a player is recognisable across screens.
  const hues = ['#6C5CE7', '#00997A', '#E17055', '#0984E3', '#E84393', '#B8860B', '#00838F'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: hues[h % hues.length] }]}>
      <Text style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.42 }}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 16, paddingBottom: 32 },
  column: { width: '100%', maxWidth: MAX_WIDTH, gap: 14, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  title: { flex: 1, fontSize: 24, fontWeight: '800' },
  card: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 10 },
  button: { minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  buttonSmall: { minHeight: 38, borderRadius: 12, paddingHorizontal: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 14, padding: 12 },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
});
