import { HEIGHT, WIDTH } from "./scene";
import type { EventKind, Point, Pose, Role } from "./scene";
// Authored on the native pixel grid. These are scene layers, not a resized concept image.
const C = { navy: "#1b2340", edge: "#49372e", wood: "#a56b3c", honey: "#ce995a", light: "#e3b875", seam: "#b7824d", sage: "#8b9674", wall: "#afb18a", green: "#536f57", leaf: "#739866", darkLeaf: "#38574a", cream: "#eee4c7", shade: "#c5bea4", ink: "#293d47", teal: "#67baa6", amber: "#e4ad55", paper: "#f8edcf", sky: "#706d91", dusk: "#bc8c91", red: "#df8b79" };
export function drawOffice(ctx: CanvasRenderingContext2D, pose: Pose, kind: EventKind, frame: number, selected: Role) {
  ctx.imageSmoothingEnabled = false;
  const r = (x: number, y: number, w: number, h: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
  r(0, 0, WIDTH, HEIGHT, C.navy);
  r(20, 20, 280, 216, C.edge);
  r(24, 24, 272, 208, C.wood);
  r(28, 64, 264, 164, C.honey);
  for (let y = 64; y < 224; y += 16) {
    r(28, y, 264, 1, C.seam);
    for (let x = 28 + ((y / 16) % 2 ? 24 : 0); x < 292; x += 48) r(x, y, 1, 16, C.seam);
  }
  r(28, 28, 264, 34, C.wall); r(28, 56, 264, 8, C.wood); r(28, 61, 264, 3, C.edge);
  r(28, 28, 264, 3, C.sage); r(24, 24, 4, 208, C.edge); r(292, 24, 4, 208, C.edge);
  r(24, 228, 112, 4, C.edge); r(184, 228, 112, 4, C.edge);
  for (const x of [48, 220]) {
    r(x, 33, 48, 24, C.edge); r(x + 3, 36, 42, 18, C.sky); r(x + 3, 46, 42, 8, C.dusk);
    for (const tx of [x + 8, x + 29]) { r(tx + 3, 40, 3, 14, C.navy); r(tx, 44, 9, 3, C.navy); r(tx - 3, 49, 15, 5, C.navy); }
    r(x + 23, 36, 2, 18, C.wood); r(x, 56, 48, 3, C.honey);
  }
  const plant = (x: number, y: number) => {
    r(x + 2, y + 9, 10, 8, C.wood); r(x, y + 8, 14, 3, C.light);
    r(x + 5, y - 3, 4, 12, C.darkLeaf); r(x, y, 5, 5, C.leaf); r(x + 8, y - 1, 6, 5, C.leaf); r(x + 2, y - 6, 4, 7, C.green);
  };
  plant(31, 60); plant(274, 194);
  r(145, 48, 30, 39, C.edge); r(148, 50, 24, 35, C.green); r(149, 53, 22, 2, C.sage);
  for (const y of [58, 72]) { r(150, y, 20, 11, C.sage); r(156, y + 4, 8, 2, C.cream); }
  plant(153, 36);
  const desk = (x: number, qa: boolean) => {
    r(x + 3, 81, 5, 7, C.edge); r(x + 68, 81, 5, 7, C.edge);
    r(x, 62, 76, 22, C.edge); r(x + 2, 63, 72, 17, C.wood); r(x + 2, 63, 72, 2, C.light);
    r(x + 21, 56, 30, 20, C.ink); r(x + 23, 58, 26, 14, C.navy); r(x + 32, 76, 8, 2, C.edge);
    r(x + 29, 79, 16, 3, C.shade);
    const work = (qa ? kind === "qa_reviewing" : kind === "coding");
    for (let row = 0; row < 3; row++) { r(x + 26, 61 + row * 3, row === 1 ? 12 : 18, 1, qa ? C.amber : C.teal); if (work && frame % 2) r(x + 44, 68, 2, 2, C.cream); }
    r(x + 58, 69, 5, 7, C.cream); r(x + 63, 71, 2, 3, C.light);
  };
  desk(42, false); desk(202, true);
  r(30, 176, 24, 40, C.edge); r(33, 179, 18, 34, C.wood);
  for (const y of [180, 196]) { [C.sage, C.cream, C.teal, C.amber].forEach((color, i) => r(35 + i * 4, y, 3, 11, color)); r(32, y + 12, 20, 3, C.edge); }
  r(104, 108, 17, 9, C.edge); r(106, 109, 13, 5, C.sage); r(103, 116, 19, 3, C.wood);
  r(137, 225, 46, 10, C.edge); r(140, 225, 40, 8, C.green);
  r(143, 225, 8, 8, C.sage); r(159, 225, 8, 8, C.sage); r(175, 225, 5, 8, C.sage);
  const papers = (x: number, y: number) => { r(x, y + 2, 10, 7, C.edge); r(x, y, 10, 7, C.paper); r(x + 2, y + 2, 6, 1, C.shade); r(x + 2, y + 4, 4, 1, C.shade); };
  if (!pose.carrying && !pose.filed) {
    const p = pose.paper === "developer" ? { x: 46, y: 70 } : pose.paper === "qa" ? { x: 204, y: 70 } : pose.paper === "inbox" ? { x: 107, y: 108 } : { x: 155, y: 71 };
    papers(p.x, p.y);
  }
  if (pose.filed) { r(156, 75, 8, 3, C.paper); r(151, 82, 3, 1, C.light); }
  const robot = (point: Point, role: Role) => {
    const x = point.x - 8; const y = point.y - 24; const accent = role === "developer" ? C.teal : C.amber;
    const moving = pose.walking === role; const step = moving ? frame % 2 : 0;
    r(x - 1, y + 22, 18, 3, C.seam);
    if (selected === role) { r(x - 3, y + 25, 22, 1, accent); r(x - 3, y + 23, 1, 2, accent); r(x + 18, y + 23, 1, 2, accent); }
    r(x + 4, y + 21 - step, 3, 4, C.ink); r(x + 10, y + 20 + step, 3, 4, C.ink);
    r(x + 2, y + 13, 12, 9, C.ink); r(x + 3, y + 13, 10, 7, C.shade); r(x + 5, y + 14, 6, 4, C.cream);
    r(x, y + 13 + step, 3, 6, accent); r(x + 14, y + 13 - step, 3, 6, accent);
    const headX = role === "qa" ? x : x + 1; const headW = role === "qa" ? 17 : 15;
    r(headX, y + 2, headW, 12, C.ink); r(headX + 1, y + 1, headW - 2, 12, C.cream); r(headX + 2, y + 4, headW - 4, 7, C.ink);
    r(x + 5, y + 6, 2, 3, accent); r(x + 11, y + 6, 2, 3, accent);
    r(x + 8, y - 2, 1, 4, C.ink); r(x + 7, y - 3, 3, 2, accent);
    if (pose.carrying === role) papers(x + 10, y + 14);
    if (kind === "coding" && role === "developer" && !moving) r(x + 3 + (frame % 2) * 7, y + 15, 4, 2, accent);
    if ((kind === "failed" && role === "developer") || (kind === "tests_failed" && role === "qa")) { r(x + 5, y - 10, 7, 6, C.red); r(x + 8, y - 9, 1, 3, C.ink); r(x + 8, y - 5, 1, 1, C.ink); }
    if (kind === "waiting_on_owner" && role === "developer") { r(x + 4, y - 11, 9, 7, C.amber); r(x + 8, y - 10, 1, 3, C.ink); r(x + 8, y - 7, 3, 1, C.ink); }
  };
  const roles: Role[] = ["developer", "qa"];
  roles.sort((a, b) => pose[a].y - pose[b].y).forEach((role) => robot(pose[role], role));
}
