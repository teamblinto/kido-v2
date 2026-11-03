import { describe, expect, it } from 'vitest';

import { projectInvitationMail } from './project-invitation';

const ORG_ID = '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  expiresInMinutes: 10_080,
  invitedBy: 'dana@example.com',
  orgId: ORG_ID,
  projectName: 'Launch site',
  role: 'editor',
  to: 'someone@example.com',
  token: TOKEN,
} as const;

/** Spec 031 (contracts/sharing.md § 7): the project invitation mail. */
describe('projectInvitationMail', () => {
  it('is the project-invitation template, with the contract subject', () => {
    const message = projectInvitationMail(INPUT);

    expect(message.template).toBe('project-invitation');
    expect(message.subject).toBe("You've been invited to a project");
    expect(message.to).toBe('someone@example.com');
  });

  it('names the inviter, the project and the role, and links to /project-invitations/accept/<token>?org=<orgId>', () => {
    const { html, text } = projectInvitationMail(INPUT);
    const link = `https://app.forge.dev/project-invitations/accept/${TOKEN}?org=${ORG_ID}`;

    for (const part of [text, html]) {
      expect(part).toContain('dana@example.com');
      expect(part).toContain('Launch site');
      expect(part).toContain('editor');
      expect(part).toContain(link);
    }
  });

  it('keeps the token out of the subject and escapes a hostile project name', () => {
    const message = projectInvitationMail({
      ...INPUT,
      projectName: '<img src=x onerror=alert(1)>',
    });

    expect(message.subject).not.toContain(TOKEN);
    expect(message.html).not.toContain('<img src=x');
  });
});
