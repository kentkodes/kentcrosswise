import Link from "next/link";
import { requireOwner } from "@/server/owner";

export default async function HubPage() {
  await requireOwner();
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
        <li>
          <Link href="/essays">Essays</Link>
        </li>
      </ul>
    </main>
  );
}
