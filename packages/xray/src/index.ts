/** Package name, used by the workspace smoke test. */
export const PACKAGE_NAME = "@kcw/xray";

/** One annotated part of the public site. */
export interface XrayEntry {
  /** Short name of the part, shown on its chip. */
  label: string;
  /** The technology behind it, shown on its chip. */
  tech: string;
  /** What the part does, in plain words. */
  what: string;
  /** Why it was chosen. */
  why: string;
}

// Every entry describes something that is built. Sources: docs/DESIGN.md sections 0, 1, 4.5 and 5, and the code
// of the public pages. Keep each field to one or two short sentences.
export const XRAY = {
  "account-link": {
    label: "Sign-in link",
    tech: "Auth.js, Google",
    what: "A plain link to sign in. Your browser asks the session endpoint and the link becomes Your hub when a session exists.",
    why: "The page stays static and never reads the session on the server. Only the allowlisted owner can sign in.",
  },
  "fonts-theme": {
    label: "Type and theme",
    tech: "Geist, CSS variables",
    what: "Text is set in Geist, with Geist Mono for small technical text. Colours are shared variables that follow your light or dark setting.",
    why: "Fonts are self-hosted at build time, so visiting sends no request to Google. Every page uses the same colour tokens.",
  },
  "log-preview": {
    label: "Latest from the log",
    tech: "A cached public JSON endpoint",
    what: "The three newest published entries of the owner's helper, each with how it was filed and its outcome.",
    why: "It reads the same public API as the log page, which serves only sanitized text and fixed codes.",
  },
  "activity-feed": {
    label: "Agent activity",
    tech: "Polling a public JSON feed",
    what: "The latest public events from the agents, such as a pull request opened or merged. The page asks for new ones every few seconds.",
    why: "A cached JSON endpoint needs no extra service. Titles are checked first, so a private task shows only as Private task.",
  },
  "public-log": {
    label: "Public log",
    tech: "Postgres views, cached JSON",
    what: "Each published entry with its sanitized text, how it was filed and the evidence for every step. Withheld records are only counted.",
    why: "The public API reads two views that hold only sanitized text and fixed codes, so private fields cannot reach this page.",
  },
  "office-board": {
    label: "Office board",
    tech: "Polling the public office feed",
    what: "One card per agent type shows what that agent is doing now, with a filterable activity log.",
    why: "It reads one cached JSON endpoint every 5 seconds, which needs no extra service. The feed carries only sanitized public titles.",
  },
  "office-room": {
    label: "Office room",
    tech: "Canvas 2D",
    what: "Each robot is an agent at its station. Events from the feed play back as movement, and picking an agent shows its task.",
    why: "It draws on a plain canvas and reads the same public feed as the board.",
  },
  "bot-page": {
    label: "Bot notes",
    tech: "Next.js server page",
    what: "Says what KentcrosswiseBot is for, how it will identify itself and where to report a problem. Automated discovery is not enabled yet.",
    why: "The essay crawl must obey robots.txt and rate-limit every site. The planned User-Agent links back to this page, which also gives a way to report a problem.",
  },
} as const satisfies Record<string, XrayEntry>;

/** A component id that exists in the registry. */
export type XrayId = keyof typeof XRAY;

/** All registry ids. */
export const XRAY_IDS = Object.keys(XRAY) as XrayId[];
