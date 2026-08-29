// DSHOME wrapper probe: EXACTLY replicate desktop-cli.js semantics
// (runDesktopDshCli + packaged dsh bin) but keep AggregateError children.
import { runDesktopDshCli } from "file:///E:/DSH/app.src/lib/desktop-cli.js";

// Faithful to dsh.cmd: default profile, run-as-node marker, home.
process.env.DSH_DESKTOP_DEFAULT_PROFILE = "desktop";
process.env.ELECTRON_RUN_AS_NODE = "1";
process.env.DSH_HOME = "C:\\Users\\kuro\\.dsh";

function walk(error, depth = 0) {
  const pad = "  ".repeat(depth);
  console.log(`${pad}[${error?.constructor?.name ?? "?"}] ${error?.message ?? String(error)}`);
  if (error && Array.isArray(error.errors) && error.errors.length) {
    for (const child of error.errors) walk(child, depth + 1);
  } else if (error && error.cause) {
    walk(error.cause, depth + 1);
  }
}

try {
  await runDesktopDshCli(
    process.env,
    (url) => import(url),
    ["node", "wrapper.mjs", "--profile", "dshome", "--no-open", "--port", "3081"],
  );
  console.log("WRAPPER: booted; server should be up on 3081");
  await new Promise(() => {});
} catch (error) {
  console.log("WRAPPER CAUGHT:");
  walk(error, 0);
  process.exitCode = 1;
}