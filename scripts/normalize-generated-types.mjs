/**
 * Post-processes the openapi-typescript output.
 *
 * `InitialHistoryItem`, `ConversationMessage` and `SessionEventsRequest` carry a
 * root-level `anyOf` in the contract that only expresses "at least one of these
 * properties is required". openapi-typescript renders every such constraint-only
 * branch as `unknown`, and TypeScript then collapses `{ … } | unknown` to plain
 * `unknown`, which erases the schema. The constraint is not expressible in
 * TypeScript anyway, so drop the `unknown` branches and keep the object shape.
 *
 * Deterministic and idempotent: CI regenerates and diffs the committed file.
 */
import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../typescript/src/generated/openapi.d.ts", import.meta.url);
const source = await readFile(target, "utf8");
const normalized = source.replace(/\}(?: \| unknown)+;/g, "};");

const removed = (source.match(/ \| unknown/g) ?? []).length;
if (normalized !== source) {
  await writeFile(target, normalized);
}
console.log(`normalize-generated-types: dropped ${removed} constraint-only \`unknown\` branch(es)`);
