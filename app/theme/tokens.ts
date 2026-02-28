// ---------------------------------------------------------------------------
// Karvi Design Tokens — 所有原始色票、間距、圓角、字型、陰影常數
// 純資料，無 React 依賴
// ---------------------------------------------------------------------------

export const Palette = {
  // Brand
  blue500: '#2563EB',
  blue400: '#3B82F6',
  blue100: '#DBEAFE',
  blue50:  '#EFF6FF',

  // Neutrals (light mode)
  white:   '#FFFFFF',
  gray50:  '#F9FAFB',
  gray100: '#F3F4F6',
  gray200: '#E5E7EB',
  gray300: '#D1D5DB',
  gray400: '#9CA3AF',
  gray500: '#6B7280',
  gray700: '#374151',
  gray800: '#1F2937',
  gray900: '#111827',

  // Semantic
  green500:  '#22C55E',
  green100:  '#DCFCE7',
  amber500:  '#F59E0B',
  amber100:  '#FEF3C7',
  red500:    '#EF4444',
  red100:    '#FEE2E2',
  purple500: '#A855F7',
  purple100: '#F3E8FF',
  sky500:    '#0EA5E9',
  sky100:    '#E0F2FE',

  // Dark mode surfaces
  dark900: '#0F172A',
  dark800: '#1E293B',
  dark700: '#334155',
  dark600: '#475569',
  dark400: '#94A3B8',
  dark200: '#CBD5E1',
} as const;

// ---------------------------------------------------------------------------
// Spacing (4-pt grid)
// ---------------------------------------------------------------------------

export const Spacing = {
  0:  0,
  1:  4,
  2:  8,
  3:  12,
  4:  16,
  5:  20,
  6:  24,
  8:  32,
  10: 40,
  12: 48,
  16: 64,
} as const;

// ---------------------------------------------------------------------------
// Radius
// ---------------------------------------------------------------------------

export const Radius = {
  sm:   4,
  md:   8,
  lg:   12,
  xl:   16,
  full: 9999,
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const FontSize = {
  xs:   11,
  sm:   13,
  base: 15,
  lg:   17,
  xl:   20,
  '2xl': 24,
  '3xl': 30,
} as const;

export const FontWeight = {
  regular:  '400' as const,
  medium:   '500' as const,
  semibold: '600' as const,
  bold:     '700' as const,
  extrabold:'800' as const,
};

// ---------------------------------------------------------------------------
// Shadow (iOS shadow + Android elevation)
// ---------------------------------------------------------------------------

export const Shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
} as const;

// ---------------------------------------------------------------------------
// Status 色組 — Badge + ConnectionIndicator 共用
// ---------------------------------------------------------------------------

export interface StatusColorSet {
  bg: string;
  text: string;
  dot: string;
}

export const StatusColors: Record<string, StatusColorSet> = {
  pending:        { bg: Palette.gray100,   text: Palette.gray500,   dot: Palette.gray400  },
  dispatched:     { bg: Palette.sky100,    text: Palette.sky500,    dot: Palette.sky500   },
  in_progress:    { bg: Palette.amber100,  text: Palette.amber500,  dot: Palette.amber500 },
  completed:      { bg: Palette.blue100,   text: Palette.blue500,   dot: Palette.blue500  },
  reviewing:      { bg: Palette.purple100, text: Palette.purple500, dot: Palette.purple500 },
  approved:       { bg: Palette.green100,  text: Palette.green500,  dot: Palette.green500 },
  needs_revision: { bg: Palette.red100,    text: Palette.red500,    dot: Palette.red500   },
  blocked:        { bg: Palette.red100,    text: Palette.red500,    dot: Palette.red500   },
  // Connection states
  connected:      { bg: Palette.green100,  text: Palette.green500,  dot: Palette.green500 },
  polling:        { bg: Palette.amber100,  text: Palette.amber500,  dot: Palette.amber500 },
  reconnecting:   { bg: Palette.amber100,  text: Palette.amber500,  dot: Palette.amber500 },
  disconnected:   { bg: Palette.red100,    text: Palette.red500,    dot: Palette.red500   },
};

export const StatusLabels: Record<string, string> = {
  pending:        'Pending',
  dispatched:     'Dispatched',
  in_progress:    'Running',
  completed:      'Completed',
  reviewing:      'Reviewing',
  approved:       'Approved',
  needs_revision: 'Needs Revision',
  blocked:        'Blocked',
};
