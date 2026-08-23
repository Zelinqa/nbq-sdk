import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;

async function replaceVersion(path, pattern, replacement) {
  const source = await readFile(path, "utf8");
  if (!pattern.test(source)) {
    throw new Error(`Could not find the version in ${path.pathname}`);
  }
  await writeFile(path, source.replace(pattern, replacement(version)));
}

await replaceVersion(
  new URL("../pyproject.toml", import.meta.url),
  /^version = "[^"]+"$/m,
  (value) => `version = "${value}"`,
);
await replaceVersion(
  new URL("../python/src/nbq/_version.py", import.meta.url),
  /^__version__ = "[^"]+"$/m,
  (value) => `__version__ = "${value}"`,
);
await replaceVersion(
  new URL("../typescript/src/version.ts", import.meta.url),
  /^export const VERSION = "[^"]+";$/m,
  (value) => `export const VERSION = "${value}";`,
);

console.log(`Synced Python and TypeScript versions to ${version}`);
