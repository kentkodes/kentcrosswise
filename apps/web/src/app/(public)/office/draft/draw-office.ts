import { ANNEX_HEIGHT, HEIGHT, PEOPLE, TASKS, WIDTH, currentBeat, taskStates } from "./scene";
import type { Actor, Kind, Point, Scene, TaskKey } from "./scene";

export interface OfficeRender {
  beat: { actor: Actor; kind: Kind | "queued" };
  packets: { position: Point; failed?: boolean }[];
  actors: Actor[]; working: Actor[];
  statuses: Partial<Record<Actor, "failed" | "paused">>;
  filed: number; waiting: boolean; deployed: boolean;
}
// Same native-grid material vocabulary as the accepted two-robot woodland room.
const C = { navy: "#1b2340", edge: "#49372e", wood: "#a56b3c", honey: "#ce995a", light: "#e3b875", seam: "#b7824d", sage: "#8b9674", wall: "#afb18a", green: "#536f57", leaf: "#739866", darkLeaf: "#38574a", cream: "#eee4c7", shade: "#c5bea4", ink: "#293d47", paper: "#f8edcf", sky: "#706d91", dusk: "#bc8c91", red: "#df8b79", teal: "#67baa6", amber: "#e4ad55" };
export function drawOffice(ctx: CanvasRenderingContext2D, scene: Scene, selected: Actor | null, annex = false, model?: OfficeRender) {
  ctx.imageSmoothingEnabled = false;
  const offset = annex ? HEIGHT : 0;
  const r = (x: number, y: number, w: number, h: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y - offset), w, h); };
  const height = annex ? ANNEX_HEIGHT : HEIGHT;
  const top = annex ? HEIGHT : 0;
  r(0, top, WIDTH, height, C.navy);
  r(18, top + 12, 348, height - 24, C.edge);
  r(22, top + 16, 340, height - 32, C.wood);
  r(26, top + (annex ? 20 : 56), 332, height - (annex ? 40 : 76), C.honey);
  for (let y = top + (annex ? 20 : 56); y < top + height - 20; y += 16) {
    r(26, y, 332, 1, C.seam);
    for (let x = 26 + (y % 32 ? 24 : 0); x < 355; x += 48) r(x, y, 1, Math.min(16, top + height - 20 - y), C.seam);
  }
  const plant = (x: number, y: number) => {
    r(x + 2, y + 9, 10, 8, C.wood); r(x, y + 8, 14, 3, C.light);
    r(x + 5, y - 3, 4, 12, C.darkLeaf); r(x, y, 5, 5, C.leaf); r(x + 8, y - 1, 6, 5, C.leaf); r(x + 2, y - 6, 4, 7, C.green);
  };
  const paper = (x: number, y: number, accent = C.shade) => {
    r(x, y + 2, 10, 8, C.edge); r(x, y, 10, 8, C.paper); r(x + 2, y + 2, 6, 1, accent); r(x + 2, y + 5, 4, 1, C.shade);
  };
  const desk = (x: number, y: number, width: number, accent: string, screen = true) => {
    r(x + 2, y + 17, 4, 7, C.edge); r(x + width - 6, y + 17, 4, 7, C.edge);
    r(x, y, width, 19, C.edge); r(x + 2, y + 1, width - 4, 15, C.wood); r(x + 2, y + 1, width - 4, 2, C.light);
    if (screen) {
      r(x + width / 2 - 12, y - 9, 24, 18, C.ink); r(x + width / 2 - 10, y - 7, 20, 12, C.navy);
      for (let row = 0; row < 3; row++) r(x + width / 2 - 7, y - 4 + row * 3, row === 1 ? 9 : 14, 1, accent);
      r(x + width / 2 - 7, y + 12, 14, 2, C.shade);
    }
  };
  const beat = model?.beat ?? currentBeat(scene.index);
  const tasks = taskStates(scene);
  const pickupPending = beat.actor === "qa" && ["tests_failed", "changes_requested", "merged"].includes(beat.kind) && scene.paths.qa.some((point) => point.x === 312 && point.y === 178);
  if (!annex) {
    r(26, 26, 332, 30, C.wall); r(26, 26, 332, 3, C.sage); r(26, 53, 332, 4, C.edge);
    for (const x of [44, 278]) {
      r(x, 32, 62, 23, C.edge); r(x + 3, 35, 56, 17, C.sky); r(x + 3, 44, 56, 8, C.dusk);
      for (const tree of [x + 9, x + 40]) { r(tree + 3, 38, 3, 14, C.navy); r(tree, 42, 9, 3, C.navy); r(tree - 3, 47, 15, 5, C.navy); }
      r(x + 30, 35, 2, 17, C.wood); r(x, 54, 62, 3, C.light);
    }
    // Boss board, personal desk and a human-marked approval tray.
    r(142, 31, 96, 29, C.edge); r(145, 34, 90, 23, C.green);
    for (const [x, y] of [[150, 38], [178, 38], [206, 38], [150, 49], [178, 49]]) paper(x!, y!);
    desk(176, 67, 48, PEOPLE.boss.color);
    r(236, 70, 30, 19, C.edge); r(238, 72, 26, 13, C.sage);
    r(247, 73, 5, 5, C.cream); r(245, 79, 9, 5, C.cream);
    if ((model ? model.waiting : tasks.approval.kind === "waiting")) paper(257, 76, C.amber);
    // Source shelves and desk, then the shared four-seat Developer bench.
    r(30, 64, 45, 25, C.edge);
    for (let shelf = 0; shelf < 2; shelf++) for (let i = 0; i < 7; i++) r(33 + i * 6, 67 + shelf * 11, 4, 8, [C.sage, C.cream, C.teal][i % 3]!);
    desk(32, 89, 40, PEOPLE.scraper.color, false); paper(40, 92);
    r(82, 128, 192, 23, C.edge); r(84, 129, 188, 18, C.wood); r(84, 129, 188, 2, C.light);
    for (const x of [88, 136, 184, 232]) desk(x, 128, 36, C.teal);
    desk(308, 128, 44, C.amber);
    // CI is a machine: stacked drives, activity lamps and a separate status glyph.
    r(287, 70, 46, 42, C.ink); r(290, 73, 40, 36, C.sage);
    for (let row = 0; row < 3; row++) { r(294, 77 + row * 10, 32, 7, C.ink); r(298, 79 + row * 10, 15, 1, C.shade); r(320, 79 + row * 10, 3, 3, beat.kind === "ci_running" && Math.floor(scene.elapsed / 180) % 3 === row ? C.amber : C.teal); }
    if (beat.kind === "tests_failed") { r(338, 81, 7, 12, C.red); r(341, 83, 1, 5, C.ink); r(341, 90, 1, 1, C.ink); }
    if (beat.kind === "ci_passed") { r(339, 88, 2, 4, C.teal); r(341, 90, 2, 2, C.teal); r(343, 85, 2, 5, C.teal); }
    // Intake, archive, Docs desk and separate deployment lift at the perimeter.
    desk(32, 231, 44, PEOPLE.router.color, false);
    paper(38, 233); paper(53, 234); r(35, 221, 33, 7, C.sage);
    desk(284, 231, 40, PEOPLE.docs.color); paper(287, 234, PEOPLE.docs.color);
    r(251, 228, 24, 42, C.edge); r(254, 231, 18, 36, C.sage);
    for (let i = 0; i < 3; i++) { r(255, 234 + i * 11, 16, 9, C.green); r(261, 237 + i * 11, 5, 2, C.cream); }
    const filed = model?.filed ?? Object.values(tasks).filter((task) => task.filed).length;
    for (let i = 0; i < filed; i++) paper(256 + i * 3, 228 - i * 2);
    r(334, 224, 18, 44, C.edge); r(337, 227, 12, 37, C.ink);
    const lift = beat.kind === "deployed" ? Math.max(231, 254 - Math.floor(scene.elapsed / 60)) : (model ? model.deployed : tasks.health.kind === "deployed") ? 231 : 254;
    r(336, lift + 7, 14, 3, C.sage); r(339, lift, 9, 7, C.light); r(343, lift, 1, 7, C.wood);
    if ((model ? model.deployed : tasks.health.kind === "deployed") && scene.settled) { r(339, 217, 2, 4, C.teal); r(341, 219, 2, 2, C.teal); r(343, 214, 2, 5, C.teal); }
    plant(29, 173); plant(341, 182); plant(112, 59); plant(85, 245);
    r(125, 282, 61, 7, C.green); r(135, 282, 4, 7, C.sage); r(153, 282, 4, 7, C.sage); r(171, 282, 4, 7, C.sage);
    r(190, 284, 42, 8, C.wood); r(194, 286, 34, 6, C.honey);
    // Small square chairs mark available seats; empty seats never imply extra workers.
    for (const x of [202, 250]) { r(x - 8, 162, 16, 5, C.green); r(x - 6, 167, 12, 3, C.edge); }
  } else {
    r(190, top + 8, 42, 12, C.wood); r(194, top + 8, 34, 12, C.honey);
    desk(127, 337, 54, C.teal); desk(231, 337, 54, C.teal);
    plant(43, 347); plant(319, 347);
    r(252, 366, 16, 5, C.green); r(254, 371, 12, 3, C.edge);
  }
  // Task packets are retained independently. Only a completed merge files a packet.
  if (model) { for (const packet of model.packets) { if (packet.position.y > HEIGHT !== annex) continue; paper(packet.position.x, packet.position.y, packet.failed ? C.red : C.shade); } }
  else for (const key of Object.keys(TASKS) as TaskKey[]) {
    const task = tasks[key];
    if (!task.seen || task.filed) continue;
    const worker = TASKS[key].worker;
    const home = PEOPLE[worker].home;
    let position = { x: home.x + 2, y: home.y - 10 };
    const carried = ("task" in beat && beat.task === key) && ["pr_opened", "changes_requested", "tests_failed", "merged"].includes(beat.kind) && !scene.settled && !pickupPending;
    if (carried) continue;
    if (["pr_opened", "ci_running", "ci_passed", "reviewing", "approved"].includes(task.kind)) position = { x: 314, y: 168 };
    if (("task" in beat && beat.task === key) && pickupPending) position = { x: 314, y: 168 };
    if (task.kind === "waiting") position = { x: 257, y: 76 };
    if (task.kind === "cancelled") position = { x: 267, y: 89 };
    if (position.y > HEIGHT !== annex) continue;
    paper(position.x, position.y, task.kind === "failed" ? C.red : C.shade);
  }
  const actors = model ? [...model.actors] : (Object.keys(PEOPLE) as Actor[]).filter((actor) => actor !== "dev3" && actor !== "dev4" && (actor !== "extra" || tasks.annex.seen));
  actors.sort((a, b) => scene.positions[a].y - scene.positions[b].y).forEach((actor) => {
    const point = scene.positions[actor];
    if (point.y > HEIGHT !== annex) return;
    const x = point.x - 8; const y = point.y - 24; const accent = PEOPLE[actor].color;
    const moving = scene.paths[actor].some((target) => target.x !== point.x || target.y !== point.y);
    const step = moving ? Math.floor(scene.elapsed / 120) % 2 : 0;
    r(x - 1, y + 22, 18, 3, C.seam);
    if (selected === actor) { r(x - 3, y + 25, 22, 1, accent); r(x - 3, y + 23, 1, 2, accent); r(x + 18, y + 23, 1, 2, accent); }
    r(x + 4, y + 21 - step, 3, 4, C.ink); r(x + 10, y + 20 + step, 3, 4, C.ink);
    r(x + 2, y + 13, 12, 9, C.ink); r(x + 3, y + 13, 10, 7, C.shade); r(x + 5, y + 14, 6, 4, C.cream);
    r(x, y + 13 + step, 3, 6, accent); r(x + 14, y + 13 - step, 3, 6, accent);
    r(x + 1, y + 2, 15, 12, C.ink); r(x + 2, y + 1, 13, 12, C.cream); r(x + 3, y + 4, 11, 7, C.ink);
    r(x + 5, y + 6, 2, 3, accent); r(x + 11, y + 6, 2, 3, accent);
    r(x + 8, y - 2, 1, 4, C.ink); r(x + 7, y - 3, 3, 2, accent);
    if (actor === "boss") { r(x - 1, y - 1, 19, 3, accent); r(x + 3, y - 4, 11, 3, accent); }
    if (actor === "qa") { r(x + 3, y + 4, 11, 7, C.amber); r(x + 5, y + 5, 7, 5, C.ink); r(x + 8, y + 6, 2, 3, C.cream); }
    if (actor === "scraper") { r(x - 3, y + 12, 7, 8, C.green); r(x - 2, y + 13, 5, 5, C.cream); }
    if (actor === "docs") { r(x + 5, y + 13, 7, 6, PEOPLE.docs.color); r(x + 6, y + 14, 4, 1, C.paper); }
    if (actor === "router") { r(x + 4, y + 14, 9, 5, C.cream); r(x + 6, y + 15, 5, 1, C.wood); }
    if (actor.startsWith("dev") || actor === "extra") { r(x + 3, y + 19, 10, 2, accent); r(x + 5 + (actor === "dev2" ? 4 : 0), y + 19, 2, 3, C.wood); }
    const working = model ? model.working.includes(actor) : (Object.keys(TASKS) as TaskKey[]).some((key) => TASKS[key].worker === actor && tasks[key].kind === "coding");
    if (working && !moving) r(x + 3 + Math.floor(scene.elapsed / 180) % 2 * 7, y + 15, 4, 2, accent);
    if (!model && beat.actor === actor && ["pr_opened", "changes_requested", "tests_failed", "merged"].includes(beat.kind) && !scene.settled && !pickupPending) paper(x + 10, y + 14, accent);
    const task = (Object.keys(TASKS) as TaskKey[]).find((key) => TASKS[key].worker === actor && tasks[key].seen);
    if (model ? model.statuses[actor] === "failed" : task && tasks[task].kind === "failed") { r(x + 6, y - 12, 5, 7, C.red); r(x + 8, y - 11, 1, 3, C.ink); r(x + 8, y - 7, 1, 1, C.ink); }
    if (model ? model.statuses[actor] === "paused" : task && tasks[task].kind === "paused") { r(x + 5, y - 10, 2, 6, accent); r(x + 10, y - 10, 2, 6, accent); }
  });
}
