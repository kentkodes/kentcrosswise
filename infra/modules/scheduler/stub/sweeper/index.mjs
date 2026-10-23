// Placeholder sweeper (P2-17) for a module call without sweeper_package_dir. Does nothing: no
// database, GitHub or queue access. Logs one line so a scheduled run is visible.
export const handler = async () => {
  console.log("sweeper stub: nothing done");
  return { stub: true };
};
