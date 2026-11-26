import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SignIn } from './sign-in.tsx';

function classes(element: Element | null | undefined): string[] {
  return [...(element?.classList ?? [])].sort();
}
function words(...parts: string[]): string[] {
  return parts.join(' ').split(' ').filter(Boolean).sort();
}

const card = 'rounded-[12px] border border-border bg-card shadow-card';
const button = 'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3.5 text-sm font-medium no-underline disabled:cursor-default disabled:opacity-55';
const primary = 'border-accent bg-accent text-on-accent hover:bg-accent hover:text-on-accent';

test('each reason the sign-in was sent back with reads as pinned, above the button, and none or an empty one shows no alert', () => {
  const reasons = [
    ['denied', 'GitHub did not give access. Sign in again to try once more.'],
    ['not_allowed', 'This GitHub account may not open this page.'],
    ['unverified', 'The team membership could not be read, so the sign-in was refused.'],
    ['state', 'The sign-in took too long or was started in another window. Sign in again.'],
    ['github', 'GitHub could not be reached. Sign in again in a moment.'],
    ['failed', 'The sign-in failed.'],
    ['busy', 'The sign-in failed.'],
    ['__proto__', 'The sign-in failed.'],
    ['toString', 'The sign-in failed.'],
  ] as const;
  for (const [error, text] of reasons) {
    const { unmount } = render(<SignIn error={error} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    const link = screen.getByRole('link', { name: 'Sign in with GitHub' });
    expect(alert.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
  }

  for (const error of [null, '']) {
    const { unmount } = render(<SignIn error={error} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    unmount();
  }
});

test('the sign-in page is a centred card with the brand, its heading, its line and the way in', () => {
  render(<SignIn error={null} />);
  const title = screen.getByRole('heading', { level: 1, name: 'Sign in' });
  const box = title.closest('[data-slot="card"]');
  expect(classes(box)).toEqual(words(card, 'flex w-full max-w-[400px] flex-col gap-4 p-8'));
  expect(classes(box?.parentElement)).toEqual(words('flex min-h-screen items-center justify-center bg-bg px-4 font-sans text-text'));
  expect(screen.getByText('Visto AI').tagName).toBe('STRONG');
  expect(screen.getByText('Review service')).toBeInTheDocument();
  expect(screen.getByText('Sign in with the GitHub account this deployment lets in.')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'Sign in with GitHub' });
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', '/api/auth/start');
  expect(classes(link)).toEqual(words(button, primary, 'self-start'));
  expect(classes(screen.getByText('Sign in with the GitHub account this deployment lets in.'))).toEqual(words('text-sm text-muted'));
  expect(screen.queryByRole('button')).toBeNull();
});
