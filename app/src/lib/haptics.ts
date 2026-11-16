import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function buzz(kind: 'tap' | 'good' | 'bad') {
  if (Platform.OS === 'web') return;
  const run =
    kind === 'tap'
      ? Haptics.selectionAsync()
      : Haptics.notificationAsync(
          kind === 'good' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
        );
  run.catch(() => {});
}
