const ROOT = new URL("../root/", import.meta.url);
const DIST = new URL("../dist/", import.meta.url);
const WASM = new URL("../wasm/", import.meta.url);
const WASM_BUILD = new URL("../wasm-build/", import.meta.url);

async function run(command: string[], cwd?: string) {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1), cwd, stdout: "inherit", stderr: "inherit",
  }).output();
  if (!result.success) Deno.exit(result.code);
}

await Deno.remove(DIST, { recursive: true }).catch(() => {});
await Deno.mkdir(DIST, { recursive: true });
await Deno.remove(WASM_BUILD, { recursive: true }).catch(() => {});

console.log("Building mix WebAssembly adapter…");
await run([
  "wasm-pack", "build", "--target", "web", "--release",
  "--out-dir", "../web/wasm-build",
], "../web_lib");
await Deno.remove(WASM, { recursive: true }).catch(() => {});
await Deno.rename(WASM_BUILD, WASM);

console.log("Bundling playground…");
await run([
  Deno.execPath(), "bundle", "--platform=browser", "--outdir", "dist",
  "root/index.html", "--minify",
]);
await Deno.copyFile(new URL("style.css", ROOT), new URL("style.css", DIST));
await Deno.copyFile(new URL("mix_playground_web_bg.wasm", WASM), new URL("mix_playground_web_bg.wasm", DIST));

console.log("Built web/dist");
