import { cn } from '../../lib/utils.ts';

// The mockup's .switch (Settings.dc.html): a button that says whether it is on, with a knob that moves.
export function Switch({
  checked,
  onChange,
  labelledBy,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      disabled={disabled}
      title={title}
      className={cn(
        'relative h-[26px] w-11 flex-none cursor-pointer rounded-full border-0 p-0 disabled:cursor-default disabled:opacity-55',
        checked ? 'bg-accent' : 'bg-muted',
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden="true"
        className={cn('absolute top-[3px] left-[3px] size-5 rounded-full bg-card shadow-card transition-[left] duration-150', checked && 'left-[21px]')}
      />
    </button>
  );
}
