/**
 * The rendered mails, and the pieces they are built from.
 *
 * One explicit line per export rather than a wildcard barrel, for the reason the plan gives about
 * `packages/contracts/src/index.ts`: a wildcard makes every new template a silent addition to the
 * module's public surface, and makes a rename look like nothing in a diff.
 */
export { type MailBody, escapeHtml, formatDuration, renderHtml, renderText } from './layout';
export {
  MAIL_LINK_TOKEN_PARAM,
  MAIL_LINK_PANEL_PARAM,
  accountSettingsUrl,
  invitationUrl,
  passwordResetUrl,
  projectDomainsUrl,
  projectInvitationUrl,
  signInUrl,
  verificationUrl,
  webhooksSettingsUrl,
} from './links';
export { type AccountExistsMailInput, accountExistsMail } from './account-exists';
export { type ByosAccountMailInput, byosAccountMail } from './byos-account';
export { type DomainDriftedMailInput, domainDriftedMail } from './domain-drifted';
export { type DomainFailedMailInput, domainFailedMail } from './domain-failed';
export { type DomainNoticeMailInput } from './domain-notice';
export {
  type DomainReleaseWarningMailInput,
  domainReleaseWarningMail,
} from './domain-release-warning';
export { type DomainReleasedMailInput, domainReleasedMail } from './domain-released';
export { type InvitationMailInput, invitationMail } from './invitation';
export { type PasswordResetMailInput, passwordResetMail } from './password-reset';
export { type ProjectInvitationMailInput, projectInvitationMail } from './project-invitation';
export { type VerificationMailInput, verificationMail } from './verification';
export { type WebhookPausedMailInput, webhookPausedMail } from './webhook-paused';
