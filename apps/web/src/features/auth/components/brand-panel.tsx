import { ArrowUp, Check, LayoutGrid, Paperclip, Sparkles } from 'lucide-react';

const features = [
  'Live preview on a real URL, in seconds',
  'Every turn checkpointed — revert anything',
  'Your own Claude subscription',
] as const;

/**
 * The dark marketing half of the auth screens. Decorative only, so it is hidden
 * from assistive technology and from viewports too narrow to give it room.
 */
export function BrandPanel(): React.JSX.Element {
  return (
    <aside
      aria-hidden="true"
      className="relative hidden overflow-hidden bg-[linear-gradient(121deg,#081915_11%,#0d2e27_47%,#103c33_69%,#17685a_81%)] lg:flex lg:items-center lg:justify-center lg:px-8 lg:pb-[62px]"
    >
      <div className="absolute top-[-170px] left-[41.7%] h-[420px] w-[560px] rounded-[50%] bg-[#4fd6b5] opacity-20 blur-[90px]" />
      <div className="absolute top-[62%] left-[41.7%] h-[420px] w-[520px] rounded-[50%] bg-[#14685a] opacity-[0.24] blur-[95px]" />

      <div className="relative w-full max-w-[452px]">
        <p className="text-display-sm text-on-panel font-semibold">
          Ship the internal tool you keep asking for.
        </p>
        <p className="text-body-md text-on-panel-muted mt-3.5">
          Describe it in a sentence. BAIOS builds it in a sandbox, shows you a live preview, and
          keeps every checkpoint.
        </p>

        <div className="mt-[30px] rounded-[14px] border border-white/[0.17] bg-white/[0.09] pt-3.5 pr-[11px] pb-[11px] pl-[15px]">
          <div className="flex items-center gap-[9px]">
            <Sparkles className="text-panel-mint size-4 shrink-0" />
            <p className="text-body-md text-on-panel">A dashboard for our weekly on-call rota</p>
          </div>
          <div className="mt-[13px] flex items-center gap-2">
            <Paperclip className="text-on-panel-muted size-[15px]" />
            <LayoutGrid className="text-on-panel-muted size-[15px]" />
            <span className="flex-1" />
            <span className="bg-panel-mint flex size-[30px] items-center justify-center rounded-full">
              <ArrowUp className="size-[15px] text-[#081915]" />
            </span>
          </div>
        </div>

        <ul className="mt-[30px] space-y-[11px]">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-2.5">
              <Check className="text-panel-mint size-[15px] shrink-0" />
              <span className="text-body-sm text-on-panel-muted">{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
