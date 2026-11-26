import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

// The mockup's .t (Activity.dc.html): its head cells, its cells, no line under the last row, and a row lit under the pointer.
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table data-slot="table" className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child_td]:border-b-0', className)} {...props} />;
}

export function TableRow({ className, hover = false, ...props }: ComponentProps<'tr'> & { hover?: boolean }) {
  return <tr data-slot="table-row" className={cn(hover && 'hover:[&>td]:bg-subtle', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn('whitespace-nowrap border-b border-border px-4 py-2.5 text-left text-xs font-medium text-muted', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('border-b border-border px-4 py-3 align-middle', className)} {...props} />;
}
