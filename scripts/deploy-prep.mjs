// CI helper, run by .github/workflows/deploy.yml before `wrangler deploy`:
//  1. Finds the "jarvis" D1 database (creating it on the first run) and writes its id into wrangler.jsonc.
//  2. Writes the secrets that are set in GitHub to a temp JSON file for `wrangler deploy --secrets-file`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DB_NAME = "jarvis";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const SECRETS = ["ANTHROPIC_API_KEY", "APP_PASSWORD", "SECRET_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const findDb = () => JSON.parse(wrangler("d1", "list", "--json")).find((d) => d.name === DB_NAME);

let db = findDb();
if (!db) {
  console.log(`Creating D1 database "${DB_NAME}"...`);
  wrangler("d1", "create", DB_NAME);
  db = findDb();
}
const id = db?.uuid ?? db?.id;
if (!id) throw new Error(`Could not find the id of D1 database "${DB_NAME}"`);
const cfg = readFileSync("wrangler.jsonc", "utf8");
writeFileSync("wrangler.jsonc", cfg.replace(PLACEHOLDER, id));
console.log(`Using D1 database ${DB_NAME} (${id})`);

const missing = ["ANTHROPIC_API_KEY", "APP_PASSWORD", "SECRET_KEY"].filter((k) => !process.env[k]);
if (missing.length) console.warn(`::warning::Missing GitHub secrets: ${missing.join(", ")}. Jarvis won't work until they're set.`);
const secrets = Object.fromEntries(SECRETS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
writeFileSync(process.env.SECRETS_FILE, JSON.stringify(secrets));
console.log(`Uploading secrets: ${Object.keys(secrets).join(", ") || "(none)"}`);
