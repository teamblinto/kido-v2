import { CopyCommand } from './copy-command';
import {
  COMPANION_PAIR_COMMAND,
  START_COMMAND,
  WORKSPACE_ADD_COMMAND,
  loginCommand,
} from './local-agent-copy';

/** What runs where, and the four commands that set it up. */
export function SetupSteps(): React.JSX.Element {
  return (
    <section aria-labelledby="local-agents-setup" className="mt-6">
      <h2 id="local-agents-setup" className="text-heading-sm font-semibold">
        How it works
      </h2>
      <p className="text-body-sm text-subdued mt-1">
        Runs happen on your own computer, through the official Claude Code or Codex CLI you are
        already signed in to. BAIOS never sees your provider credentials. Your prompts and the
        agent&apos;s output are stored in BAIOS like any other run.
      </p>
      <ol className="text-body-sm mt-3 grid list-decimal gap-3 pl-5">
        <li>
          Pair this computer, then approve the code it prints below.
          <CopyCommand
            className="mt-1 flex w-fit"
            command={COMPANION_PAIR_COMMAND(window.location.origin)}
          />
        </li>
        <li>
          Add the folders the agent may work in.
          <CopyCommand className="mt-1 flex w-fit" command={WORKSPACE_ADD_COMMAND} />
        </li>
        <li>
          Sign in to the CLI you want to use, if you have not already.
          <span className="mt-1 flex flex-wrap gap-2">
            <CopyCommand command={loginCommand('claude')} />
            <CopyCommand command={loginCommand('codex')} />
          </span>
        </li>
        <li>
          Start the companion and leave it running.
          <CopyCommand className="mt-1 flex w-fit" command={START_COMMAND} />
        </li>
      </ol>
    </section>
  );
}
