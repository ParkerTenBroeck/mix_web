const build = () => new Deno.Command(Deno.execPath(), {
  args: ["task", "build"], stdout: "inherit", stderr: "inherit",
}).output();

await build();
new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-read", "jsr:@std/http/file-server", "dist"],
  stdout: "inherit", stderr: "inherit",
}).spawn();

const watchPaths = ["root", "tools", "../web_lib/src", "../../mix/src"];
const existingWatchPaths: string[] = [];
for (const path of watchPaths) {
  try {
    await Deno.stat(path);
    existingWatchPaths.push(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

const watcher = Deno.watchFs(existingWatchPaths);
for await (const event of watcher) {
  if (["modify", "create", "remove"].includes(event.kind)) await build();
}
