import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

// The mockup's .card (Activity.dc.html).
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('rounded-[12px] border border-border bg-card shadow-card', className)} {...props} />;
}
