import type {LinguiConfig} from '@lingui/conf';

const config: LinguiConfig = {
  sourceLocale: 'en',
  locales: ['en', 'ru'],
  fallbackLocales: {
    default: 'en',
  },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src', 'App.tsx'],
    },
  ],
};

export default config;
