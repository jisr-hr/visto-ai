import { cn } from '../lib/utils.ts';

// The mockup's .seg (Activity.dc.html): one button on at a time, told by aria-pressed.
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex flex-wrap gap-0.5 rounded-[9px] bg-subtle p-[3px]', className)}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            className={cn(
              'min-h-8 cursor-pointer rounded-[7px] border-0 bg-transparent px-3 py-1.5 text-[13px] font-medium text-muted',
              on && 'bg-card text-text shadow-card',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
