/** Horizontal rule with a centred "OR" label. */
export function OrDivider(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3.5 py-[22px]" role="separator" aria-label="or">
      <span className="bg-line h-px flex-1" />
      <span className="text-overline text-faint font-medium">OR</span>
      <span className="bg-line h-px flex-1" />
    </div>
  );
}
