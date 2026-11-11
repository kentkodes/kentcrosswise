// The home page's product still: a framed, static picture of the hub, built from simulated data.
// Only the live activity list (RecentActivity) is client-side. Sidebar is decorative and hidden on phones.
import { getDemoData, type Platform } from "@kcw/demo-data";
import { RecentActivity } from "./recent-activity";
import s from "./home.module.css";

const SIDEBAR = ["Today", "People", "Mood", "Following", "Notes", "Agents"];
const PLATFORM: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

// Sparkline in user units, drawn 1:1 at its CSS size so the endpoint dot stays round.
const W = 160;
const H = 36;
const PAD_X = 4;

// Scales the week's values to their own min and max, with 15% of the height left empty at top and
// bottom. If every value is equal, the line is drawn flat through the middle.
function sparkline(values: number[]) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const top = H * 0.15;
  const bottom = H * 0.85;
  const step = values.length > 1 ? (W - 2 * PAD_X) / (values.length - 1) : 0;
  const pts = values.map((v, i) => ({
    x: PAD_X + i * step,
    y: hi === lo ? H / 2 : bottom - ((v - lo) / (hi - lo)) * (bottom - top),
  }));
  const end = pts.at(-1);
  if (!end) return undefined;
  return { points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), end };
}

export function ProductStill() {
  const data = getDemoData();
  const spark = sparkline(data.moods.slice(-7).map((m) => m.sentiment));
  const contact = data.contacts[0];
  const account = data.socialAccounts[0];
  const followers = account ? data.socialSnapshots.filter((x) => x.accountId === account.id).at(-1) : undefined;

  return (
    <div className={s.still}>
      <div className={s.side} aria-hidden="true">
        {SIDEBAR.map((item, i) => (
          <div key={item} className={i === 0 ? `${s.sideItem} ${s.sideOn}` : s.sideItem}>
            {item}
          </div>
        ))}
      </div>
      <div className={s.content}>
        <div className={s.greet}>
          <strong className={s.greetTitle}>Today</strong>
          <span className={s.label}>Simulated data</span>
        </div>
        <div className={s.cards}>
          <div className={s.card}>
            <span className={s.cardLabel}>Mood, 7 days</span>
            {spark ? (
              <svg className={s.spark} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={spark.points}
                />
                <circle cx={spark.end.x} cy={spark.end.y} r="2.5" fill="currentColor" />
              </svg>
            ) : null}
          </div>
          {contact ? (
            <div className={s.card}>
              <span className={s.cardLabel}>Follow up</span>
              <p className={s.cardValue}>{contact.name}</p>
              <span className={s.cardNote}>{contact.howKnown}</span>
            </div>
          ) : null}
          {account && followers ? (
            <div className={s.card}>
              <span className={s.cardLabel}>Followers</span>
              <p className={s.cardValue}>{followers.followers.toLocaleString("en-US")}</p>
              <span className={s.cardNote}>{PLATFORM[account.platform]}</span>
            </div>
          ) : null}
        </div>
        <RecentActivity />
      </div>
    </div>
  );
}
