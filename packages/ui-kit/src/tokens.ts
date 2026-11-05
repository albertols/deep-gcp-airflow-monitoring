/** Design tokens (spec §12.5). Contrast is verified by tests as the palette grows (NFR-A11Y-01). */
export const tokens = {
  dark: {
    bgCanvas: '#0B1320',
    bgSurface: '#111B2B',
    bgRaised: '#16233A',
    borderSubtle: '#22324D',
    textPrimary: '#E3E8F0',
    textSecondary: '#9AA9BF',
    accentPrimary: '#8AB4F8',
    statusOk: '#81C995',
    statusWarning: '#FDD663',
    statusError: '#F28B82',
    statusInfo: '#78D9EC',
  },
  light: {
    bgCanvas: '#F8F9FA',
    bgSurface: '#FFFFFF',
    bgRaised: '#FFFFFF',
    borderSubtle: '#DADCE0',
    textPrimary: '#202124',
    textSecondary: '#5F6368',
    accentPrimary: '#1A73E8',
    statusOk: '#188038',
    statusWarning: '#E37400',
    statusError: '#D93025',
    statusInfo: '#12B5CB',
  },
  radiusCard: 8,
  spaceUnit: 4,
} as const;

export type ThemeMode = 'dark' | 'light';
