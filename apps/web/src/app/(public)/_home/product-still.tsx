// The home page's product still: a framed, static picture of the hub, built from simulated data.
// Only the live activity list (RecentActivity) is client-side. Sidebar is decorative and hidden on phones.
import { getDemoData, type Platform } from "@kcw/demo-data";
import { sparkline, SPARK_H, SPARK_W } from "../_site/sparkline";
import { RecentActivity } from "./recent-activity";
import s from "./home.module.css";

const SIDEBAR = ["Today", "People", "Mood", "Following", "Notes", "Agents"];
const PLATFORM: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

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
              <svg className={s.spark} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true">
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
