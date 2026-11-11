"use client";
// /office body: the heading, the Board | Room tablist, and the two tab panels. Only the selected panel is
// rendered, so the board poller and the room poller never run together. The selected tab is not in the URL.
import { useRef, useState, type KeyboardEvent } from "react";
import { BoardPanel } from "./board-panel";
import { RoomPanel } from "./room-panel";
import s from "./board.module.css";

type Tab = "board" | "room";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "room", label: "Room" },
];

export function OfficeBoard({ roomFontClass }: { roomFontClass: string }) {
  const [tab, setTab] = useState<Tab>("board");
  const buttons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length]!;
    setTab(next.id);
    buttons.current[next.id]?.focus();
  };

  return (
    <>
      <div className={s.head}>
        <div className={s.intro}>
          <h1 className={s.title}>Agent office</h1>
          <p className={s.lede}>Five agents build Kentcrosswise. Each card shows what that agent is doing now, from the public office feed.</p>
        </div>
        <div className={s.seg} role="tablist" aria-label="Office view">
          {TABS.map((option, index) => (
            <button
              key={option.id}
              ref={(element) => {
                buttons.current[option.id] = element;
              }}
              type="button"
              role="tab"
              id={`office-tab-${option.id}`}
              aria-selected={tab === option.id}
              aria-controls={`office-panel-${option.id}`}
              tabIndex={tab === option.id ? 0 : -1}
              className={s.segTab}
              onClick={() => setTab(option.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id="office-panel-board" aria-labelledby="office-tab-board" hidden={tab !== "board"}>
        {tab === "board" && <BoardPanel />}
      </div>
      <div role="tabpanel" id="office-panel-room" aria-labelledby="office-tab-room" hidden={tab !== "room"}>
        {tab === "room" && <RoomPanel fontClass={roomFontClass} />}
      </div>
    </>
  );
}
