import { PageHeader } from '../components/layout.tsx';

/** A screen a later plan builds (call 25): its name, and that it is still to come. */
export function Later({ title }: { title: string }) {
  return <PageHeader title={title} sub="Coming in a later plan." />;
}
