const ROOT = new URL("../root/", import.meta.url);
const DIST = new URL("../dist/", import.meta.url);
const WASM = new URL("../wasm/", import.meta.url);

async function run(command: string[], cwd?: string) {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1), cwd, stdout: "inherit", stderr: "inherit",
  }).output();
  if (!result.success) Deno.exit(result.code);
}

await Deno.remove(DIST, { recursive: true }).catch(() => {});
await Deno.mkdir(DIST, { recursive: true });

console.log("Building mix WebAssembly adapter…");
await run([
  "wasm-pack", "build", "--target", "web", "--release",
  "--out-dir", "../web/wasm",
], "../web_lib");

console.log("Bundling playground…");
await run([
  Deno.execPath(), "bundle", "--platform=browser", "--outdir", "dist",
  "root/index.html", "--minify",
]);
await Deno.copyFile(new URL("style.css", ROOT), new URL("style.css", DIST));
await Deno.copyFile(new URL("mix_playground_web_bg.wasm", WASM), new URL("mix_playground_web_bg.wasm", DIST));

console.log("Built web/dist");
