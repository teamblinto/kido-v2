import type { CatalogueModel } from '@repo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { modelCatalogue, templateCatalogue } from '@/test/server';
import { PromptComposer } from './prompt-composer';

function renderComposer(
  onSelectTemplate = vi.fn(),
  options: {
    models?: readonly CatalogueModel[];
    modelId?: string;
    personalAccountsOff?: boolean;
    onSubmit?: (prompt: string, options?: { credential?: 'organisation' }) => void;
  } = {},
) {
  renderScreen(
    <PromptComposer
      modelId={options.modelId ?? modelCatalogue.default}
      models={options.models ?? modelCatalogue.models}
      personalAccountsOff={options.personalAccountsOff}
      suggestions={[]}
      templateId={templateCatalogue.default}
      templates={templateCatalogue.templates}
      onSelectModel={vi.fn()}
      onSelectTemplate={onSelectTemplate}
      onSubmit={options.onSubmit ?? vi.fn()}
    />,
  );

  return onSelectTemplate;
}

describe('PromptComposer', () => {
  it("SC-006: the picker shows the catalogue's names and descriptions and an unready template is disabled with the reason", async () => {
    // Nothing here names a template the catalogue did not: `GET /templates` is the only source of
    // template ids on the web (spec 015), so the fixture is the same one the MSW server serves.
    const user = userEvent.setup();
    const onSelectTemplate = renderComposer();

    await user.click(screen.getByRole('button', { name: /Vite \+ React/ }));

    const menu = await screen.findByRole('menu');

    const items = within(menu).getAllByRole('menuitem');

    expect(items).toHaveLength(templateCatalogue.templates.length);
    templateCatalogue.templates.forEach((template, index) => {
      expect(items[index]).toHaveTextContent(template.name);
      expect(items[index]).toHaveTextContent(
        template.ready ? template.description : 'Not ready to serve yet',
      );
    });

    const python = within(menu).getByRole('menuitem', { name: /Python/ });

    expect(python).toHaveAttribute('aria-disabled', 'true');
    expect(python).not.toHaveTextContent('FastAPI with uv');

    // `aria-disabled` rather than Radix's `disabled` so the row stays in the menu's roving focus:
    // the one entry whose whole purpose is to explain itself must be reachable to be heard.
    await user.keyboard('{ArrowUp}');
    expect(python).toHaveFocus();

    // Reachable, and still not pickable.
    await user.keyboard('{Enter}');
    expect(onSelectTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeVisible();
  });

  it('hands the chosen template up by id', async () => {
    const user = userEvent.setup();
    const onSelectTemplate = renderComposer();

    await user.click(screen.getByRole('button', { name: /Vite \+ React/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Next\.js/ }));

    expect(onSelectTemplate).toHaveBeenCalledExactlyOnceWith('nextjs');
  });

  describe('the credential a run would use (spec 032)', () => {
    const sonnet = modelCatalogue.models.find((model) => model.id === 'claude-sonnet-5')!;
    const gpt: CatalogueModel = {
      available: true,
      credentialMode: 'BYOS',
      description: 'Fastest · good for small edits',
      id: 'gpt-5-mini',
      name: 'GPT-5 mini',
      provider: 'openai',
      shortName: 'GPT-5 mini',
    };

    it('names the subscription, the organisation key or platform credits under the composer', () => {
      renderComposer(vi.fn(), { modelId: gpt.id, models: [sonnet, gpt] });
      expect(screen.getByTestId('credential-preflight')).toHaveTextContent(
        'Runs on your OpenAI subscription',
      );
    });

    it.each([
      ['BYOK', "Runs on the organisation's key"],
      ['PLATFORM', 'Runs on platform credits'],
    ] as const)('%s reads "%s"', (credentialMode, sentence) => {
      renderComposer(vi.fn(), { models: [{ ...sonnet, credentialMode }] });
      expect(screen.getByTestId('credential-preflight')).toHaveTextContent(sentence);
    });

    it('badges a subscription entry "your subscription" and explains a disabled one', async () => {
      const user = userEvent.setup();
      renderComposer(vi.fn(), {
        models: [
          { ...sonnet, credentialMode: 'BYOS' },
          {
            ...gpt,
            available: false,
            unavailableReason: 'subscription-needs-reauth',
          },
          {
            ...gpt,
            available: false,
            credentialMode: 'BYOK',
            id: 'gpt-5.2',
            name: 'GPT-5.2',
            unavailableReason: 'key-needs-reauth',
          },
        ],
      });

      await user.click(screen.getByLabelText(/describe the internal tool/i));
      await user.click(await screen.findByRole('button', { name: /Claude · Sonnet 5/ }));
      const menu = await screen.findByRole('menu');

      expect(within(menu).getByRole('menuitem', { name: /Sonnet 5/ })).toHaveTextContent(
        'your subscription',
      );
      expect(within(menu).getByRole('menuitem', { name: /GPT-5 mini/ })).toHaveTextContent(
        'reconnect your account',
      );
      expect(within(menu).getByRole('menuitem', { name: /GPT-5\.2/ })).toHaveTextContent(
        'needs a new key',
      );
    });

    it('says personal subscriptions are off when the organisation forbids them', () => {
      renderComposer(vi.fn(), {
        models: [{ ...sonnet, credentialMode: 'BYOK' }],
        personalAccountsOff: true,
      });

      expect(screen.getByTestId('credential-preflight')).toHaveTextContent(
        "Runs on the organisation's key",
      );
      expect(
        screen.getByText('Personal subscriptions are turned off in this organisation.'),
      ).toBeVisible();
    });
  });

  describe('a limited subscription (spec 032 T048)', () => {
    const sonnet = modelCatalogue.models.find((model) => model.id === 'claude-sonnet-5')!;
    const limitedUntil = '2026-09-24T09:22:00.000Z';

    it('names the limit and offers the organisation credential for this run only', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderComposer(vi.fn(), {
        models: [{ ...sonnet, alternativeMode: 'BYOK', credentialMode: 'BYOS', limitedUntil }],
        onSubmit,
      });

      expect(screen.getByRole('status')).toHaveTextContent(
        /Your Claude subscription is limited until/,
      );
      await user.type(screen.getByLabelText(/describe the internal tool/i), 'A tracker');
      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole('button', { name: "Run on the organisation's credential this time" }),
      );
      expect(onSubmit).toHaveBeenCalledWith('A tracker', { credential: 'organisation' });
    });

    it('with no organisation credential the submit is disabled with the sentence and no button', async () => {
      const user = userEvent.setup();
      renderComposer(vi.fn(), {
        models: [{ ...sonnet, credentialMode: 'BYOS', limitedUntil }],
      });

      await user.type(screen.getByLabelText(/describe the internal tool/i), 'A tracker');
      expect(screen.getByRole('status')).toHaveTextContent(/limited until/);
      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
      expect(
        screen.queryByRole('button', { name: "Run on the organisation's credential this time" }),
      ).toBeNull();
    });
  });
});
