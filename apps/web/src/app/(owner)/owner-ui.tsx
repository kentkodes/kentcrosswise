// Owner console building blocks that need no frame: regions, status dots and notice lines.
import type { ReactNode } from "react";
import s from "./owner.module.css";
import type { Tone } from "./tones";

/** A bordered region with an optional title bar. Lists and tables go in the body. */
export function Region({
  id,
  title,
  level = 2,
  aside,
  testId,
  children,
}: {
  id?: string;
  title?: ReactNode;
  level?: 2 | 3;
  aside?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={title && id ? id : undefined} className={s.region} data-testid={testId}>
      {title ? (
        <div className={s.bar}>
          <Heading id={id} className={s.heading}>
            {title}
          </Heading>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={s.dot} data-tone={tone} aria-hidden="true" />;
}

/**
 * A notice line, not a banner: muted text with a dot. role="status" uses the ok dot, role="alert" the warn dot.
 * Without a role it is a plain muted warn line.
 */
export function Notice({
  role,
  tone,
  testId,
  children,
}: {
  role?: "status" | "alert";
  tone: Tone;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <p role={role} className={s.notice} data-testid={testId}>
      <Dot tone={tone} />
      <span>{children}</span>
    </p>
  );
}
