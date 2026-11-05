import { createTheme, type Theme } from '@mui/material/styles';
import { tokens, type ThemeMode } from './tokens';

const FONT = '"Roboto Flex", Roboto, system-ui, -apple-system, "Segoe UI", Arial, sans-serif';

/** MUI theme built from DCAM tokens; dark (blue-grey) is the default (FR-UI-06). */
export function createDcamTheme(mode: ThemeMode = 'dark'): Theme {
  const t = tokens[mode];
  return createTheme({
    palette: {
      mode,
      background: { default: t.bgCanvas, paper: t.bgSurface },
      primary: { main: t.accentPrimary },
      success: { main: t.statusOk },
      warning: { main: t.statusWarning },
      error: { main: t.statusError },
      info: { main: t.statusInfo },
      text: { primary: t.textPrimary, secondary: t.textSecondary },
      divider: t.borderSubtle,
    },
    shape: { borderRadius: tokens.radiusCard },
    spacing: tokens.spaceUnit,
    typography: {
      fontFamily: FONT,
      h1: { fontSize: '1.5rem', fontWeight: 400 },
      h2: { fontSize: '1.125rem', fontWeight: 500 },
      button: { textTransform: 'none' },
    },
    components: {
      MuiPaper: {
        styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${t.borderSubtle}` } },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: t.bgSurface,
            color: t.textPrimary,
            border: 0,
            borderBottom: `1px solid ${t.borderSubtle}`,
          },
        },
      },
      MuiPopover: { styleOverrides: { paper: { backgroundColor: t.bgRaised } } },
      MuiTableCell: {
        styleOverrides: { root: { borderColor: t.borderSubtle, fontVariantNumeric: 'tabular-nums' } },
      },
    },
  });
}
