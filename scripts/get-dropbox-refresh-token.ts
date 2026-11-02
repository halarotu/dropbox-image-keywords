/**
 * One-time helper: walks you through Dropbox OAuth and prints a long-lived refresh token.
 * Usage: DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... npm run dropbox:token
 */
import { createInterface } from "node:readline/promises";

async function main() {
  const key = process.env.DROPBOX_APP_KEY;
  const secret = process.env.DROPBOX_APP_SECRET;
  if (!key || !secret) throw new Error("Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET first.");

  const url =
    "https://www.dropbox.com/oauth2/authorize" +
    `?client_id=${encodeURIComponent(key)}&response_type=code&token_access_type=offline`;
  console.log(`\n1. Open this URL and approve access:\n\n   ${url}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("2. Paste the code Dropbox shows you: ")).trim();
  rl.close();

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: key,
      client_secret: secret,
    }),
  });
  const body = (await res.json()) as { refresh_token?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    throw new Error(`Token exchange failed: ${body.error_description ?? res.statusText}`);
  }
  console.log(`\n3. Your refresh token (store it as a secret, never commit it):\n\n${body.refresh_token}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
