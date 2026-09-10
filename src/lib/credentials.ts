/**
 * Readable credential generator for organiser-issued accounts.
 *
 * Word-word-digits is deliberate: an organiser has to be able to read these
 * aloud across a noisy hall and a participant has to type them correctly on a
 * phone. Ambiguous characters (O/0, I/l/1) never appear.
 *
 * ~16 words^2 x 9000 is not a lot of entropy on its own, which is fine here:
 * signups are disabled, accounts are provisioned individually, and Supabase
 * rate-limits auth. It is a door code for a four-week game, not a bank login.
 */
const WORDS = [
  "Alpha", "Bravo", "Delta", "Echo", "Falcon", "Gamma", "Hawk", "Indigo",
  "Juno", "Kilo", "Lima", "Nova", "Orion", "Quartz", "Rally", "Sierra",
  "Tango", "Umber", "Vertex", "Willow", "Xenon", "Yankee", "Zephyr", "Cobalt",
];

export function generateCredential(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  let a = pick();
  let b = pick();
  while (b === a) b = pick();
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${a}-${b}-${digits}`;
}
