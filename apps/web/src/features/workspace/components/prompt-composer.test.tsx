import type { CatalogueModel } from '@repo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, modelCatalogue, server, templateCatalogue } from '@/test/server';
import { useModelChoice } from '../hooks/use-model-choice';
import { PromptComposer } from './prompt-composer';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

interface Options {
  models?: readonly CatalogueModel[];
  personalAccountsOff?: boolean;
  onSubmit?: (prompt: string, options?: { credential?: 'organisation' }) => void;
}

/** The composer over the real picker state, fed by the MSW catalogue and subscription reads. */
function Harness({
  onSelectTemplate,
  options,
}: {
  onSelectTemplate: () => void;
  options: Options;
}): React.JSX.Element {
  const modelState = useModelChoice({ orgId: ORG });

  return (
    <PromptComposer
      modelState={modelState}
      needsConnection={modelState.needsConnection}
      personalAccountsOff={options.personalAccountsOff}
      suggestions={[]}
      templateId={templateCatalogue.default}
      templates={templateCatalogue.templates}
      onSelectTemplate={onSelectTemplate}
      onSubmit={options.onSubmit ?? vi.fn()}
    />
  );
}

function renderComposer(onSelectTemplate = vi.fn(), options: Options = {}) {
  const { models } = options;

  if (models !== undefined) {
    server.use(
      http.get(`${API}/orgs/:orgId/models`, () =>
        HttpResponse.json({ default: models[0]?.id ?? null, models }),
      ),
    );
  }

  renderScreen(<Harness onSelectTemplate={onSelectTemplate} options={options} />);

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

    it('names a linked subscription or the organisation key under the composer', async () => {
      renderComposer(vi.fn(), { models: [gpt, sonnet] });
      expect(await screen.findByTestId('credential-preflight')).toHaveTextContent(
        'Runs on your OpenAI subscription',
      );
    });

    it('reads "Runs on the organisation\'s key" for a key', async () => {
      renderComposer(vi.fn(), { models: [sonnet] });
      expect(await screen.findByTestId('credential-preflight')).toHaveTextContent(
        "Runs on the organisation's key",
      );
    });

    it('badges a linked account and explains an entry that cannot be picked', async () => {
      const user = userEvent.setup();
      renderComposer(vi.fn(), {
        models: [
          { ...sonnet, credentialMode: 'BYOS' },
          { ...gpt, available: false, unavailableReason: 'subscription-needs-reauth' },
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

      await user.click(await screen.findByRole('button', { name: /Sonnet 5.*change model/ }));
      const keys = within(await screen.findByRole('listbox')).getByRole('group', {
        name: 'API keys',
      });

      expect(within(keys).getByRole('option', { name: 'Claude Sonnet 5' })).toHaveTextContent(
        'linked account',
      );
      const mini = within(keys).getByRole('option', { name: 'GPT-5 mini' });
      expect(mini).toHaveAttribute('aria-disabled', 'true');
      expect(mini).toHaveAccessibleDescription('Reconnect your account in Settings');
      expect(within(keys).getByRole('option', { name: 'GPT-5.2' })).toHaveAccessibleDescription(
        "The organisation's key needs replacing in Settings",
      );
    });

    it('says personal subscriptions are off when the organisation forbids them', async () => {
      renderComposer(vi.fn(), { models: [sonnet], personalAccountsOff: true });

      expect(await screen.findByTestId('credential-preflight')).toHaveTextContent(
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

      expect(await screen.findByRole('status')).toHaveTextContent(
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
      expect(await screen.findByRole('status')).toHaveTextContent(/limited until/);
      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
      expect(
        screen.queryByRole('button', { name: "Run on the organisation's credential this time" }),
      ).toBeNull();
    });
  });

  describe('nothing can pay (spec 043)', () => {
    it('offers to connect a subscription instead of sending', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderComposer(vi.fn(), { models: [], onSubmit });

      const connect = await screen.findByRole('link', { name: 'Connect your Claude subscription' });
      expect(connect).toHaveAttribute('href', '/settings/account#claude-subscription');

      await user.type(screen.getByLabelText(/describe the internal tool/i), 'A tracker{Enter}');

      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
