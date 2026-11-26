// The theme the viewer chose, applied from the page's head before it paints (call 18), so a stored choice shows no flash of the
// other theme. A file of its own, as the policy refuses an inline script. Only a stored choice, and only its own class; with
// none the CSS follows the system, and main.tsx applies the theme again and follows the system's changes.
try {
  const theme = window.localStorage.getItem('visto-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.classList.remove(theme === 'dark' ? 'light' : 'dark');
    document.documentElement.classList.add(theme);
  }
} catch {
  // A storage that throws is no choice.
}
