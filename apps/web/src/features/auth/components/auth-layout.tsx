import type { PropsWithChildren } from 'react';

import { BrandPanel } from './brand-panel';

/**
 * Split auth shell: the form column on the left, the brand panel on the right.
 * Below `lg` the brand panel is dropped and the form takes the full width.
 */
export function AuthLayout({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <main className="bg-canvas flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-[392px]">{children}</div>
      </main>
      <BrandPanel />
    </div>
  );
}
