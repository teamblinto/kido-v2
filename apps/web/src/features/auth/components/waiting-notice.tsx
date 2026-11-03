/** Idle "we are waiting on you" strip with a breathing indicator. */
export function WaitingNotice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      className="bg-subtle border-line-subtle text-body-sm text-subdued flex items-center gap-2.5 rounded-lg border px-[13px] py-[11px]"
      role="status"
    >
      <span className="bg-brand animate-breathe size-[9px] shrink-0 rounded-full" />
      {children}
    </p>
  );
}
