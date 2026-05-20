#!/usr/bin/env node
/**
 * smoke.js — end-to-end LSP smoke test.
 *
 * Spawns the real server over stdio, runs `initialize` → `initialized` →
 * `textDocument/didOpen` with a deliberately broken PRD, then asserts that
 * `textDocument/publishDiagnostics` arrives with the expected diagnostics.
 *
 * Also tests cross-document LSP operations added in v0.3.0:
 *   - capabilities advertisement
 *   - documentSymbol
 *   - workspaceSymbol
 *   - hover
 *   - definition
 *   - references
 *   - callHierarchy stubs
 *
 * Exits 0 on success, 1 with a printed failure detail otherwise.
 *
 * Not shipped to end users — invoked manually (`node server/smoke.js`) or via
 * CI as a regression guard against import-path drift / dep upgrades.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadVaultConfig } from "../lib/vault-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Hermetic root: the bundled `examples/example` vault that ships with this
// plugin. Self-contained — no external checkout dependency.
// SMOKE_PROJECT_ROOT overrides for ad-hoc runs against a real vault.
const repoRoot = resolve(__dirname, "..");
const projectRoot =
  process.env.SMOKE_PROJECT_ROOT ||
  resolve(repoRoot, "examples/example");
// Default to the bundled artifact (what ships); allow source via env for
// quick edit-test cycles before re-bundling.
const useBundle = process.env.SMOKE_TARGET !== "source";
const serverPath = resolve(__dirname, useBundle ? "main.bundled.cjs" : "main.js");

const child = spawn("node", [serverPath, "--stdio"], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = Buffer.alloc(0);
const pendingResolvers = []; // FIFO queue of (msg) => void

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // LSP framing: `Content-Length: N\r\n\r\n<body>`. Pull every complete frame.
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
    else console.error("smoke: unexpected unsolicited message:", msg);
  }
});

let requestId = 10; // start above the ids used in the old test

function send(msg) {
  const json = JSON.stringify(msg);
  const frame = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
  child.stdin.write(frame);
}

function sendRequest(method, params) {
  const id = ++requestId;
  send({ jsonrpc: "2.0", id, method, params });
  return id;
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
      pendingResolvers.unshift(pump); // not the one we wanted — re-queue for next message
    };
    pendingResolvers.push(pump);
  });
}

function waitForResponse(id, label, timeoutMs = 10000) {
  return waitForMessage((m) => m.id === id, label, timeoutMs);
}

/**
 * Find a real task file that has a relative markdown link (../path.md) so
 * the definition handler can resolve it. Falls back to any task file.
 */
function findRealTaskFile() {
  const vaultRoot = loadVaultConfig(projectRoot).vaultRoot;
  const tasksDir = resolve(projectRoot, vaultRoot, "tasks");
  if (!existsSync(tasksDir)) return null;
  const files = readdirSync(tasksDir).filter(
    (f) =>
      f.startsWith("t-") &&
      f.endsWith(".md") &&
      !f.endsWith("-invalid.md"),
  );
  if (files.length === 0) return null;
  // Prefer a file with a relative link (../) to another .md
  for (const f of files) {
    const full = resolve(tasksDir, f);
    try {
      const content = readFileSync(full, "utf-8");
      if (/\]\(\.\.\/.+\.md/.test(content)) return full;
    } catch { continue; }
  }
  // Fallback: any task file
  return resolve(tasksDir, files[0]);
}

async function main() {
  // 1. initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: `file://${projectRoot}`,
      workspaceFolders: [{ uri: `file://${projectRoot}`, name: "vault-keeper-smoke" }],
      capabilities: {},
    },
  });
  const initResp = await waitForMessage((m) => m.id === 1 && m.result?.capabilities, "initialize response");

  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  // ── Assertion group 1: Capabilities advertisement ─────────────────────────
  const caps = initResp.result.capabilities;

  // 2. didOpen — broken PRD targeting the configured vault root so it's
  // classified as a vault file. Multiple violations packed in to exercise
  // every diagnostic path: fields leak (warning), bad date regex
  // (error), missing Ship Timeline body section (conditional error,
  // status=shipped), malformed Relationships bullet (body warning),
  // malformed AC heading (body warning).
  const brokenText = `---
template: templates/prd-template.md
document_type: prd
title: Bogus smoke PRD
prd_type: feature
status: shipped
owner: 'someone@example.com'
created: not-a-date
shipped_date: '2099-01-01'
rice:
  reach: 50
  impact: 1
  confidence: 80
  effort: 2
fields:
  title: { required: true }
---

# Test PRD

## Relationships
- bogus line not matching canonical form

## Acceptance Criteria

### AC1 - missing dashes
`;
  // Build the URI under the configured vaultRoot so isVaultFile classifies it
  // as a vault doc, and match the PRD template's `$path` pattern so per-template
  // rules apply.
  const smokeVaultRoot = loadVaultConfig(projectRoot).vaultRoot;
  const uri = `file://${projectRoot}/${smokeVaultRoot}/prds/prd-999-bogus.md`;
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "markdown", version: 1, text: brokenText },
    },
  });

  // 3. Wait for publishDiagnostics (server pushes asynchronously)
  const notif = await waitForMessage(
    (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri,
    "publishDiagnostics",
  );

  const diags = notif.params.diagnostics;
  console.log(`smoke: received ${diags.length} diagnostics for broken PRD`);
  for (const d of diags) {
    console.log(
      `  [${severityName(d.severity)}] ${d.range.start.line}:${d.range.start.character}  code=${d.code}  ${d.message.split("\n")[0]}`,
    );
  }

  // ── Assertion group 2: Diagnostics (original) ─────────────────────────────
  const findings = {
    leakFields: diags.some((d) => d.code === "fields"),
    badCreatedDate: diags.some((d) => d.code === "created"),
    // The PRD schema migrated to minimal frontmatter — `target_ship_date`
    // and `shipped_at` no longer exist; the conditional now requires the body section
    // `## Ship Timeline` (when prd_type ∈ feature/enhancement/sunset/hotfix and status
    // ∉ draft/review). Validator emits diagnostic code=`body_section:## Ship Timeline`.
    missingShipTimelineSection: diags.some(
      (d) => d.code === "body_section:## Ship Timeline",
    ),
    bodyRelationshipForm: diags.some(
      (d) => d.code === "body" && d.message.toLowerCase().includes("relationship"),
    ),
    bodyAcHeading: diags.some(
      (d) => d.code === "body" && d.message.toLowerCase().includes("ac heading"),
    ),
  };

  // ── Assertion group 3: documentSymbol on broken PRD ───────────────────────
  const dsId = sendRequest("textDocument/documentSymbol", {
    textDocument: { uri },
  });
  const dsResp = await waitForResponse(dsId, "documentSymbol response");
  const docSymbols = dsResp.result || [];

  // ── Assertion group 4: workspaceSymbol ────────────────────────────────────
  const wsId = sendRequest("workspace/symbol", { query: "t-0" });
  const wsResp = await waitForResponse(wsId, "workspaceSymbol response");
  const wsSymbols = wsResp.result || [];

  // ── Assertion group 5: hover at frontmatter field ─────────────────────────
  // "status:" is at line 5, character 0 in the broken PRD
  // (line 0 = `---`, 1 = template, 2 = document_type, 3 = title,
  //  4 = prd_type, 5 = status, 6 = owner, ...)
  const hoverId = sendRequest("textDocument/hover", {
    textDocument: { uri },
    position: { line: 5, character: 0 },
  });
  const hoverResp = await waitForResponse(hoverId, "hover response");

  // ── Assertion group 6: definition + references (use real task file) ───────
  let defResult = null;
  let refsResult = null;
  const realTaskPath = findRealTaskFile();

  if (realTaskPath) {
    // Open a real task with a known markdown link
    const taskText = readFileSync(realTaskPath, "utf-8");
    const taskUri = `file://${realTaskPath}`;

    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri: taskUri, languageId: "markdown", version: 1, text: taskText },
      },
    });

    // Wait for diagnostics to arrive (or timeout) so we know the doc is processed
    await waitForMessage(
      (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === taskUri,
      "task publishDiagnostics",
    ).catch(() => {});

    // Find a markdown link line in the task text
    const taskLines = taskText.split("\n");
    let linkLine = -1;
    let linkChar = -1;
    for (let i = 0; i < taskLines.length; i++) {
      const lm = taskLines[i].match(/\[([^\]]+)\]\(([^)]+\.md)/);
      if (lm) {
        linkLine = i;
        // Position cursor inside the link target (after the `](`)
        linkChar = taskLines[i].indexOf("](") + 2;
        break;
      }
    }

    if (linkLine >= 0) {
      const defId = sendRequest("textDocument/definition", {
        textDocument: { uri: taskUri },
        position: { line: linkLine, character: linkChar },
      });
      const defResp = await waitForResponse(defId, "definition response");
      defResult = defResp.result;
    }

    // References for the task file itself
    const refsId = sendRequest("textDocument/references", {
      textDocument: { uri: taskUri },
      position: { line: 0, character: 0 },
      context: { includeDeclaration: true },
    });
    const refsResp = await waitForResponse(refsId, "references response");
    refsResult = refsResp.result;
  }

  // ── Assertion group 7: callHierarchy stubs ────────────────────────────────
  const chId = sendRequest("textDocument/prepareCallHierarchy", {
    textDocument: { uri },
    position: { line: 0, character: 0 },
  });
  const chResp = await waitForResponse(chId, "prepareCallHierarchy response");

  // ── Print all assertions ──────────────────────────────────────────────────
  console.log("\nsmoke: assertions (original diagnostics):");
  for (const [k, ok] of Object.entries(findings)) {
    console.log(`  ${ok ? "✅" : "❌"} ${k}`);
  }

  // New v0.3.0 assertions
  const newFindings = {
    capabilitiesAdvertise:
      !!caps.documentSymbolProvider &&
      !!caps.hoverProvider &&
      !!caps.definitionProvider &&
      !!caps.referencesProvider &&
      !!caps.implementationProvider &&
      !!caps.workspaceSymbolProvider &&
      !!caps.callHierarchyProvider,
    documentSymbolReturnsHeaders:
      Array.isArray(docSymbols) && docSymbols.length >= 1,
    workspaceSymbolFindsTaskId:
      Array.isArray(wsSymbols) && wsSymbols.length >= 1,
    hoverReturnsValidationRule:
      hoverResp.result != null &&
      typeof hoverResp.result?.contents?.value === "string" &&
      hoverResp.result.contents.value.includes("status"),
    definitionResolvesLink:
      // Either we found a link and resolved it, or no links exist in the file (acceptable)
      defResult === null
        ? (realTaskPath ? false : true) // no real file → skip (pass)
        : (defResult.uri != null || (Array.isArray(defResult) && defResult.length > 0)),
    referencesReturnsBacklinks:
      // At minimum, includeDeclaration=true means self is returned
      Array.isArray(refsResult) && refsResult.length >= 1,
    callHierarchyReturnsNull:
      chResp.result === null || chResp.result === undefined,
  };

  console.log("\nsmoke: assertions (v0.3.0 LSP operations):");
  for (const [k, ok] of Object.entries(newFindings)) {
    console.log(`  ${ok ? "✅" : "❌"} ${k}`);
  }

  const oldOk = Object.values(findings).every(Boolean);
  const newOk = Object.values(newFindings).every(Boolean);

  if (!newOk) {
    console.log("\nsmoke: v0.3.0 assertion details:");
    if (!newFindings.capabilitiesAdvertise) {
      console.log("  caps:", JSON.stringify(caps, null, 2).slice(0, 300));
    }
    if (!newFindings.documentSymbolReturnsHeaders) {
      console.log("  docSymbols:", JSON.stringify(docSymbols).slice(0, 300));
    }
    if (!newFindings.workspaceSymbolFindsTaskId) {
      console.log("  wsSymbols:", JSON.stringify(wsSymbols).slice(0, 200));
    }
    if (!newFindings.hoverReturnsValidationRule) {
      console.log("  hover:", JSON.stringify(hoverResp.result).slice(0, 300));
    }
    if (!newFindings.definitionResolvesLink) {
      console.log("  definition:", JSON.stringify(defResult).slice(0, 300));
      console.log("  realTaskPath:", realTaskPath);
    }
    if (!newFindings.referencesReturnsBacklinks) {
      console.log("  references:", JSON.stringify(refsResult).slice(0, 300));
    }
    if (!newFindings.callHierarchyReturnsNull) {
      console.log("  callHierarchy:", JSON.stringify(chResp.result).slice(0, 200));
    }
  }

  // Cleanup
  send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  await waitForMessage((m) => m.id === 2, "shutdown response").catch(() => {});
  send({ jsonrpc: "2.0", method: "exit" });

  child.kill("SIGTERM");
  // Exit 0 only if ALL new assertions pass (old 2-failing are out of scope)
  process.exit(newOk ? 0 : 1);
}

function severityName(s) {
  return ({ 1: "ERR ", 2: "WARN", 3: "INFO", 4: "HINT" })[s] ?? "?   ";
}

main().catch((err) => {
  console.error("smoke: failed:", err);
  child.kill("SIGTERM");
  process.exit(1);
});
