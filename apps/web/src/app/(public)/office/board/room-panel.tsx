// The Room tab: the existing connected room in a plain card. Its own CSS assumes the navy shell, so the
// scope below sets that ground and the Rosarivo font. The font class comes from the server page, because
// next/font is applied where the page is rendered.
import { ConnectedOffice } from "../connected/connected-office";
import s from "./room-panel.module.css";

export function RoomPanel({ fontClass }: { fontClass: string }) {
  return (
    <div className={s.frame}>
      <div className={`${s.scope} ${fontClass}`}>
        <ConnectedOffice />
      </div>
    </div>
  );
}
