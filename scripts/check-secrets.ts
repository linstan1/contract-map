/**
 * Refuses to let a credential enter the repository.
 *
 * Every user of this project supplies their own RPC key. No key ships here,
 * and no key may ever be committed, in any branch or any fork. This script
 * proves that for the files git tracks right now.
 *
 * Run it by hand, or let the CI workflow run it on every push:
 *   bun run check-secrets
 *
 * It exits 1 on the first real finding, so it works as a pre-commit hook too:
 *   echo 'bun run check-secrets' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
 */

const DECODER = new TextDecoder();

interface Rule {
  name: string;
  /** What a match means, in one sentence. */
  reason: string;
  pattern: RegExp;
  /** Matches that are known to be harmless. */
  allow?: RegExp;
}

/**
 * Each rule targets a credential SHAPE, not a specific value, so a rotated or
 * a different user's key is caught as well.
 *
 * Bare hex is deliberately not a rule. This repository is full of legitimate
 * hex: selectors, topics, storage slots, and whole runtime bytecode in test
 * fixtures. Only hex inside a provider URL counts.
 */
const RULES: Rule[] = [
  {
    name: "alchemy key",
    reason: "An Alchemy key must never be committed. Keep it in .env.local.",
    pattern: /alch_[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: "provider url with credential",
    reason: "A provider URL with a path credential leaks that credential.",
    pattern: /(g\.alchemy\.com\/v2|infura\.io\/v3|quiknode\.pro|\.alchemyapi\.io\/v2)\/[A-Za-z0-9_-]{6,}/g,
  },
  {
    name: "populated key assignment",
    reason: "A key assignment with a value belongs in .env.local, not in a tracked file.",
    pattern: /\b(ALCHEMY_API_KEY|AUTH_TOKEN|API_KEY|SECRET|PRIVATE_KEY|MNEMONIC)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{8,}/g,
    /* `process.env.X` reads, empty templates, and prose are not assignments. */
    allow: /process\.env|import\.meta\.env|=\s*$|=\s*["']["']|<key>|your_key_here|\$\{|startsWith|slice|indexOf/,
  },
  {
    name: "github token",
    reason: "A GitHub token grants access to the account that created it.",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  {
    name: "openai style key",
    reason: "An API key of this shape grants paid access.",
    pattern: /\bsk-[A-Za-z0-9]{20,}/g,
  },
  {
    name: "private key block",
    reason: "A private key must never leave the machine that made it.",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: "hex private key",
    reason: "A 32 byte hex secret looks like an account private key.",
    pattern: /\b(?:PRIVATE_KEY|privateKey|PK)\s*[=:]\s*["']?0x[0-9a-fA-F]{64}/g,
  },
];

/** Files that may never be tracked, whatever they contain. */
const FORBIDDEN_PATHS = [/^\.env$/, /^\.env\.(?!example$)/, /(^|\/)id_rsa$/, /\.pem$/, /\.p12$/, /(^|\/)\.npmrc$/];

async function trackedFiles(): Promise<string[]> {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: `${import.meta.dir}/..` });
  if (listing.exitCode !== 0) {
    console.error("git ls-files failed. Run this inside the repository.");
    process.exit(2);
  }
  return DECODER.decode(listing.stdout).split("\0").filter(Boolean);
}

/** Binary files hold no readable credential and would produce noise. */
function isBinary(path: string): boolean {
  return /\.(webp|png|jpg|jpeg|gif|ico|pdf|zip|gz|wasm|lock)$/i.test(path);
}

interface Finding {
  path: string;
  line: number;
  rule: Rule;
  excerpt: string;
}

async function main(): Promise<void> {
  const files = await trackedFiles();
  const findings: Finding[] = [];

  for (const path of FORBIDDEN_PATHS.flatMap((rule) => files.filter((file) => rule.test(file)))) {
    findings.push({
      path,
      line: 0,
      rule: { name: "forbidden path", reason: "This file holds credentials by convention and must stay untracked.", pattern: /x/ },
      excerpt: path,
    });
  }

  for (const path of files) {
    if (isBinary(path)) continue;
    /* This script states the patterns it hunts, so scanning itself would
     * report every rule as a finding. */
    if (path === "scripts/check-secrets.ts") continue;

    const text = await Bun.file(`${import.meta.dir}/../${path}`).text().catch(() => "");
    if (!text) continue;

    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] as string;
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (!match) continue;
        if (rule.allow?.test(line)) continue;
        findings.push({ path, line: index + 1, rule, excerpt: line.trim().slice(0, 120) });
      }
    }
  }

  if (findings.length === 0) {
    console.log(`No credential found in ${files.length} tracked files. Every user supplies their own key.`);
    return;
  }

  console.error(`Found ${findings.length} possible credential${findings.length === 1 ? "" : "s"} in tracked files:\n`);
  for (const finding of findings) {
    console.error(`  ${finding.path}:${finding.line}  [${finding.rule.name}]`);
    console.error(`    ${finding.rule.reason}`);
    console.error(`    ${finding.excerpt}\n`);
  }
  console.error("Remove the value, keep it in .env.local, and rotate it if it ever reached a remote.");
  process.exit(1);
}

await main();
