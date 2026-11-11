// The Room tab: the existing connected room. The room draws its own card, so this wrapper adds no frame.
import { ConnectedOffice } from "../connected/connected-office";
import s from "./room-panel.module.css";

export function RoomPanel() {
  return (
    <div className={s.panel}>
      <ConnectedOffice />
    </div>
  );
}
