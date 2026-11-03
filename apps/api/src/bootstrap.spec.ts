import { Logger, type LoggerService, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { adoptLogger } from './bootstrap';

@Module({})
class EmptyModule {}

describe('adoptLogger', () => {
  it('routes a Logger call made after boot to the adopted logger (main.ts factory options)', async () => {
    const lines: string[] = [];
    const sink: LoggerService = {
      error: (message: string) => lines.push(message),
      log: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
    };
    // What `main.ts` passes: boot logs buffered, and not flushed by `useLogger` on its own.
    const app = await NestFactory.createApplicationContext(EmptyModule, {
      abortOnError: false,
      autoFlushLogs: false,
      bufferLogs: true,
    });

    try {
      adoptLogger(app, sink);
      new Logger('AgentExecutor').warn('checkpoint failed: run=r1 kind=git');

      expect(lines).toContain('checkpoint failed: run=r1 kind=git');
    } finally {
      await app.close();
      Logger.flush();
    }
  });
});
