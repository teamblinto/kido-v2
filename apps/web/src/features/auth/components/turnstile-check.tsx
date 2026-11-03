import { Check } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { CloudflareIcon } from '@/components/icons/brand-icons';
import { env } from '@/lib/env';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

interface TurnstileApi {
  remove: (widgetId: string) => void;
  render: (
    container: HTMLElement,
    options: {
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      sitekey: string;
    },
  ) => string;
}

declare global {
  interface Window {
    onloadTurnstileCallback?: () => void;
    turnstile?: TurnstileApi;
  }
}

/** One script tag for the page, however many widgets are mounted over its lifetime. */
async function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) {
    return window.turnstile;
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`#${SCRIPT_ID}`);

    if (existing !== null) {
      existing.addEventListener('load', () => {
        resolve();
      });
      existing.addEventListener('error', () => {
        reject(new Error('The security check could not be loaded.'));
      });

      return;
    }

    const script = document.createElement('script');

    script.async = true;
    script.defer = true;
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.addEventListener('load', () => {
      resolve();
    });
    script.addEventListener('error', () => {
      reject(new Error('The security check could not be loaded.'));
    });
    document.head.append(script);
  });

  if (window.turnstile === undefined) {
    throw new Error('The security check loaded but did not initialise.');
  }

  return window.turnstile;
}

interface TurnstileCheckProps {
  /**
   * Called with a token to send, or `undefined` when there is none to send.
   *
   * `undefined` is a legitimate state rather than a failure: a deployment with no site key has no
   * widget, and `TurnstileGuard` on the other side is inert for the matching reason — no
   * `TURNSTILE_SECRET_KEY` means there is nothing a verification could mean.
   */
  onToken?: (token: string | undefined) => void;
}

/**
 * The Cloudflare Turnstile widget, or a stand-in for it where the deployment has no site key.
 *
 * The two halves mirror the server exactly. With a key, this renders the real widget and hands its
 * token to the form, which sends it in `cf-turnstile-response` for `TurnstileGuard` to verify. With
 * no key — every developer machine, and every checkout of this repository — it renders the solved
 * footprint so the surrounding layout is right, and sends nothing. Rendering a real widget against
 * no key would put a permanently failing control on the signup form of every local checkout.
 */
export function TurnstileCheck({ onToken }: TurnstileCheckProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  // Held in a ref so re-rendering the form does not tear down and re-render the widget, which would
  // discard a token the user has already earned. Written in an effect rather than during render,
  // because a ref is not rendering state and React makes no promise about a render that is thrown
  // away.
  const report = useRef(onToken);

  useEffect(() => {
    report.current = onToken;
  }, [onToken]);

  const siteKey = env.VITE_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (siteKey === undefined) {
      report.current?.(undefined);

      return;
    }

    let widgetId: string | undefined;
    let cancelled = false;
    let api: TurnstileApi | undefined;

    void loadTurnstile()
      .then((turnstile) => {
        if (cancelled || container.current === null) {
          return;
        }

        api = turnstile;
        widgetId = turnstile.render(container.current, {
          callback: (token) => {
            report.current?.(token);
          },
          // A token is single-use and short-lived. Clearing it on expiry means the form sends
          // nothing rather than something Cloudflare will refuse, which is the difference between
          // "solve the check" and an error the user cannot connect to anything they did.
          'error-callback': () => {
            report.current?.(undefined);
          },
          'expired-callback': () => {
            report.current?.(undefined);
          },
          sitekey: siteKey,
        });
      })
      .catch(() => {
        // The script is third-party and blockable. Failing to load leaves the form with no token,
        // which the API refuses with `turnstile-check-failed` — a message that names the remedy —
        // rather than the app breaking on an exception nobody can act on.
        report.current?.(undefined);
      });

    return () => {
      cancelled = true;

      if (widgetId !== undefined) {
        api?.remove(widgetId);
      }
    };
  }, [siteKey]);

  if (siteKey !== undefined) {
    return <div ref={container} />;
  }

  return (
    <div
      className="bg-subtle border-line flex items-center gap-[11px] rounded-lg border p-[13px]"
      role="status"
    >
      <span className="bg-brand flex size-5 shrink-0 items-center justify-center rounded-[5px]">
        <Check className="size-[13px] text-white" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-label-sm text-foreground block font-medium">
          Verified you are human
        </span>
        <span className="text-caption text-faint block">Cloudflare · Privacy · Terms</span>
      </span>
      <CloudflareIcon className="text-panel-mint size-5 shrink-0" />
    </div>
  );
}
