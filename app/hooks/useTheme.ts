import { useColorScheme } from 'react-native';
import { Palette, Spacing, Radius, FontSize, FontWeight, Shadow } from '../theme/tokens';

// ---------------------------------------------------------------------------
// Theme — 擴展自原本 9 tokens, 所有舊 token 名稱保留 (向後相容)
// ---------------------------------------------------------------------------

export interface Theme {
  // === 背景 ===
  bg: string;
  bgCard: string;
  bgSubtle: string;
  bgOverlay: string;

  // === 文字 ===
  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;

  // === 品牌色 ===
  primary: string;
  primaryLight: string;
  primaryDark: string;
  accent: string; // = primary (向後相容 alias)

  // === 邊框 ===
  border: string;
  borderStrong: string;
  borderFocus: string;

  // === 導覽 ===
  headerBg: string;
  tabBg: string;
  tabBorder: string;

  // === 輸入 ===
  inputBg: string;
  inputBorder: string;
  inputText: string;
  placeholder: string;

  // === 語意色 ===
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  info: string;
  infoBg: string;

  // === 尺度 ===
  spacing: typeof Spacing;
  radius: typeof Radius;
  fontSize: typeof FontSize;
  fontWeight: typeof FontWeight;
  shadow: typeof Shadow;
}

// ---------------------------------------------------------------------------
// Light theme (預設)
// ---------------------------------------------------------------------------

const light: Theme = {
  bg:        Palette.gray50,
  bgCard:    Palette.white,
  bgSubtle:  Palette.gray100,
  bgOverlay: 'rgba(0,0,0,0.4)',

  text:          Palette.gray900,
  textSecondary: Palette.gray500,
  textTertiary:  Palette.gray400,
  textInverse:   Palette.white,

  primary:      Palette.blue500,
  primaryLight: Palette.blue50,
  primaryDark:  '#1D4ED8',
  accent:       Palette.blue500,

  border:       Palette.gray200,
  borderStrong: Palette.gray300,
  borderFocus:  Palette.blue500,

  headerBg:  Palette.white,
  tabBg:     Palette.white,
  tabBorder: Palette.gray200,

  inputBg:     Palette.white,
  inputBorder: Palette.gray300,
  inputText:   Palette.gray900,
  placeholder: Palette.gray400,

  success:   Palette.green500,
  successBg: Palette.green100,
  warning:   Palette.amber500,
  warningBg: Palette.amber100,
  danger:    Palette.red500,
  dangerBg:  Palette.red100,
  info:      Palette.sky500,
  infoBg:    Palette.sky100,

  spacing:    Spacing,
  radius:     Radius,
  fontSize:   FontSize,
  fontWeight: FontWeight,
  shadow:     Shadow,
};

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------

const dark: Theme = {
  bg:        Palette.dark900,
  bgCard:    Palette.dark800,
  bgSubtle:  Palette.dark700,
  bgOverlay: 'rgba(0,0,0,0.6)',

  text:          Palette.dark200,
  textSecondary: Palette.dark400,
  textTertiary:  Palette.dark600,
  textInverse:   Palette.white,

  primary:      Palette.blue400,
  primaryLight: '#1E3A5F',
  primaryDark:  Palette.blue500,
  accent:       Palette.blue400,

  border:       Palette.dark700,
  borderStrong: Palette.dark600,
  borderFocus:  Palette.blue400,

  headerBg:  Palette.dark800,
  tabBg:     Palette.dark800,
  tabBorder: Palette.dark700,

  inputBg:     Palette.dark700,
  inputBorder: Palette.dark600,
  inputText:   Palette.dark200,
  placeholder: Palette.dark400,

  success:   Palette.green500,
  successBg: '#14532D',
  warning:   Palette.amber500,
  warningBg: '#451A03',
  danger:    Palette.red500,
  dangerBg:  '#450A0A',
  info:      Palette.sky500,
  infoBg:    '#0C4A6E',

  spacing:    Spacing,
  radius:     Radius,
  fontSize:   FontSize,
  fontWeight: FontWeight,
  shadow:     Shadow,
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}
