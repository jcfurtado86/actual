import { keyframes } from '@emotion/css';

import { theme } from './theme';
import { tokens } from './tokens';

// oxlint-disable-next-line typescript/no-explicit-any
export type CSSProperties = Record<string, any>;

const MOBILE_MIN_HEIGHT = 40;

const shadowLarge = {
  boxShadow:
    '0 18px 38px 0 rgba(15, 23, 42, 0.10), 0 6px 14px 0 rgba(15, 23, 42, 0.06)',
};

export const styles: CSSProperties = {
  incomeHeaderHeight: 70,
  cardShadow:
    '0 8px 24px -8px rgba(15, 23, 42, 0.15), 0 2px 6px rgba(15, 23, 42, 0.06)',
  monthRightPadding: 5,
  menuBorderRadius: 12,
  mobileMinHeight: MOBILE_MIN_HEIGHT,
  mobileMenuItem: {
    fontSize: 17,
    fontWeight: 400,
    paddingTop: 8,
    paddingBottom: 8,
    height: MOBILE_MIN_HEIGHT,
    minHeight: MOBILE_MIN_HEIGHT,
  },
  mobileEditingPadding: 12,
  altMenuMaxHeight: 250,
  altMenuText: {
    fontSize: 13,
  },
  altMenuHeaderText: {
    fontSize: 13,
    fontWeight: 700,
  },
  veryLargeText: {
    fontSize: 34,
    fontWeight: 600,
    letterSpacing: -0.4,
  },
  largeText: {
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  mediumText: {
    fontSize: 16,
    fontWeight: 500,
  },
  smallText: {
    fontSize: 14,
  },
  verySmallText: {
    fontSize: 13,
  },
  tinyText: {
    fontSize: 10,
  },
  page: {
    flex: 1,
    '@media (max-height: 550px)': {
      minHeight: 700, // ensure we can scroll on small screens
    },
    paddingTop: 8, // height of the titlebar
    [`@media (min-width: ${tokens.breakpoint_small})`]: {
      paddingTop: 36,
    },
  },
  pageContent: {
    paddingLeft: 12,
    paddingRight: 12,
    [`@media (min-width: ${tokens.breakpoint_small})`]: {
      paddingLeft: 32,
      paddingRight: 32,
    },
  },
  settingsPageContent: {
    padding: 20,
    [`@media (min-width: ${tokens.breakpoint_small})`]: {
      padding: 'inherit',
    },
  },
  staticText: {
    cursor: 'default',
    userSelect: 'none',
  },
  shadow: {
    boxShadow: '0 2px 4px 0 rgba(0,0,0,0.1)',
  },
  shadowLarge,
  tnum: {
    // tnum: Tabular numbers
    // ss01: Open digits
    // ss04: Disambiguation w/o zero
    fontFeatureSettings: '"tnum", "ss01", "ss04"',
  },
  notFixed: { fontFeatureSettings: '' },
  text: {
    fontSize: 16,
    // lineHeight: 22.4 // TODO: This seems like trouble, but what's the right value?
  },
  delayedFadeIn: {
    animationName: keyframes({
      '0%': { opacity: 0 },
      '100%': { opacity: 1 },
    }),
    animationDuration: '1s',
    animationFillMode: 'both',
    animationDelay: '0.5s',
  },
  underlinedText: {
    borderBottom: `2px solid`,
  },
  noTapHighlight: {
    WebkitTapHighlightColor: 'transparent',
    ':focus': {
      outline: 'none',
    },
  },
  lineClamp: (lines: number) => {
    return {
      display: '-webkit-box',
      WebkitLineClamp: lines,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      wordBreak: 'break-word',
    };
  },
  tooltip: {
    padding: 8,
    ...shadowLarge,
    borderWidth: 1,
    borderRadius: 10,
    borderStyle: 'solid',
    borderColor: theme.tooltipBorder,
    backgroundColor: theme.tooltipBackground,
    color: theme.tooltipText,
    overflow: 'auto',
  },
  popover: {
    border: 'none',
    backgroundColor: theme.menuBackground,
    color: theme.menuItemText,
  },
  // Dynamically set
  horizontalScrollbar: null as CSSProperties | null,
  lightScrollbar: null as CSSProperties | null,
  darkScrollbar: null as CSSProperties | null,
  scrollbarWidth: null as number | null,
  editorPill: {
    color: theme.pillText,
    backgroundColor: theme.pillBackground,
    borderRadius: 999,
    padding: '4px 12px',
  },
  mobileListItem: {
    borderBottom: `1px solid ${theme.tableBorder}`,
    backgroundColor: theme.tableBackground,
    padding: 20,
    cursor: 'pointer',
  },
  tableContainer: {
    flex: 1,
    border: '1px solid ' + theme.tableBorder,
    borderRadius: 14,
    overflow: 'hidden',
  },
};
