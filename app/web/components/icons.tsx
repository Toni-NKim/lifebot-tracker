const PATHS = {
  dashboard: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  stats: 'M6 20V11M12 20V5M18 20v-6',
  history: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  habits: 'M5 12.5l4.5 4.5L19 7.5',
  routines: 'M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M6 12h12',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4M12 16h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  pause: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8 12h8',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12',
  timebox: 'M5 5h14v15H5zM5 9h14M9 3v4M15 3v4M8 13h5M8 16.5h8',
  todo: 'M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5',
  inbox: 'M4 13l2.5-7h11l2.5 7v6H4zM4 13h5l1 2h4l1-2h5',
  play: 'M8 5.5v13l10-6.5z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  calendar: 'M5 6h14v14H5zM5 10h14M9 4v4M15 4v4',
} as const;
export type IconName = keyof typeof PATHS;
// Stroke icons in currentColor; decorative unless the parent labels them.
export function Icon({
  name,
  size = 20,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
