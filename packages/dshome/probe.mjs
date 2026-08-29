// DSHOME boot probe v2: replay the EXACT real CLI boot path —
// environment: loadLayeredEnv('dsh') like dsh/lib/bin.js — with deep
// error detail preserved (the desktop wrapper hides AggregateError children).
import { o as runProfile } from "file:///E:/DSH/app.src/node_modules/@deepseek-ai/dsh/lib/profile-boot-DG5t9aNs.js";
import { loadLayeredEnv } from "file:///E:/DSH/app.src/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";

function walk(error, depth = 0) {
  const pad = "  ".repeat(depth);
  const name = error?.constructor?.name ?? "?";
  const message = error?.message ?? String(error);
  console.log(`${pad}[${name}] ${message}`);
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
  console.log("PROBE: tree mounted; server should be serving on 3081");
  // keep this process alive so the server stays up for verification
  await new Promise(() => {});
} catch (error) {
  console.log("PROBE CAUGHT:");
  walk(error, 0);
  process.exitCode = 1;
}