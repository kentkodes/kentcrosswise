// Role cards and developer seats for the team board. Relative times appear only after mount; until then
// the absolute UTC time is shown, so the server render and the first client render cannot differ.
import { useEffect, useState } from "react";
import { CARD_INFO, STATUS_TONE, STATUS_WORD, relativeTime, utcLabel, type BoardRole, type DeveloperCard, type Reading, type Roster, type RoleCard, type Status } from "./board-state";
import s from "./board.module.css";

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export function TeamRoster({ roster, nowMs }: { roster: Roster; nowMs: number }) {
  return (
    <div className={s.roster}>
      <RoleCardView role="orchestrator" card={roster.orchestrator} nowMs={nowMs} />
      <DeveloperCardView card={roster.developer} nowMs={nowMs} />
      <RoleCardView role="qa" card={roster.qa} nowMs={nowMs} />
      <RoleCardView role="docs" card={roster.docs} nowMs={nowMs} />
      <RoleCardView role="scraper" card={roster.scraper} nowMs={nowMs} />
    </div>
  );
}

function RoleCardView({ role, card, nowMs }: { role: Exclude<BoardRole, "developer">; card: RoleCard; nowMs: number }) {
  const info = CARD_INFO[role];
  const id = `office-card-${role}`;
  return (
    <article className={s.card} aria-labelledby={id}>
      <CardHead id={id} title={info.title} model={info.model} />
      {info.what && <p className={s.what}>{info.what}</p>}
      <State status={card.status} text={card.text} />
      <footer className={s.foot}><LastEvent at={card.lastEventAt} nowMs={nowMs} /></footer>
    </article>
  );
}

function DeveloperCardView({ card, nowMs }: { card: DeveloperCard; nowMs: number }) {
  const info = CARD_INFO.developer;
  const id = "office-card-developer";
  return (
    <article className={`${s.card} ${s.wide}`} aria-labelledby={id}>
      <CardHead id={id} title={info.title} model={info.model} />
      <State status={card.status} />
      {card.waiting && <p className={s.what}>{card.waiting}</p>}
      <ul className={s.seats}>
        {card.seats.map((seat) => (
          <li key={seat.seat} className={s.seat}>
            <span className={s.seatHead}>
              <Dot status={seat.status} />
              Seat {seat.seat}
            </span>
            <State status={seat.status} text={seat.text} />
          </li>
        ))}
      </ul>
      <footer className={s.foot}>
        {card.annex > 0 && <span>Annex: {card.annex} extra {card.annex === 1 ? "worker" : "workers"}</span>}
        {card.unassigned > 0 && <span>{card.unassigned} unassigned {card.unassigned === 1 ? "worker" : "workers"}</span>}
        <LastEvent at={card.lastEventAt} nowMs={nowMs} />
      </footer>
    </article>
  );
}

function CardHead({ id, title, model }: { id: string; title: string; model: string }) {
  return (
    <div className={s.cardHead}>
      <h3 id={id} className={s.cardTitle}>{title}</h3>
      <span className={s.model}>{model}</span>
    </div>
  );
}

/** The state word in small mono capitals, the dot, then the text line (omitted when empty). */
function State({ status, text }: Pick<Reading, "status"> & { text?: string }) {
  return (
    <div className={s.now}>
      <small className={s.label}>
        <Dot status={status} />
        {STATUS_WORD[status]}
      </small>
      {text && <span className={s.text}>{text}</span>}
    </div>
  );
}

function Dot({ status }: { status: Status }) {
  return <span className={s.dot} data-tone={STATUS_TONE[status]} aria-hidden="true" />;
}

function LastEvent({ at, nowMs }: { at: string | null; nowMs: number }) {
  const mounted = useMounted();
  if (at === null) return <span>No events yet</span>;
  const absolute = utcLabel(at);
  return (
    <span>
      Last event{" "}
      <time dateTime={at} title={absolute}>
        {mounted ? relativeTime(at, nowMs) : absolute}
      </time>
    </span>
  );
}
