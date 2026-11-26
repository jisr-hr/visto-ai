import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

// The mockup's .input (Activity.dc.html); the native select wears the same.
export const fieldClasses = 'min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(fieldClasses, className)} {...props} />;
}
