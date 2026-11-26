import { PageHeader } from '../components/layout.tsx';

/** Any path under /ui/ that is no page of the application. */
export function NotFound() {
  return <PageHeader title="Not found" sub="No page at this address." />;
}
