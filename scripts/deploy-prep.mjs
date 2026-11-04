// CI helper, run by .github/workflows/deploy.yml before `wrangler deploy`:
//  1. Finds the "jarvis" D1 database (creating it on the first run) and writes its id into wrangler.jsonc.
//  2. On the very first deploy, uploads a placeholder "jarvis" Worker (see scripts/bootstrap/) so the
//     real deploy doesn't fail with "No access to the specified resource".
//  3. Writes the secrets that are set in GitHub to a temp JSON file for `wrangler secret bulk`.
//     (Missing required secrets stop the run first, before anything is created.)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DB_NAME = "jarvis";
const WORKER_NAME = "jarvis";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const SECRETS = ["ANTHROPIC_API_KEY", "APP_PASSWORD", "SECRET_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const WORKER_NOT_FOUND = [10007, 10090]; // same codes wrangler treats as "Worker not found"

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// --- 0. Required secrets (checked first, before touching Cloudflare) -------------------
const missing = ["ANTHROPIC_API_KEY", "APP_PASSWORD", "SECRET_KEY"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `::error::Missing GitHub secrets: ${missing.join(", ")}. Add them in GitHub → Settings → Secrets and variables → Actions ` +
      "(names must match exactly), then run the workflow again.",
  );
  process.exit(1);
}

// --- 1. D1 database ---------------------------------------------------------------
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

// --- 2. First-deploy placeholder Worker ----------------------------------------------
async function workerExists() {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/services/${WORKER_NAME}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return true;
  const body = await res.json().catch(() => ({}));
  if (body.errors?.some((e) => WORKER_NOT_FOUND.includes(e.code))) return false;
  throw new Error(
    `Couldn't check whether the "${WORKER_NAME}" Worker exists (HTTP ${res.status}): ${JSON.stringify(body.errors ?? body)}. ` +
      "Check that CLOUDFLARE_API_TOKEN has Account → Workers Scripts → Edit for this account.",
  );
}

if (await workerExists()) {
  console.log(`Worker "${WORKER_NAME}" already exists.`);
} else {
  console.log(`First deploy: uploading a placeholder "${WORKER_NAME}" Worker...`);
  wrangler("deploy", "--config", "scripts/bootstrap/wrangler.jsonc");
  console.log("Placeholder uploaded; the real Worker replaces it in the next step.");
}

// --- 3. Secrets file -------------------------------------------------------------------
const secrets = Object.fromEntries(SECRETS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
writeFileSync(process.env.SECRETS_FILE, JSON.stringify(secrets));
console.log(`Secrets to upload: ${Object.keys(secrets).join(", ") || "(none)"}`);
