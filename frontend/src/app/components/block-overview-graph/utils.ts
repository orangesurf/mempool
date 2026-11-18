import { feeLevels, defaultMempoolFeeColors, contrastMempoolFeeColors } from '@app/app.constants';
import { Color } from '@components/block-overview-graph/sprite-types';
import TxView from '@components/block-overview-graph/tx-view';

export function hexToColor(hex: string): Color {
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a: hex.length > 6 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  };
}

export function colorToHex(color: Color): string {
  return [color.r, color.g, color.b].map(c => Math.max(0, Math.min(Math.round(c * 255), 255)).toString(16)).join('');
}

export function desaturate(color: Color, amount: number): Color {
  const gray = (color.r + color.g + color.b) / 6;
  return {
    r: color.r + ((gray - color.r) * amount),
    g: color.g + ((gray - color.g) * amount),
    b: color.b + ((gray - color.b) * amount),
    a: color.a,
  };
}

export function darken(color: Color, amount: number): Color {
  return {
    r: color.r * amount,
    g: color.g * amount,
    b: color.b * amount,
    a: color.a,
  };
}

export function mix(color1: Color, color2: Color, amount: number): Color {
  // clamp to 0-1
  amount = Math.max(0, Math.min(amount, 1));
  return {
    r: color1.r * (1 - amount) + color2.r * amount,
    g: color1.g * (1 - amount) + color2.g * amount,
    b: color1.b * (1 - amount) + color2.b * amount,
    a: color1.a * (1 - amount) + color2.a * amount,
  };
}

export function setOpacity(color: Color, opacity: number): Color {
  return {
    ...color,
    a: opacity
  };
}

interface ColorPalette {
  base: Color[],
  audit: Color[],
  marginal: Color[],
  baseLevel: (tx: TxView, rate: number, time: number) => number,
}

/** Precomputes a fee palette, with audit, marginal and unmatched variants, from hex colours. */
export function buildFeeColors(hexColors: string[]): { [key: string]: ColorPalette } {
  const colors: { [key: string]: ColorPalette } = {
    fee: {
      base: hexColors.map(hexToColor),
      audit: [],
      marginal: [],
      baseLevel: (tx: TxView, rate: number) => feeLevels.findIndex((feeLvl) => Math.max(0, rate) < feeLvl) - 1
    },
  };
  for (const key in colors) {
    const base = colors[key].base;
    colors[key].audit = base.map((color) => darken(desaturate(color, 0.3), 0.9));
    colors[key].marginal = base.map((color) => darken(desaturate(color, 0.8), 1.1));
    colors['unmatched' + key] = {
      base: colors[key].base.map(c => setOpacity(c, 0.2)),
      audit: colors[key].audit.map(c => setOpacity(c, 0.2)),
      marginal: colors[key].marginal.map(c => setOpacity(c, 0.2)),
      baseLevel: colors[key].baseLevel,
    };
  }
  return colors;
}

// precomputed colors
const defaultColors = buildFeeColors(defaultMempoolFeeColors);

export { defaultColors as defaultColors };

export const defaultAuditColors = {
  censored: hexToColor('f344df'),
  missing: darken(desaturate(hexToColor('f344df'), 0.3), 0.7),
  added: hexToColor('0099ff'),
  added_prioritized: darken(desaturate(hexToColor('0099ff'), 0.15), 0.85),
  prioritized: darken(desaturate(hexToColor('0099ff'), 0.3), 0.7),
  accelerated: hexToColor('8f5ff6'),
};

const contrastColors = buildFeeColors(contrastMempoolFeeColors);

export { contrastColors as contrastColors };

export const contrastAuditColors = {
  censored: hexToColor('ffa8ff'),
  missing: darken(desaturate(hexToColor('ffa8ff'), 0.3), 0.7),
  added: hexToColor('00bb98'),
  added_prioritized: darken(desaturate(hexToColor('00bb98'), 0.15), 0.85),
  prioritized: darken(desaturate(hexToColor('00bb98'), 0.3), 0.7),
  accelerated: hexToColor('8f5ff6'),
};

/** The colours the block overview uses for one theme. */
export interface ThemeBlockColors {
  colors: { [key: string]: ColorPalette };
  auditColors: { [status: string]: Color };
  unmatchedAuditColors: { [status: string]: Color };
}

const unmatchedOpacity = 0.2;

export function themeBlockColorSet(colors: { [key: string]: ColorPalette }, auditColors: { [status: string]: Color }): ThemeBlockColors {
  const unmatchedAuditColors: { [status: string]: Color } = {};
  for (const status in auditColors) {
    unmatchedAuditColors[status] = setOpacity(auditColors[status], unmatchedOpacity);
  }
  return { colors, auditColors, unmatchedAuditColors };
}

const defaultBlockColors = themeBlockColorSet(defaultColors, defaultAuditColors);
const contrastBlockColors = themeBlockColorSet(contrastColors, contrastAuditColors);

/** Themes with their own block overview colours. Any other theme uses the default colours. */
const themeBlockColorSets: { [theme: string]: ThemeBlockColors } = {
  contrast: contrastBlockColors,
  bukele: contrastBlockColors,
};

export function themeBlockColors(theme: string): ThemeBlockColors {
  return themeBlockColorSets[theme] ?? defaultBlockColors;
}

export function defaultColorFunction(
  tx: TxView,
  colors: { base: Color[], audit: Color[], marginal: Color[], baseLevel: (tx: TxView, rate: number, time: number) => number } = defaultColors.fee,
  auditColors: { [status: string]: Color } = defaultAuditColors,
  relativeTime?: number,
): Color {
  const rate = tx.fee / tx.vsize; // color by simple single-tx fee rate
  const levelIndex = colors.baseLevel(tx, rate, relativeTime || (Date.now() / 1000));
  const levelColor = colors.base[levelIndex] || colors.base[defaultMempoolFeeColors.length - 1];
  // Normal mode
  if (!tx.scene?.highlightingEnabled) {
    if (tx.acc) {
      return auditColors.accelerated;
    } else {
      return levelColor;
    }
    return levelColor;
  }
  // Block audit
  switch(tx.status) {
    case 'censored':
      return auditColors.censored;
    case 'missing':
    case 'sigop':
    case 'rbf':
      return colors.marginal[levelIndex] || colors.marginal[defaultMempoolFeeColors.length - 1];
    case 'fresh':
    case 'freshcpfp':
      return auditColors.missing;
    case 'added':
      return auditColors.added;
    case 'added_prioritized':
      return auditColors.added_prioritized;
    case 'prioritized':
      return auditColors.prioritized;
    case 'added_deprioritized':
      return auditColors.added_prioritized;
    case 'deprioritized':
      return auditColors.prioritized;
    case 'selected':
      return colors.marginal[levelIndex] || colors.marginal[defaultMempoolFeeColors.length - 1];
    case 'accelerated':
      return auditColors.accelerated;
    case 'found':
      if (tx.context === 'projected') {
        return colors.audit[levelIndex] || colors.audit[defaultMempoolFeeColors.length - 1];
      } else {
        return levelColor;
      }
    case 'unmatched':
      if (tx.context === 'stale') {
        return auditColors.censored;
      } else {
        return auditColors.added;
      }
    default:
      if (tx.acc) {
        return auditColors.accelerated;
      } else {
        return levelColor;
      }
  }
}

export function contrastColorFunction(
  tx: TxView,
  colors: { base: Color[], audit: Color[], marginal: Color[], baseLevel: (tx: TxView, rate: number, time: number) => number } = contrastColors.fee,
  auditColors: { [status: string]: Color } = contrastAuditColors,
  relativeTime?: number,
): Color {
  return defaultColorFunction(tx, colors, auditColors, relativeTime);
}

/** The default transaction colour function for a theme. */
export function themeColorFunction(theme: string): (tx: TxView) => Color {
  const { colors, auditColors } = themeBlockColors(theme);
  return (tx: TxView) => defaultColorFunction(tx, colors.fee, auditColors);
}

export function ageColorFunction(
  tx: TxView,
  colors: { base: Color[], audit: Color[], marginal: Color[], baseLevel: (tx: TxView, rate: number, time: number) => number } = defaultColors.fee,
  auditColors: { [status: string]: Color } = defaultAuditColors,
  relativeTime?: number,
  theme?: string,
): Color {
  if (tx.acc || tx.status === 'accelerated') {
    return auditColors.accelerated;
  }

  const color = theme !== 'contrast' && theme !== 'bukele' ? defaultColorFunction(tx, colors, auditColors, relativeTime) : contrastColorFunction(tx, colors, auditColors, relativeTime);

  const ageLevel = (!tx.time ? 0 : (0.8 * Math.tanh((1 / 15) * Math.log2((Math.max(1, 0.6 * ((relativeTime - tx.time) - 60)))))));
  return {
    r: color.r,
    g: color.g,
    b: color.b,
    a: color.a * (1 - ageLevel)
  };
}
