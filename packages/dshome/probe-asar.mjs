// DSHOME probe-asar: same probe, but import the loader chunks from the REAL
// packed app.asar (Electron's fs patch reads asar; plain node cannot).
// Isolates: is the dsh.cmd failure caused by loading from inside the asar?
import { o as runProfile } from "file:///D:/DSH/DSH%20Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/profile-boot-DG5t9aNs.js";
import { loadLayeredEnv } from "file:///D:/DSH/DSH%20Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";

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
  const { ctx } = await runProfile({
    environment: loadLayeredEnv("dsh"),
    profile: "dshome",
    patchFiles: [],
    args: ["--no-open", "--port", "3081"],
  });
  console.log("ASAR-PROBE: tree mounted from inside app.asar; serving on 3081");
  await new Promise(() => {});
} catch (error) {
  console.log("ASAR-PROBE CAUGHT:");
  walk(error, 0);
  process.exitCode = 1;
}