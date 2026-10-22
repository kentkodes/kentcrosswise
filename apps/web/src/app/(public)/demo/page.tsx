// Public demo: synthetic data only, from @kcw/demo-data.
import { getDemoData } from "@kcw/demo-data";

export default function DemoPage() {
  const data = getDemoData();
  const latest = data.moods.at(-1);
  const followers = data.socialAccounts.map((a) => {
    const last = data.socialSnapshots.filter((s) => s.accountId === a.id).at(-1);
    return { platform: a.platform, followers: last?.followers ?? 0 };
  });
  return (
    <main>
      <h1>Demo</h1>
      <p>Everything on this page is simulated. The people are not real.</p>
      <h2>Contacts</h2>
      <ul>
        {data.contacts.slice(0, 5).map((c) => (
          <li key={c.id}>
            {c.name} ({c.howKnown})
          </li>
        ))}
      </ul>
      <h2>Mood, latest day</h2>
      {latest && (
        <p>
          Happiness {latest.happiness.toFixed(2)}, stress {latest.stress.toFixed(2)}, sentiment{" "}
          {latest.sentiment.toFixed(2)}
        </p>
      )}
      <h2>Followers</h2>
      <ul>
        {followers.map((f) => (
          <li key={f.platform}>
            {f.platform}: {f.followers.toLocaleString("en-US")}
          </li>
        ))}
      </ul>
    </main>
  );
}
