import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const pyproject = await readFile(new URL("../pyproject.toml", import.meta.url), "utf8");
const pythonVersion = await readFile(
  new URL("../python/src/nbq/_version.py", import.meta.url),
  "utf8",
);
const typescriptVersion = await readFile(
  new URL("../typescript/src/version.ts", import.meta.url),
  "utf8",
);

const versions = {
  packageJson: packageJson.version,
  pyproject: pyproject.match(/^version = "([^"]+)"$/m)?.[1],
  python: pythonVersion.match(/^__version__ = "([^"]+)"$/m)?.[1],
  typescript: typescriptVersion.match(/^export const VERSION = "([^"]+)";/m)?.[1],
};

const uniqueVersions = new Set(Object.values(versions));
if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
  console.error("SDK versions are out of sync:", versions);
  process.exit(1);
}

console.log(`All SDK versions match: ${packageJson.version}`);
