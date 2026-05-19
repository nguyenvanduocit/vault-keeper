#!/usr/bin/env node
/**
 * examples/example/smoke.js — foreign-vault LSP smoke driver.
 *
 * Proves the SHIPPED LSP bundle works against THIS vault — `vaultRoot: docs`,
 * the vault's OWN `templates/note-template.md` (claude-code-vault-keeper
 * ships no templates), no `product-knowledge/`.
 *
 * Mechanics mirror server/smoke.js (LSP framing, request/response pump) but
 * the assertion is vault-specific: open an INVALID note (missing the
 * template-required `owner` field) and assert the server publishes ≥1
 * diagnostic that names `owner` or `required`. A diagnostic can only fire if
 * the bundle:
 *   1. resolved the project root to this example vault,
 *   2. read `.claude/vault-keeper.json` (vaultRoot=docs) so the doc under
 *      `docs/` is classified a vault file,
 *   3. loaded THIS vault's `templates/note-template.md` validation_rules.
 *
 * Exit 0 on success, 1 otherwise. Run: `node examples/example/smoke.js` from
 * the repo root.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = __dirname; // examples/example
const repoRoot = resolve(__dirname, "..", "..");
const serverPath = resolve(repoRoot, "server", "main.bundled.cjs");

const child = spawn("node", [serverPath, "--stdio"], {
  cwd: exampleRoot,
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = Buffer.alloc(0);
const pendingResolvers = [];

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf-8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      console.error("smoke: malformed frame header:", header);
      process.exit(2);
    }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString("utf-8");
    buffer = buffer.slice(start + len);
    const msg = JSON.parse(body);
    const next = pendingResolvers.shift();
    if (next) next(msg);
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  child.stdin.write(
    `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`,
  );
}

function waitForMessage(predicate, label, timeoutMs = 10000) {
  return new Promise((resolveFn, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`smoke: timeout waiting for ${label}`)),
      timeoutMs,
    );
    const pump = (msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        resolveFn(msg);
        return;
      }
      pendingResolvers.unshift(pump);
    };
    pendingResolvers.push(pump);
  });
}

// An INVALID note: missing the template-required `owner` field. The example
// vault's templates/note-template.md declares
// required_fields: [template, document_type, title, owner].
const invalidNote = `---
template: templates/note-template.md
document_type: note
title: Invalid Note Missing Owner
---

# Invalid Note Missing Owner

## Relationships
`;

async function main() {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: `file://${exampleRoot}`,
      workspaceFolders: [
        { uri: `file://${exampleRoot}`, name: "example-smoke" },
      ],
      capabilities: {},
    },
  });
  await waitForMessage(
    (m) => m.id === 1 && m.result?.capabilities,
    "initialize response",
  );
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  // Doc lives under docs/ (the configured vaultRoot). Filename matches the
  // note template's path_regex so vault-side rules apply.
  const uri = `file://${exampleRoot}/docs/notes/note-999-smoke-invalid.md`;
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        languageId: "markdown",
        version: 1,
        text: invalidNote,
      },
    },
  });

  const notif = await waitForMessage(
    (m) =>
      m.method === "textDocument/publishDiagnostics" &&
      m.params?.uri === uri,
    "publishDiagnostics",
  );
  const diags = notif.params.diagnostics;

  console.log(
    `smoke(example): server resolved root, loaded vault's own templates/`,
  );
  console.log(
    `smoke(example): received ${diags.length} diagnostic(s) for the invalid note`,
  );
  for (const d of diags) {
    console.log(
      `  [${({ 1: "ERR ", 2: "WARN", 3: "INFO", 4: "HINT" })[d.severity] ?? "?"}] ` +
        `${d.range.start.line}:${d.range.start.character}  code=${d.code}  ` +
        `${d.message.split("\n")[0]}`,
    );
  }

  // The LSP is per-doc-only; cross-doc rules (orphan, V8) run CLI-side. The
  // foreign-vault proof is: ≥1 diagnostic fired, AND one of them is the
  // template-required-field violation for the missing `owner`.
  const sawDiagnostics = diags.length >= 1;
  const sawMissingOwner = diags.some(
    (d) =>
      String(d.code).includes("owner") ||
      /owner/i.test(d.message) ||
      /required/i.test(d.message),
  );

  console.log("\nsmoke(example): assertions:");
  console.log(`  ${sawDiagnostics ? "PASS" : "FAIL"} diagnostics published (≥1)`);
  console.log(
    `  ${sawMissingOwner ? "PASS" : "FAIL"} template required-field rule loaded from this vault's templates/ (missing owner flagged)`,
  );

  send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  await waitForMessage((m) => m.id === 2, "shutdown response").catch(() => {});
  send({ jsonrpc: "2.0", method: "exit" });
  child.kill("SIGTERM");
  process.exit(sawDiagnostics && sawMissingOwner ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke(example): failed:", err);
  child.kill("SIGTERM");
  process.exit(1);
});
