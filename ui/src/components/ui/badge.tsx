import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

// The mockup's .badge, its tones .b-ok to .b-accent, and its .dot (Activity.dc.html).
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium',
  {
    variants: {
      tone: {
        ok: 'bg-ok-bg text-ok',
        warn: 'bg-warn-bg text-warn',
        bad: 'bg-bad-bg text-bad',
        info: 'bg-info-bg text-info',
        muted: 'bg-subtle text-muted',
        accent: 'bg-accent-soft text-accent-text',
      },
    },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({
  className,
  tone,
  dot = false,
  children,
  ...props
}: ComponentProps<'span'> & { tone: BadgeTone; dot?: boolean }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span className="inline-block size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
