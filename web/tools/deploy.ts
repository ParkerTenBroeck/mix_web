const WEB = new URL("../", import.meta.url);
const DIST = new URL("../dist/", import.meta.url);

function option(name: string, fallback: string) {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] ?? fallback : fallback;
}

const remote = option("--remote", "origin");
const branch = option("--branch", "gh-pages");
const skipBuild = Deno.args.includes("--no-build");

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string | URL; allowFailure?: boolean } = {},
) {
  const result = await new Deno.Command(executable, {
    args,
    cwd: options.cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success && !options.allowFailure) {
    throw new Error(`${executable} ${args.join(" ")} exited with status ${result.code}`);
  }
  return result.success;
}

async function output(executable: string, args: string[], cwd?: string | URL) {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(`${executable} ${args.join(" ")} exited with status ${result.code}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function copyDirectory(source: URL, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = new URL(entry.name + (entry.isDirectory ? "/" : ""), source);
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) await copyDirectory(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

if (!skipBuild) {
  console.log("Building the production site…");
  await command(Deno.execPath(), ["task", "build"], { cwd: WEB });
}

try {
  await Deno.stat(new URL("index.html", DIST));
} catch {
  throw new Error("web/dist is missing; run without --no-build or build the site first");
}

const repositoryRoot = await output("git", ["rev-parse", "--show-toplevel"], WEB);
const remoteUrl = await output("git", ["remote", "get-url", remote], repositoryRoot);
const staging = await Deno.makeTempDir({ prefix: "mix-pages-" });

try {
  console.log(`Preparing ${remote}/${branch}…`);
  const branchExists = await command(
    "git",
    ["clone", "--depth", "1", "--branch", branch, remoteUrl, staging],
    { allowFailure: true },
  );
  if (!branchExists) {
    await command("git", ["init"], { cwd: staging });
    await command("git", ["remote", "add", remote, remoteUrl], { cwd: staging });
    await command("git", ["switch", "--orphan", branch], { cwd: staging });
  }
  const stagingRemote = branchExists ? "origin" : remote;

  for await (const entry of Deno.readDir(staging)) {
    if (entry.name !== ".git") {
      await Deno.remove(`${staging}/${entry.name}`, { recursive: true });
    }
  }
  await copyDirectory(DIST, staging);
  await Deno.writeTextFile(`${staging}/.nojekyll`, "");

  await command("git", ["add", "--all"], { cwd: staging });
  const changed = !(await command("git", ["diff", "--cached", "--quiet"], {
    cwd: staging,
    allowFailure: true,
  }));
  if (!changed) {
    console.log("GitHub Pages is already up to date.");
  } else {
    await command("git", ["commit", "-m", "Deploy GitHub Pages"], { cwd: staging });
    await command("git", ["push", "--set-upstream", stagingRemote, `HEAD:${branch}`], {
      cwd: staging,
    });
    console.log(`Deployed web/dist to ${remote}/${branch}.`);
  }
} finally {
  await Deno.remove(staging, { recursive: true }).catch(() => {});
}
