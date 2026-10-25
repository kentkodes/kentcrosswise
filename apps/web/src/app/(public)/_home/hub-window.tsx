// The simulated hub window on the home page. Real DOM, laid out flat (912x665) and tilted onto the
// comp's window with a CSS matrix3d (see home.module.css). Hub fixtures are simulated; activity is public.
import type { CSSProperties } from "react";
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { getDemoData, type DemoMood } from "@kcw/demo-data";
import {
  ArrowRight,
  Bars,
  Building,
  ChevronRight,
  External,
  Gear,
  Heart,
  Home,
  Info,
  InstagramMark,
  Leaf,
  Note,
  People,
  Sparkle,
  TikTokMark,
  YouTubeMark,
} from "./icons";
import { DayNightToggle } from "./scene";
import { RecentActivity } from "./recent-activity";
import { SidebarScroller } from "./sidebar-scroller";
import s from "./home.module.css";
import avatar1 from "./plates/avatar-1.png";
import avatar2 from "./plates/avatar-2.png";
import avatar3 from "./plates/avatar-3.png";

const AVATARS: StaticImageData[] = [avatar1, avatar2, avatar3];

const SIDEBAR = [
  { label: "Home", href: "/", Icon: Home, current: true },
  { label: "People", href: "/demo", Icon: People, filled: true },
  { label: "Mood", href: "/demo", Icon: Bars, filled: true },
  { label: "Following", href: "/demo", Icon: Heart, soft: true },
  { label: "Notes", href: "/demo", Icon: Note },
  { label: "Agents", href: "/office", Icon: Sparkle },
] as const;

const PLATFORM = {
  youtube: { label: "YouTube", Mark: YouTubeMark },
  instagram: { label: "Instagram", Mark: InstagramMark },
  tiktok: { label: "TikTok", Mark: TikTokMark },
} as const;

const fmt = (n: number) => n.toLocaleString("en-US");

// Monotone cubic (Fritsch-Carlson) through the points: smooth, and never overshoots the data.
function monotonePath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length;
  if (n === 0) return "";
  const f = (v: number) => v.toFixed(2);
  if (n === 1) return `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    slope.push((pts[i + 1]![1] - pts[i]![1]) / dx[i]!);
  }
  const t: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    t.push(a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b));
  }
  t.push(slope[n - 2]!);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${f(x0 + h)} ${f(y0 + t[i]! * h)} ${f(x1 - h)} ${f(y1 - t[i + 1]! * h)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}

// The plot is an SVG stretched to its box (data space 0..100 on both axes); line and grid keep a
// constant stroke. Labels and point markers are HTML positioned by percentage, so their text size is
// set in CSS per layout and never scales with the chart width.
function MoodChart({
  moods,
  metric,
  label,
  tone,
}: {
  moods: DemoMood[];
  metric: "happiness" | "stress";
  label: string;
  tone: "green" | "coral";
}) {
  const last = Math.max(1, moods.length - 1);
  const pts = moods.map((m, i) => [(i / last) * 100, (1 - m[metric]) * 100] as const);
  const line = monotonePath(pts);
  const area = `${line} L100 100 L0 100 Z`;
  const fillId = `kcw-mood-${metric}`;
  const days = moods.map((m) =>
    new Date(m.scoredAt).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
  );
  const summary = moods.map((m) => m[metric].toFixed(2)).join(", ");
  const at = (x: number, y: number) => ({ "--x": x / 100, "--y": y / 100 }) as CSSProperties;
  return (
    <div
      className={`${s.chart} ${tone === "green" ? s.chartGreen : s.chartCoral}`}
      role="img"
      aria-label={`${label}, last 7 days: ${summary}`}
    >
      <svg className={s.chartPlot} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={s.chartFillTop} />
            <stop offset="1" className={s.chartFillBottom} />
          </linearGradient>
        </defs>
        {[0, 50, 100].map((y) => (
          <line key={y} className={s.chartGrid} x1={0} x2={100} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
        ))}
        <path className={s.chartArea} d={area} fill={`url(#${fillId})`} />
        <path className={s.chartLine} d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      {pts.map(([x, y], i) => (
        <span key={i} className={s.chartPoint} style={at(x, y)} aria-hidden="true" />
      ))}
      {[1, 0.5, 0].map((v) => (
        <span key={v} className={s.chartY} style={at(0, (1 - v) * 100)} aria-hidden="true">
          {v.toFixed(1)}
        </span>
      ))}
      {/* Every day keeps its point; alternate days carry a label so the text stays legible. */}
      {days.map((d, i) =>
        i % 2 === 0 ? (
          <span key={i} className={s.chartX} style={at(pts[i]![0], 100)} aria-hidden="true">
            {d}
          </span>
        ) : null,
      )}
    </div>
  );
}

export function HubWindow() {
  const data = getDemoData();
  const people = data.contacts.slice(0, 3);
  const week = data.moods.slice(-7);
  const latest = week.at(-1);
  const following = data.socialAccounts.map((a) => ({
    platform: a.platform,
    followers: data.socialSnapshots.filter((x) => x.accountId === a.id).at(-1)?.followers ?? 0,
  }));

  return (
    <section className={s.hub} aria-labelledby="hub-greeting">
      <div className={s.hubSurface} aria-hidden="true" />

      <header className={s.hubHeader}>
        <p className={s.hubBrand}>
          <Leaf className={s.hubLeaf} />
          Kentcrosswise
        </p>
        <p className={s.simulated}>
          Simulated data
          <Info className={s.simulatedIcon} />
          <span className={s.srOnly}>: people, mood and following are simulated. Agent activity comes from the real public feed.</span>
        </p>
        <DayNightToggle className={s.hubToggle} />
      </header>

      <SidebarScroller>
        <ul className={s.sideList}>
          {SIDEBAR.map(({ label, href, Icon, ...rest }) => (
            <li key={label}>
              <Link
                className={s.sideLink}
                href={href}
                aria-current={"current" in rest ? "page" : undefined}
              >
                <Icon
                  className={`${s.sideIcon} ${"filled" in rest ? s.iconFilled : ""} ${"soft" in rest ? s.iconSoft : ""}`}
                />
                {label}
              </Link>
            </li>
          ))}
        </ul>
        <ul className={`${s.sideList} ${s.sideListLower}`}>
          <li>
            <Link className={s.sideLink} href="/office">
              <External className={s.sideIcon} />
              Agent office
              <ChevronRight className={s.sideChevron} />
            </Link>
          </li>
          <li>
            <a className={s.sideLink} href="#scene-light">
              <Gear className={s.sideIcon} />
              Settings
            </a>
          </li>
        </ul>
      </SidebarScroller>

      <h2 id="hub-greeting" className={s.greeting}>
        Good evening.
      </h2>
      <p className={s.hubIntro}>A sample hub, with real public activity from the agents building this site.</p>

      <section className={`${s.panel} ${s.peoplePanel}`} aria-labelledby="hub-people">
        <h3 id="hub-people" className={s.panelTitle}>
          People
        </h3>
        <Link className={s.panelAside} href="/demo">
          View all
          <ArrowRight className={s.asideArrow} />
        </Link>
        <ul className={s.peopleList}>
          {people.map((p, i) => (
            <li key={p.id}>
              <Link className={s.person} href="/demo">
                <span className={s.avatar}>
                  <Image className={s.avatarImg} src={AVATARS[i]!} alt="" loading="eager" unoptimized />
                  <span className={s.avatarDot} />
                </span>
                <span className={s.personName}>{p.name}</span>
                <ChevronRight className={s.personChevron} />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${s.panel} ${s.moodPanel}`} aria-labelledby="hub-mood">
        <h3 id="hub-mood" className={s.panelTitle}>
          Mood
        </h3>
        <p className={s.panelAside}>Last 7 days</p>
        <div className={s.moodCol}>
          <p className={s.moodLabel}>Happiness</p>
          <p className={s.moodValue}>{latest?.happiness.toFixed(2)}</p>
          <MoodChart moods={week} metric="happiness" label="Happiness" tone="green" />
        </div>
        <div className={`${s.moodCol} ${s.moodColStress}`}>
          <p className={s.moodLabel}>Stress</p>
          <p className={s.moodValue}>{latest?.stress.toFixed(2)}</p>
          <MoodChart moods={week} metric="stress" label="Stress" tone="coral" />
        </div>
      </section>

      <section className={`${s.panel} ${s.followingPanel}`} aria-labelledby="hub-following">
        <h3 id="hub-following" className={s.panelTitle}>
          Following
        </h3>
        <p className={s.panelAside}>Total</p>
        <ul className={s.socialList}>
          {following.map(({ platform, followers }) => {
            const { label, Mark } = PLATFORM[platform];
            return (
              <li key={platform}>
                <Link className={s.social} href="/demo">
                  <Mark className={s.socialMark} />
                  <span className={s.socialName}>{label}</span>
                  <span className={s.socialCount}>{fmt(followers)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={`${s.panel} ${s.activityPanel}`} aria-labelledby="hub-activity">
        <h3 id="hub-activity" className={s.panelTitle}>
          Recent activity
        </h3>
        <RecentActivity />
      </section>

      <section className={`${s.panel} ${s.explorePanel}`} aria-labelledby="hub-explore">
        <h3 id="hub-explore" className={s.panelTitle}>
          Explore more
        </h3>
        <ul className={s.exploreList}>
          <li>
            <Link className={s.explore} href="/demo">
              <span className={s.exploreTile}>
                <Sparkle className={`${s.exploreIcon} ${s.iconFilled}`} />
              </span>
              <span className={s.exploreName}>Explore the demo</span>
              <span className={s.exploreDesc}>Try the full experience with simulated data.</span>
              <ArrowRight className={s.exploreArrow} />
            </Link>
          </li>
          <li>
            <Link className={`${s.explore} ${s.exploreTall}`} href="/office">
              <span className={s.exploreTile}>
                <Building className={s.exploreIcon} />
              </span>
              <span className={s.exploreName}>View agent activity</span>
              <span className={s.exploreDesc}>Real events from building this site.</span>
              <External className={s.exploreArrow} />
            </Link>
          </li>
        </ul>
      </section>
    </section>
  );
}
