export interface ColorTokens {
  'color-bg-base': string
  'color-surface': string
  'color-text-primary': string
  'color-text-muted': string
  'color-border': string
  'color-accent': string
  'color-accent-light': string
  'color-success': string
  'color-warning': string
  'color-danger': string
}

export const lightColors: ColorTokens = {
  'color-bg-base': 'oklch(97% 0.018 70)',
  'color-surface': 'oklch(99% 0.008 70)',
  'color-text-primary': 'oklch(22% 0.02 50)',
  'color-text-muted': 'oklch(50% 0.018 50)',
  'color-border': 'oklch(90% 0.014 70)',
  'color-accent': 'oklch(64% 0.13 28)',
  'color-accent-light': 'oklch(92% 0.04 28)',
  'color-success': 'oklch(70% 0.18 145)',
  'color-warning': 'oklch(78% 0.15 85)',
  'color-danger': 'oklch(62% 0.2 25)',
}

export const darkColors: ColorTokens = {
  'color-bg-base': 'oklch(20% 0.015 50)',
  'color-surface': 'oklch(25% 0.015 50)',
  'color-text-primary': 'oklch(92% 0.008 70)',
  'color-text-muted': 'oklch(65% 0.015 50)',
  'color-border': 'oklch(35% 0.015 50)',
  'color-accent': 'oklch(68% 0.13 28)',
  'color-accent-light': 'oklch(30% 0.06 28)',
  'color-success': 'oklch(70% 0.18 145)',
  'color-warning': 'oklch(78% 0.15 85)',
  'color-danger': 'oklch(62% 0.2 25)',
}
