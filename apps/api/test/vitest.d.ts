declare module 'vitest' {
  interface ProvidedContext {
    /** Set once per run by `test/global-setup.ts`; read with `inject('postgresReachable')`. */
    postgresReachable: boolean;
    /** Both Redis roles, probed once per run; read with `inject('redisReachable')`. */
    redisReachable: boolean;
  }
}

export {};
