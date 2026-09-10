#!/usr/bin/env node
/**
 * Creates the first admin account.
 *
 * There is no self-signup in Xavage — every account is provisioned. This script
 * is the bootstrap: it creates one admin, who then creates everyone else from
 * the admin console.
 *
 *   node scripts/bootstrap-admin.mjs "you@example.com" "AStrongPassword123" "Your Name"
 *
 * Reads SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * from the environment or .env.local.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (!process.env[key]) process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const [email, password, displayName = "Administrator"] = process.argv.slice(2);

if (!url || !serviceKey) {
  console.error("✗ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  console.error("  Put them in .env.local or export them, then re-run.");
  process.exit(1);
}

if (!email || !password) {
  console.error('Usage: node scripts/bootstrap-admin.mjs "email" "password" "Display Name"');
  process.exit(1);
}

if (password.length < 10) {
  console.error("✗ Choose a password of at least 10 characters.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await admin.auth.admin.createUser({
  email: email.toLowerCase(),
  password,
  email_confirm: true,
  // display_name only -- user_metadata is user-editable, so the admin role is
  // granted by the privileged UPDATE below, never by a metadata claim.
  user_metadata: { display_name: displayName },
});

if (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

// The auth trigger creates the profile; promote it and skip the forced rotation
// (you chose this password yourself).
const { error: profileError } = await admin
  .from("profiles")
  .update({ role: "admin", display_name: displayName, must_change_password: false, is_active: true })
  .eq("id", data.user.id);

if (profileError) {
  console.error(`✗ Account created but profile update failed: ${profileError.message}`);
  process.exit(1);
}

console.log("✓ Admin account ready");
console.log(`  email: ${email.toLowerCase()}`);
console.log(`  name:  ${displayName}`);
console.log("\nSign in at /login, then create teams and accounts under Admin → Teams / Accounts.");
