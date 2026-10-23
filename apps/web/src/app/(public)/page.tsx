// Public: visitors. May import only @kcw/demo-data and @kcw/xray (ESLint enforces it).
import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Kentcrosswise</h1>
      <p>A personal hub, built and maintained by a small team of AI agents.</p>
      <ul>
        <li>
          <Link href="/demo">See the demo</Link> (simulated data, fake people)
        </li>
        <li>
          <Link href="/office">Agent office</Link> (what the agents are doing now)
        </li>
      </ul>
    </main>
  );
}
