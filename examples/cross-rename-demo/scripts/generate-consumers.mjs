import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "consumers");
await mkdir(outDir, { recursive: true });

const count = 11;
for (let i = 1; i <= count; i++) {
  const n = String(i).padStart(2, "0");
  const relImport = "../services/user";
  const body = `import { authenticate } from "${relImport}";

export function runConsumer${n}(): boolean {
  return authenticate("demo-${n}");
}
`;
  await writeFile(join(outDir, `consumer_${n}.ts`), body, "utf8");
}

console.log(`Wrote ${count} consumers under src/consumers/`);
