import { lightColors, darkColors, type ColorTokens } from './colors'
import { spacing } from './spacing'
import { fonts, radii } from './typography'

export { lightColors, darkColors, type ColorTokens } from './colors'
export { spacing } from './spacing'
export { fonts, radii } from './typography'

export function injectTokens(
  theme: 'light' | 'dark' = 'light',
  target: HTMLElement = document.documentElement,
): void {
  const colors: ColorTokens = theme === 'dark' ? darkColors : lightColors

  for (const [key, value] of Object.entries(colors)) {
    target.style.setProperty(`--${key}`, value)
  }

  for (const [key, value] of Object.entries(spacing)) {
    target.style.setProperty(`--${key}`, value)
  }

  for (const [key, value] of Object.entries(fonts)) {
    target.style.setProperty(`--${key}`, value)
  }

  for (const [key, value] of Object.entries(radii)) {
    target.style.setProperty(`--${key}`, value)
  }
}
