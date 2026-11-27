import type { ReactElement, ReactNode } from 'react';

// The mockup's icons (Activity.dc.html, lines 52 to 67): strokes in the text's colour on a 24 by 24 box, hidden from
// assistive technology. The sign-out icon is ours (call 24), drawn the same way.
function Icon({ size, weight = 2, children }: { size: 16 | 18; weight?: 2 | 2.5; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * The project icon (assets/icon.svg), shape for shape, drawn at 32 by 32 beside the name, which says what it is. Its tile is
 * the dark theme's card colour, so a ring in the border's colour keeps its edge there.
 */
export function BrandMark() {
  return (
    <svg aria-hidden="true" width={32} height={32} viewBox="0 0 512 512" className="shrink-0 rounded-[7px] ring-1 ring-border">
      <rect width="512" height="512" rx="112" fill="#0e211d" />
      <rect x="108" y="140" width="208" height="56" rx="28" fill="#f3f6f4" fillOpacity="0.32" />
      <rect x="108" y="228" width="216" height="56" rx="28" fill="#34d399" />
      <circle cx="376" cy="256" r="28" fill="#f3f6f4" />
      <rect x="108" y="316" width="144" height="56" rx="28" fill="#f3f6f4" fillOpacity="0.32" />
    </svg>
  );
}

export function OverviewIcon() {
  return (
    <Icon size={18}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Icon>
  );
}

export function ActivityIcon() {
  return (
    <Icon size={18}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Icon>
  );
}

export function RepositoriesIcon() {
  return (
    <Icon size={18}>
      <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 19a2 2 0 0 1 2-2h12v4H6a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

export function MemoryIcon() {
  return (
    <Icon size={18}>
      <path d="M12 3v18" />
      <path d="M8 7a4 4 0 0 1 4-4 4 4 0 0 1 4 4c2 .5 3 2 3 4s-1 3.5-3 4a4 4 0 0 1-4 4 4 4 0 0 1-4-4c-2-.5-3-2-3-4s1-3.5 3-4z" />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon size={18}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </Icon>
  );
}

export function MoonIcon() {
  return (
    <Icon size={16}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Icon>
  );
}

export function SignOutIcon() {
  return (
    <Icon size={16}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5" />
      <path d="M5 12h11" />
    </Icon>
  );
}

/** The mockup's alert circle (Review.dc.html, line 78), at the helper's size. */
export function AlertIcon(): ReactElement {
  return (
    <Icon size={18}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5v.01" />
    </Icon>
  );
}
