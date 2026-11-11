// Public: the agent office on the Paper frame. Board tab: one card per worker type and a filterable log,
// from the public office feed. Room tab: the existing connected room. Reads only the public feed API.
import type { Metadata } from "next";
import { rosarivo } from "../_site/fonts";
import { PaperFrame } from "../_site/paper-frame";
import { OfficeBoard } from "./board/office-board";

export const metadata: Metadata = { title: "Agent office | Kentcrosswise" };

export default function OfficePage() {
  return (
    <PaperFrame current="/office">
      <OfficeBoard roomFontClass={rosarivo.variable} />
    </PaperFrame>
  );
}
