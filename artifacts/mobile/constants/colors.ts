/**
 * ComplyTrack brand tokens — synced from compliance-tracker/src/index.css
 *
 * Web palette:
 *   Deep Navy   #162d42  (sidebar / brand dark)
 *   Steel Blue  #7ea7c9  (primary interactive)
 *   Cream       #f7f2e4  (warm secondary background)
 */
const colors = {
  light: {
    text: '#1a1a1a',
    tint: '#7ea7c9',

    background: '#ffffff',
    foreground: '#1a1a1a',

    card: '#f9fafb',
    cardForeground: '#1a1a1a',

    primary: '#7ea7c9',
    primaryForeground: '#ffffff',

    /** Deep Navy – brand header / strong action colour */
    navy: '#162d42',
    /** Warm cream – matches web `--secondary` */
    cream: '#f7f2e4',

    secondary: '#f7f2e4',
    secondaryForeground: '#162d42',

    muted: '#f1f5f9',
    mutedForeground: '#64748b',

    accent: '#162d42',
    accentForeground: '#f7f2e4',

    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    success: '#22c55e',
    successForeground: '#ffffff',

    warning: '#f59e0b',
    warningForeground: '#ffffff',

    border: '#e2e8f0',
    input: '#e2e8f0',
  },

  dark: {
    text: '#f1f5f9',
    tint: '#7ea7c9',

    background: '#0d1825',
    foreground: '#f1f5f9',

    card: '#162d42',
    cardForeground: '#f1f5f9',

    primary: '#7ea7c9',
    primaryForeground: '#162d42',

    navy: '#0d1825',
    cream: '#1e3048',

    secondary: '#1a2e3d',
    secondaryForeground: '#f1f5f9',

    muted: '#1a2e3d',
    mutedForeground: '#94a3b8',

    accent: '#7ea7c9',
    accentForeground: '#0d1825',

    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    success: '#22c55e',
    successForeground: '#ffffff',

    warning: '#f59e0b',
    warningForeground: '#ffffff',

    border: '#1e3048',
    input: '#1e3048',
  },

  radius: 4,
};

export default colors;
