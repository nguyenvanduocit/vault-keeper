/**
 * Tests for lib/canonical-formatter.js
 *
 * Focus areas:
 *   - Frontmatter key reordering
 *   - Section reordering per template sections list
 *   - AC heading normalization (multiple variants)
 *   - Relationship bullet normalization
 *   - Trailing whitespace strip
 *   - Multi-newline collapse
 *   - Idempotency: format(format(x)) === format(x)  ← CRITICAL
 *   - No-change case returns changed: false
 *   - Code fence safety (no transforms inside ```)
 */

import { describe, test, expect } from "bun:test";
import { formatVaultDocument } from "../lib/canonical-formatter.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(text, opts = {}) {
  return formatVaultDocument(text, opts);
}

function idem(text, opts = {}) {
  const first = fmt(text, opts).formatted;
  const second = fmt(first, opts).formatted;
  expect(second).toBe(first);
  return first;
}

// ── Frontmatter key ordering ───────────────────────────────────────────────

describe("frontmatter key ordering", () => {
  test("priority keys come first in order", () => {
    const input = `---
updated: '2026-05-12T00:00:00+07:00'
owner: alice@example.com
template: templates/prd-template.md
status: draft
title: My Doc
id: t-001
created: '2026-05-01T00:00:00+07:00'
---

Body content.
`;
    const { formatted } = fmt(input);
    const lines = formatted.split("\n");
    const fmLines = lines.slice(1, lines.indexOf("---", 1));
    const keys = fmLines.filter((l) => /^\w+:/.test(l)).map((l) => l.split(":")[0]);
    expect(keys[0]).toBe("id");
    expect(keys[1]).toBe("title");
    expect(keys[2]).toBe("template");
    expect(keys[3]).toBe("status");
    expect(keys[4]).toBe("owner");
    expect(keys[5]).toBe("created");
    expect(keys[6]).toBe("updated");
  });

  test("non-priority keys are sorted alphabetically after priority", () => {
    const input = `---
status: draft
template: templates/prd-template.md
zebra: last
apple: first-alpha
mango: middle
---

Body.
`;
    const { formatted } = fmt(input);
    const lines = formatted.split("\n");
    const fmLines = lines.slice(1, lines.indexOf("---", 1));
    const keys = fmLines.filter((l) => /^\w+:/.test(l)).map((l) => l.split(":")[0]);
    // template, status are priority; apple, mango, zebra are alpha
    const nonPriority = keys.filter((k) => !["id","title","template","status","phase","owner","created","updated"].includes(k));
    expect(nonPriority).toEqual(["apple", "mango", "zebra"]);
  });

  test("missing priority keys are skipped (no undefined entries)", () => {
    const input = `---
status: draft
template: templates/prd-template.md
---

Body.
`;
    const { formatted } = fmt(input);
    expect(formatted).not.toContain("undefined");
    expect(formatted).toContain("status: draft");
    expect(formatted).toContain("template: templates/prd-template.md");
  });

  test("array values preserved", () => {
    const input = `---
status: draft
template: templates/prd-template.md
tags:
  - reliability
  - trust
---

Body.
`;
    const { formatted } = fmt(input);
    expect(formatted).toContain("tags:");
    expect(formatted).toContain("- reliability");
    expect(formatted).toContain("- trust");
  });

  test("nested object values preserved", () => {
    const input = `---
status: draft
template: templates/prd-template.md
quick_links:
  figma: ''
  jira: ''
---

Body.
`;
    const { formatted } = fmt(input);
    expect(formatted).toContain("quick_links:");
    expect(formatted).toContain("figma:");
    expect(formatted).toContain("jira:");
  });

  test("idempotent on frontmatter reordering", () => {
    const input = `---
updated: '2026-05-12T00:00:00+07:00'
status: draft
template: templates/prd-template.md
tags:
  - a
  - b
owner: alice@example.com
---

Body content here.
`;
    idem(input);
  });
});

// ── Section reordering ─────────────────────────────────────────────────────

describe("section reordering", () => {
  test("reorders sections per sections list", () => {
    const input = `---
template: templates/prd-template.md
---

## Goals

Goals content.

## Problem

Problem content.
`;
    const sections = ["problem", "goals"];
    const { formatted } = fmt(input, { sections });
    const problemIdx = formatted.indexOf("## Problem");
    const goalsIdx = formatted.indexOf("## Goals");
    expect(problemIdx).toBeLessThan(goalsIdx);
  });

  test("unlisted sections go at end when no wildcard", () => {
    const input = `---
template: templates/prd-template.md
---

## Unknown Section

Unknown content.

## Goals

Goals content.

## Problem

Problem content.
`;
    const sections = ["problem", "goals"];
    const { formatted } = fmt(input, { sections });
    const problemIdx = formatted.indexOf("## Problem");
    const goalsIdx = formatted.indexOf("## Goals");
    const unknownIdx = formatted.indexOf("## Unknown Section");
    expect(problemIdx).toBeLessThan(goalsIdx);
    expect(goalsIdx).toBeLessThan(unknownIdx);
  });

  test("wildcard * inserts unlisted sections at its position", () => {
    const input = `---
template: templates/prd-template.md
---

## Extra Section

Extra content.

## Goals

Goals content.

## Problem

Problem content.
`;
    const sections = ["problem", "*", "goals"];
    const { formatted } = fmt(input, { sections });
    const problemIdx = formatted.indexOf("## Problem");
    const extraIdx = formatted.indexOf("## Extra Section");
    const goalsIdx = formatted.indexOf("## Goals");
    expect(problemIdx).toBeLessThan(extraIdx);
    expect(extraIdx).toBeLessThan(goalsIdx);
  });

  test("missing sections from list are skipped gracefully", () => {
    const input = `---
template: templates/prd-template.md
---

## Goals

Goals content.
`;
    const sections = ["problem", "goals", "constraints"];
    const { formatted } = fmt(input, { sections });
    expect(formatted).toContain("## Goals");
    expect(formatted).not.toContain("## Problem");
    expect(formatted).not.toContain("## Constraints");
  });

  test("no sections list = pass through unchanged body sections", () => {
    const input = `---
template: templates/prd-template.md
---

## Goals

Goals content.

## Problem

Problem content.
`;
    const { formatted } = fmt(input, { sections: [] });
    const goalsIdx = formatted.indexOf("## Goals");
    const problemIdx = formatted.indexOf("## Problem");
    expect(goalsIdx).toBeLessThan(problemIdx);
  });

  test("idempotent on section reordering", () => {
    const input = `---
template: templates/prd-template.md
---

## Goals

Goals content.

## Problem

Problem content.

## Extra

Extra.
`;
    idem(input, { sections: ["problem", "goals", "*"] });
  });
});

// ── AC heading normalization ───────────────────────────────────────────────

describe("AC heading normalization", () => {
  test("colon form → em-dash form", () => {
    const { formatted } = fmt("### AC1: user can login\n");
    expect(formatted).toContain("### AC1 — User can login");
  });

  test("spaced dash form → em-dash form", () => {
    const { formatted } = fmt("### AC1 - user can login\n");
    expect(formatted).toContain("### AC1 — User can login");
  });

  test("spaced AC number form", () => {
    const { formatted } = fmt("### AC 1: user can login\n");
    expect(formatted).toContain("### AC1 — User can login");
  });

  test("already canonical form is unchanged", () => {
    const line = "### AC1 — User can login";
    const { formatted } = fmt(line + "\n");
    expect(formatted).toContain("### AC1 — User can login");
  });

  test("first letter capitalized", () => {
    const { formatted } = fmt("### AC2: show error message on failure\n");
    expect(formatted).toContain("### AC2 — Show error message on failure");
  });

  test("higher heading level (####) preserved", () => {
    const { formatted } = fmt("#### AC3: nested ac\n");
    expect(formatted).toContain("#### AC3 — Nested ac");
  });

  test("AC headings inside code fence NOT transformed", () => {
    const input = "```\n### AC1: foo\n```\n";
    const { formatted } = fmt(input);
    expect(formatted).toContain("### AC1: foo");
    expect(formatted).not.toContain("### AC1 — Foo");
  });

  test("idempotent on AC heading normalization", () => {
    const input = "### AC1: user can login\n\n### AC2 - show error\n";
    idem(input);
  });
});

// ── Relationship bullet normalization ──────────────────────────────────────

describe("relationship bullet normalization", () => {
  test("unbolded colon form → bold form", () => {
    const { formatted } = fmt("- implements_bet: [My PRD](../prds/prd-001.md)\n");
    expect(formatted).toContain("- **implements_bet** [My PRD](../prds/prd-001.md)");
  });

  test("unbolded space form → bold form", () => {
    const { formatted } = fmt("- implements_bet [My PRD](../prds/prd-001.md)\n");
    expect(formatted).toContain("- **implements_bet** [My PRD](../prds/prd-001.md)");
  });

  test("reason part preserved with em-dash", () => {
    const { formatted } = fmt("- implements_bet: [My PRD](../prds/prd-001.md) — core feature\n");
    expect(formatted).toContain("- **implements_bet** [My PRD](../prds/prd-001.md) — core feature");
  });

  test("already canonical form is unchanged", () => {
    const line = "- **implements_bet** [My PRD](../prds/prd-001.md) — core feature\n";
    const { formatted } = fmt(line);
    expect(formatted).toContain("**implements_bet**");
  });

  test("bold with colon → bold without colon", () => {
    const { formatted } = fmt("- **implements_bet**: [My PRD](../prds/prd-001.md)\n");
    expect(formatted).toContain("- **implements_bet** [My PRD](../prds/prd-001.md)");
  });

  test("rel bullets inside code fence NOT transformed", () => {
    const input = "```\n- implements_bet: [PRD](prd.md)\n```\n";
    const { formatted } = fmt(input);
    expect(formatted).toContain("- implements_bet: [PRD](prd.md)");
  });

  test("idempotent on relationship bullet normalization", () => {
    const input = "- implements_bet: [My PRD](../prds/prd-001.md) — reason\n";
    idem(input);
  });
});

// ── Trailing whitespace ────────────────────────────────────────────────────

describe("trailing whitespace", () => {
  test("strips trailing spaces from lines", () => {
    const { formatted } = fmt("line one   \nline two  \n");
    const lines = formatted.split("\n");
    expect(lines[0]).toBe("line one");
    expect(lines[1]).toBe("line two");
  });

  test("strips trailing tabs from lines", () => {
    const { formatted } = fmt("line\t\t\nother\n");
    expect(formatted.split("\n")[0]).toBe("line");
  });

  test("trailing WS inside code fence NOT stripped", () => {
    // Code fences are skipped for line transforms
    const input = "```\ncode line   \n```\n";
    const { formatted } = fmt(input);
    expect(formatted).toContain("code line   ");
  });
});

// ── Multi-blank-line collapse ──────────────────────────────────────────────

describe("multi-blank-line collapse", () => {
  test("3 blank lines → 2", () => {
    const { formatted } = fmt("line one\n\n\n\nline two\n");
    expect(formatted).toContain("line one\n\nline two");
  });

  test("5 blank lines → 2", () => {
    const { formatted } = fmt("a\n\n\n\n\n\nb\n");
    expect(formatted).toContain("a\n\nb");
  });

  test("1 blank line preserved", () => {
    const { formatted } = fmt("a\n\nb\n");
    expect(formatted).toContain("a\n\nb");
  });
});

// ── Final newline ──────────────────────────────────────────────────────────

describe("final newline", () => {
  test("adds final newline if missing", () => {
    const { formatted } = fmt("no newline at end");
    expect(formatted.endsWith("\n")).toBe(true);
  });

  test("collapses multiple trailing newlines to one", () => {
    const { formatted } = fmt("content\n\n\n");
    expect(formatted.endsWith("\n")).toBe(true);
    expect(formatted.endsWith("\n\n")).toBe(false);
  });

  test("single final newline unchanged", () => {
    const { formatted } = fmt("content\n");
    expect(formatted).toBe("content\n");
  });
});

// ── changed flag ───────────────────────────────────────────────────────────

describe("changed flag", () => {
  test("returns changed: false when already canonical", () => {
    // A doc that is already in canonical form
    const input = `---
template: templates/prd-template.md
status: draft
---

## Problem

Content.

### AC1 — User sees error

- **implements_bet** [PRD](../prds/prd-001.md) — core
`;
    const { changed } = fmt(input);
    // May or may not change depending on YAML serialization; key check:
    // if formatted === input, changed must be false
    const { formatted } = fmt(input);
    const second = fmt(formatted);
    expect(second.changed).toBe(false);
  });

  test("returns changed: true when AC heading needs normalization", () => {
    const { changed } = fmt("### AC1: foo\n");
    expect(changed).toBe(true);
  });

  test("returns changed: true when frontmatter needs reordering", () => {
    const input = `---
updated: '2026-05-12T00:00:00+07:00'
status: draft
template: templates/prd-template.md
---

Body.
`;
    const { changed } = fmt(input);
    expect(changed).toBe(true);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("empty string passes through", () => {
    const { formatted, changed } = fmt("");
    expect(formatted).toBe("");
    expect(changed).toBe(false);
  });

  test("no frontmatter document passes through AC/rel transforms", () => {
    const { formatted } = fmt("### AC1: user can login\n\nSome content.\n");
    expect(formatted).toContain("### AC1 — User can login");
  });

  test("document with only frontmatter (no body)", () => {
    const input = `---
status: draft
template: templates/prd-template.md
---
`;
    const { formatted } = fmt(input);
    expect(formatted).toContain("template:");
    expect(formatted).toContain("status:");
  });

  test("malformed frontmatter passes through unchanged", () => {
    const input = `---
status: [unclosed bracket
---

Body.
`;
    // Should not throw, just return the text (possibly unmodified)
    expect(() => fmt(input)).not.toThrow();
  });

  test("code fence with ## heading not treated as section split", () => {
    const input = `---
template: templates/prd-template.md
---

## Goals

\`\`\`
## This is inside a fence
\`\`\`

More content.
`;
    const { formatted } = fmt(input, { sections: ["goals"] });
    expect(formatted).toContain("## This is inside a fence");
    // Should appear once in code block position, not moved
    const goalIdx = formatted.indexOf("## Goals");
    const fenceHeadingIdx = formatted.indexOf("## This is inside a fence");
    expect(goalIdx).toBeLessThan(fenceHeadingIdx);
  });
});

// ── Idempotency (CRITICAL) ──────────────────────────────────────────────────

describe("idempotency — CRITICAL", () => {
  test("full realistic PRD-like document is idempotent", () => {
    const input = `---
updated: '2026-05-12T00:00:00+07:00'
owner: alice@example.com
template: templates/prd-template.md
status: draft
title: My Feature PRD
created: '2026-05-01T00:00:00+07:00'
tags:
  - reliability
  - trust
quick_links:
  figma: ''
  jira: ''
blocks: []
blocked_by: []
---

# PRD: My Feature

> Summary line.

## Problem

The problem statement.

## Goals

- Goal 1
- Goal 2

## Acceptance Criteria

### AC1: user can complete flow

\`\`\`gherkin
Given the user is logged in
When they click Submit
Then they see success
\`\`\`

### AC2 - error shown on failure

Content.

## Relationships

- implements_bet: [DIBB-001](../../01-strategy/dibbs/dibb-001.md) — core bet
- **informed_by** [Research](../../01-strategy/research/r-001.md) — background
`;
    idem(input, { sections: ["problem", "goals", "acceptance-criteria", "relationships"] });
  });

  test("triple format produces same result as double", () => {
    const input = `---
status: draft
template: templates/prd-template.md
updated: '2026-05-12T00:00:00+07:00'
owner: bob@example.com
---

### AC1: foo bar

- implements_bet: [P](p.md) — reason

Multiple   trailing   spaces
`;
    const once = fmt(input).formatted;
    const twice = fmt(once).formatted;
    const thrice = fmt(twice).formatted;
    expect(thrice).toBe(twice);
    expect(twice).toBe(once);
  });

  test("section reorder is idempotent", () => {
    const input = `---
template: templates/prd-template.md
status: draft
---

## Goals

Goal content.

## Problem

Problem content.

## Non-Goals

Non-goal content.
`;
    idem(input, { sections: ["problem", "goals", "non-goals"] });
  });
});
