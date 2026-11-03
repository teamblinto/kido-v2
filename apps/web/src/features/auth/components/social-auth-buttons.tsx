import { GitHubIcon, GoogleIcon } from '@/components/icons/brand-icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface SocialAuthButtonsProps {
  /** Marks the provider the person used last time. */
  lastUsed?: 'github' | 'google';
  onProviderSelect?: (provider: 'github' | 'google') => void;
}

/** Google and GitHub single sign-on buttons. */
export function SocialAuthButtons({
  lastUsed,
  onProviderSelect,
}: SocialAuthButtonsProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <Button
        type="button"
        variant="outline"
        className="relative w-full gap-2.5"
        onClick={() => onProviderSelect?.('google')}
      >
        <GoogleIcon className="size-[18px]" />
        Continue with Google
        {lastUsed === 'google' ? <Badge className="absolute right-5">Last used</Badge> : null}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="relative w-full gap-2.5"
        onClick={() => onProviderSelect?.('github')}
      >
        <GitHubIcon className="size-[18px]" />
        Continue with GitHub
        {lastUsed === 'github' ? <Badge className="absolute right-5">Last used</Badge> : null}
      </Button>
    </div>
  );
}
