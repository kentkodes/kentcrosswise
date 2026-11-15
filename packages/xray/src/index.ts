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
    what: "A plain link to sign in. Your browser asks the session endpoint and the link becomes Your hub for the signed-in owner.",
    why: "The page stays static and never reads the session on the server. Only the allowlisted owner can sign in.",
  },
  "fonts-theme": {
    label: "Type and theme",
    tech: "Geist, CSS variables",
    what: "Text is set in Geist, with Geist Mono for small technical text. Colours are shared variables that follow your light or dark setting.",
    why: "Fonts are self-hosted at build time, so visiting sends no request to Google. One set of colours keeps every page consistent.",
  },
  "product-still": {
    label: "Hub preview",
    tech: "React server component, @kcw/demo-data",
    what: "A still picture of the private hub, drawn from simulated people, mood and follower numbers.",
    why: "Visitors see what the hub looks like while no private data can reach a public page.",
  },
  "activity-feed": {
    label: "Agent activity",
    tech: "Polling a public JSON feed",
    what: "The latest public events from the agents, such as a pull request opened or merged. The page asks for new ones every few seconds.",
    why: "A cached JSON endpoint needs no extra service. Titles are checked first, so a private task shows only as Private task.",
  },
  "demo-data": {
    label: "Simulated data",
    tech: "@kcw/demo-data",
    what: "People, notes, mood and follower numbers are generated from a fixed seed, so every visit shows the same made-up hub.",
    why: "The real hub is private. This package is one of only two workspace packages the public pages may import.",
  },
  "demo-app": {
    label: "Demo hub",
    tech: "React, server-built view model",
    what: "Tabs for Today, People, Mood, Following and Notes. The server prepares the numbers and the browser only tracks the selected tab.",
    why: "Every figure comes from the demo data through one view model, and the client code stays small.",
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
    why: "Plain canvas drawing needs no game engine or extra dependency, and the room reads the same feed as the board.",
  },
  "bot-page": {
    label: "Bot notes",
    tech: "Next.js server page",
    what: "Says what KentcrosswiseBot is for, how it will identify itself and where to report a problem. Automated discovery is not enabled yet.",
    why: "The essay crawl must obey robots.txt and rate-limit every site. A public page lets site owners see who is asking.",
  },
} as const satisfies Record<string, XrayEntry>;

/** A component id that exists in the registry. */
export type XrayId = keyof typeof XRAY;

/** All registry ids. */
export const XRAY_IDS = Object.keys(XRAY) as XrayId[];
