import { useColorScheme } from 'react-native';

const light = {
  bg: '#F3F1FA',
  card: '#FFFFFF',
  cardAlt: '#ECE9F7',
  text: '#1B1830',
  muted: '#6B6880',
  line: '#DDD9EC',
  primary: '#6C5CE7',
  onPrimary: '#FFFFFF',
  good: '#00997A',
  bad: '#D63031',
  gold: '#E0A100',
};

const dark: typeof light = {
  bg: '#121019',
  card: '#1D1A29',
  cardAlt: '#282438',
  text: '#F4F2FB',
  muted: '#A19DB5',
  line: '#322E45',
  primary: '#8576FF',
  onPrimary: '#FFFFFF',
  good: '#1DC9A0',
  bad: '#FF6B6B',
  gold: '#FFC83D',
};

export type Palette = typeof light;

export function useColors(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}
