// Small interface icons for the home page: one 24-unit grid, 1.6 stroke, round caps. Decorative
// (aria-hidden); every control that uses one also carries a text label.
import type { ReactNode } from "react";

type IconProps = { className?: string };

function Icon({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12h15m-6-6 6 6-6 6" />
  </Icon>
);
export const ChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);
export const Leaf = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 20c2-6 6-11 14-15-1 8-5 13-11 14" />
    <path d="M4 21c3-4 6-7 10-10M9 13l-2-3m5 0-1-3m3 7 3 0" />
  </Icon>
);
export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </Icon>
);
export const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M12 2.8v2.4m0 13.6v2.4M2.8 12h2.4m13.6 0h2.4M5.5 5.5l1.7 1.7m9.6 9.6 1.7 1.7m0-13-1.7 1.7m-9.6 9.6-1.7 1.7" />
  </Icon>
);
export const Moon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" />
  </Icon>
);
export const Home = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 11.5 12 5l8 6.5M6.5 10v9h11v-9M10 19v-5h4v5" />
  </Icon>
);
export const People = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="9" r="3" />
    <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <circle cx="16.5" cy="9.5" r="2.4" />
    <path d="M15.5 14.2c2.6-.3 4.4 1.3 5 4.3" />
  </Icon>
);
export const Bars = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.6" y="12.5" width="3" height="7" rx="0.9" />
    <rect x="10.5" y="7.5" width="3" height="12" rx="0.9" />
    <rect x="16.4" y="4.5" width="3" height="15" rx="0.9" />
  </Icon>
);
export const Heart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.1C19 14.6 12 19 12 19Z" />
  </Icon>
);
export const Note = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="4" width="13" height="16" rx="1.5" />
    <path d="M8.5 8.5h7m-7 3.5h7m-7 3.5h4" />
  </Icon>
);
export const Sparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5c.6 4.6 2.4 6.9 7 8.5-4.6 1.6-6.4 3.9-7 8.5-.6-4.6-2.4-6.9-7-8.5 4.6-1.6 6.4-3.9 7-8.5Z" />
  </Icon>
);
export const External = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 4.5h6v6m0-6-8 8M10 5.5H6A1.5 1.5 0 0 0 4.5 7v11A1.5 1.5 0 0 0 6 19.5h11a1.5 1.5 0 0 0 1.5-1.5v-4" />
  </Icon>
);
export const Gear = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.45 5.28L10.64 2.90L13.36 2.90L13.55 5.28L15.66 6.15L17.47 4.60L19.40 6.53L17.85 8.34L18.72 10.45L21.10 10.64L21.10 13.36L18.72 13.55L17.85 15.66L19.40 17.47L17.47 19.40L15.66 17.85L13.55 18.72L13.36 21.10L10.64 21.10L10.45 18.72L8.34 17.85L6.53 19.40L4.60 17.47L6.15 15.66L5.28 13.55L2.90 13.36L2.90 10.64L5.28 10.45L6.15 8.34L4.60 6.53L6.53 4.60L8.34 6.15Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);
export const Document = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" />
    <path d="M13.5 3.5v4.5h4.5M9.5 12h5m-5 3.5h5" />
  </Icon>
);
export const Play = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
    <path d="m10.5 9.5 4 2.5-4 2.5Z" fill="currentColor" />
  </Icon>
);
export const Building = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 20V5.5h9V20M14 10h5v10M3.5 20h17M8 8.5h1.5m-1.5 3h1.5m-1.5 3h1.5m7-1.5h.5m-.5 3h.5" />
  </Icon>
);

/* Platform marks, simplified to icon size. */
export const YouTubeMark = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
    <rect x="2" y="6" width="24" height="16" rx="4.5" fill="#f2302b" />
    <path d="m11.5 10.2 6.6 3.8-6.6 3.8Z" fill="#fff" />
  </svg>
);
export const InstagramMark = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="kcw-ig" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="#f9a23c" />
        <stop offset=".45" stopColor="#e8336a" />
        <stop offset="1" stopColor="#8a3bd1" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="24" height="24" rx="7" fill="url(#kcw-ig)" />
    <rect x="7" y="7" width="14" height="14" rx="4.5" fill="none" stroke="#fff" strokeWidth="1.8" />
    <circle cx="14" cy="14" r="3.4" fill="none" stroke="#fff" strokeWidth="1.8" />
    <circle cx="18.6" cy="9.4" r="1.1" fill="#fff" />
  </svg>
);
export const TikTokMark = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="26" height="26" rx="6" fill="#111" />
    {[
      ["#25f4ee", -0.9, -0.6],
      ["#fe2c55", 0.9, 0.6],
      ["#fff", 0, 0],
    ].map(([color, dx, dy]) => (
      <path
        key={color as string}
        d="M15.5 5.5v11.2a3.6 3.6 0 1 1-3.2-3.6M15.5 5.5c.5 2.4 2 4 4.6 4.2"
        transform={`translate(${dx} ${dy})`}
        fill="none"
        stroke={color as string}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    ))}
  </svg>
);
