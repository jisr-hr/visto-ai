import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';
import { fieldClasses } from './input.tsx';

// A native select, as the mockup draws the repository filter: shadcn's Select adds a style element, which the policy refuses.
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(fieldClasses, className)} {...props} />;
}
