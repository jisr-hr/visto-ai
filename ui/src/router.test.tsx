import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Link, navigate, useLocation } from './router.tsx';

/** Where the page is, as the router reads it. */
function Where() {
  const { path, search } = useLocation();
  return <p>{`at ${path}${search}`}</p>;
}

// Whether each click was taken by the page, read after the Link's own handler. jsdom does not follow a link, so the click is
// stopped here once it is read, as a browser's following would end the page.
const prevented: boolean[] = [];
function record(event: Event): void {
  prevented.push(event.defaultPrevented);
  event.preventDefault();
}

beforeEach(() => {
  prevented.length = 0;
  window.history.replaceState(null, '', '/ui/');
  document.addEventListener('click', record);
});
afterEach(() => {
  document.removeEventListener('click', record);
  window.history.replaceState(null, '', '/');
});

test('a link to an address of the UI goes there in the page, and the browser follows one to anywhere else', () => {
  render(
    <>
      <Where />
      <Link to="/ui/activity">Activity</Link>
      <Link to="https://example.test/">Elsewhere</Link>
      <Link to="/api/auth/start">Sign in</Link>
      <Link to="/ui/../api/auth/start">Around</Link>
      <Link to="/ui">Home</Link>
    </>,
  );
  const length = window.history.length;
  fireEvent.click(screen.getByRole('link', { name: 'Activity' }));
  expect(prevented).toEqual([true]);
  expect(window.location.pathname).toBe('/ui/activity');
  expect(window.history.length).toBe(length + 1);
  expect(screen.getByText('at /ui/activity')).toBeInTheDocument();

  for (const name of ['Elsewhere', 'Sign in', 'Around']) fireEvent.click(screen.getByRole('link', { name }));
  expect(prevented).toEqual([true, false, false, false]);
  expect(window.location.pathname).toBe('/ui/activity');
  expect(window.history.length).toBe(length + 1);

  fireEvent.click(screen.getByRole('link', { name: 'Home' }));
  expect(prevented).toEqual([true, false, false, false, true]);
  expect(window.location.pathname).toBe('/ui');
});

test('navigate does nothing for an address outside the UI', () => {
  render(<Where />);
  const length = window.history.length;
  for (const to of ['/api/auth/start', 'https://example.test/ui/', '//example.test/ui/', '/', '/uix', '/ui/../api/auth/start', '/ui/%2e%2e/api/me']) {
    act(() => navigate(to));
    act(() => navigate(to, true));
  }
  expect(window.location.pathname + window.location.search).toBe('/ui/');
  expect(window.history.length).toBe(length);
  expect(screen.getByText('at /ui/')).toBeInTheDocument();

  act(() => navigate('/ui/memory?tab=all'));
  expect(screen.getByText('at /ui/memory?tab=all')).toBeInTheDocument();
  expect(window.history.length).toBe(length + 1);
});

test('back and forward show the earlier page and the later one again', async () => {
  render(
    <>
      <Where />
      <Link to="/ui/activity">Activity</Link>
    </>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Activity' }));
  expect(screen.getByText('at /ui/activity')).toBeInTheDocument();

  window.history.back();
  expect(await screen.findByText('at /ui/')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/ui/');
  window.history.forward();
  expect(await screen.findByText('at /ui/activity')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/ui/activity');
});

test('a click with ctrl or meta held is the browser\'s, and takes no entry in the history', () => {
  render(
    <>
      <Where />
      <Link to="/ui/activity">Activity</Link>
    </>,
  );
  const length = window.history.length;
  const link = screen.getByRole('link', { name: 'Activity' });
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { metaKey: true });
  expect(prevented).toEqual([false, false]);
  expect(window.history.length).toBe(length);
  expect(window.location.pathname).toBe('/ui/');
  expect(screen.getByText('at /ui/')).toBeInTheDocument();
});
