import globals from 'globals';

import baseConfig from '@repo/eslint-config/base';

export default [
  ...baseConfig,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
  },
];
