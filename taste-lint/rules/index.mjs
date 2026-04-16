import noHardcodedColors from './no-hardcoded-colors.mjs';
import noMagicSpacing from './no-magic-spacing.mjs';
import noNativeFormElements from './no-native-form-elements.mjs';

export const tastePlugin = {
  meta: { name: 'eslint-plugin-taste' },
  rules: {
    'no-hardcoded-colors': noHardcodedColors,
    'no-magic-spacing': noMagicSpacing,
    'no-native-form-elements': noNativeFormElements,
  },
};

export const tasteRules = {
  'taste/no-hardcoded-colors': 'error',
  'taste/no-magic-spacing': 'warn',
  'taste/no-native-form-elements': 'error',
};
