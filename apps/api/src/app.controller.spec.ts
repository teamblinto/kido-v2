import { Test } from '@nestjs/testing';

import { AppController } from './app.controller';

describe('AppController', () => {
  it('returns API metadata', async () => {
    const module = await Test.createTestingModule({ controllers: [AppController] }).compile();
    const controller = module.get(AppController);

    expect(controller.getRoot()).toMatchObject({ name: 'api', status: 'running' });
  });
});
