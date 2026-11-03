import globals from 'globals';

import baseConfig from '@repo/eslint-config/base';

export default [
  ...baseConfig,
  // Plain-JS stand-ins for the real CLIs, run by node as separate processes.
  { ignores: ['test/fixtures/**'] },
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
