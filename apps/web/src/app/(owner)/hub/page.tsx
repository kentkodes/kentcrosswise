import Link from "next/link";

export default function HubPage() {
  return (
    <main>
      <h1>Hub</h1>
      <ul>
        <li>
          <Link href="/console">Boss console</Link>
        </li>
        <li>
          <Link href="/inbox">Inbox</Link>
        </li>
      </ul>
    </main>
  );
}
