import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAX_INPUT_BYTES = 4096;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const WRANGLER_PATH = path.join(PROJECT_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const CONFIG_PATH = path.join(PROJECT_ROOT, "wrangler.jsonc");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Credential input must be a JSON object.");
  }

  const alchemyKey = input.alchemyKey;
  const onfinalityEndpoint = input.onfinalityEndpoint;
  if (typeof alchemyKey !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(alchemyKey)) {
    throw new Error("Alchemy credential format did not validate.");
  }
  if (typeof onfinalityEndpoint !== "string" || onfinalityEndpoint.length > 2048 || /\s/.test(onfinalityEndpoint)) {
    throw new Error("OnFinality endpoint format did not validate.");
  }

  const endpoint = new URL(onfinalityEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "base.api.onfinality.io" ||
    endpoint.port !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname === "/public"
  ) {
    throw new Error("Use the private OnFinality Base mainnet HTTPS endpoint.");
  }

  return {
    MAG_ALCHEMY_API_KEY: alchemyKey,
    MAG_BASE_RPC_PRIMARY_URL: `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    MAG_BASE_RPC_SECONDARY_URL: onfinalityEndpoint,
  };
}

async function readInput() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
      throw new Error("Credential input exceeded the allowed size.");
    }
  }
  return JSON.parse(raw);
}

function upload(bundle) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WRANGLER_PATH, "secret", "bulk", "--name", "mavverick-scout", "--config", CONFIG_PATH],
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: "94130c1b7160b2b7a6f45a15f026bc6d",
          CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
          WRANGLER_LOG_SANITIZE: "true",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG: "error",
        },
      },
    );

    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
    child.once("error", () => reject(new Error("Could not start the existing Wrangler installation.")));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Cloudflare upload timed out; outcome is unknown."));
    }, 60_000);

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdoutBytes, stderrBytes });
      } else {
        reject(new Error("Cloudflare did not confirm the secret upload."));
      }
    });

    child.stdin.end(JSON.stringify(bundle));
  });
}

let input;
let bundle;
try {
  input = await readInput();
  bundle = validate(input);
  if (process.argv.includes("--validate-only")) {
    process.stdout.write("Credential input validated; no upload performed.\n");
  } else {
    await upload(bundle);
    process.stdout.write("Cloudflare confirmed MAG_ALCHEMY_API_KEY, MAG_BASE_RPC_PRIMARY_URL, and MAG_BASE_RPC_SECONDARY_URL.\n");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "Credential installation failed.");
} finally {
  if (input) {
    input.alchemyKey = "";
    input.onfinalityEndpoint = "";
  }
  if (bundle) {
    for (const key of Object.keys(bundle)) bundle[key] = "";
  }
  input = undefined;
  bundle = undefined;
}
