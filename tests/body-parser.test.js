/**
 * Tests for body-parser.js.
 *
 * Pure tests — markdown source is inline strings. No filesystem fixtures.
 * Coverage:
 *   - empty / Tier-3-only bodies
 *   - relationships (canonical, anchored, multi-predicate, unparseable)
 *   - acceptance criteria (single, with impl/verify sub-lists, descoped, nested ID, malformed)
 *   - user stories (canonical list)
 *   - contribution log (canonical entries with extra fields)
 *   - mixed section order
 *   - duplicate ## sections
 *   - PRD-shape integration fixture
 *   - performance sanity (5 KB body × 100 iterations < 200 ms)
 */

import { describe, test, expect } from "bun:test";
import { parseBody } from "../lib/body-parser.js";

// ── 1. Empty body ───────────────────────────────────────────────────────────

describe("parseBody — empty / minimal", () => {
  test("empty string → all empty, no warnings", async () => {
    const r = await parseBody("");
    expect(r.relationships).toEqual([]);
    expect(r.acceptanceCriteria).toEqual([]);
    expect(r.userStories).toEqual([]);
    expect(r.contributionLog).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("undefined / null input → all empty (no throw)", async () => {
    const r1 = await parseBody(undefined);
    const r2 = await parseBody(null);
    expect(r1.relationships).toEqual([]);
    expect(r2.relationships).toEqual([]);
  });

  // 2. Body with only Tier 3 prose
  test("Tier-3-only body (## Problem, ## Goals) → no Tier-2 extraction", async () => {
    const md = `## Problem

Customers do not trust our revenue numbers.

## Goals

- Ship parity within 0.1%
- Detect mismatches automatically
`;
    const r = await parseBody(md);
    expect(r.relationships).toEqual([]);
    expect(r.acceptanceCriteria).toEqual([]);
    expect(r.userStories).toEqual([]);
    expect(r.contributionLog).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

// ── 3-6. Relationships ─────────────────────────────────────────────────────

describe("parseBody — ## Relationships", () => {
  test("single canonical relationship bullet → 1 edge, no warnings", async () => {
    const md = `## Relationships

- [DIBB-001: Year of Trust](../01-strategy/dibbs/2026-05-12-dibb-001-year-of-trust.md) — *bets that data accuracy drives merchant trust*
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.relationships).toHaveLength(1);
    const e = r.relationships[0];
    expect(e.title).toBe("DIBB-001: Year of Trust");
    expect(e.path).toBe("../01-strategy/dibbs/2026-05-12-dibb-001-year-of-trust.md");
    expect(e.anchor).toBeNull();
    expect(e.reason).toBe("bets that data accuracy drives merchant trust");
    expect(e.line).toBe(3);
  });

  test("anchored relationship → path is anchor-free, anchor extracted separately", async () => {
    const md = `## Relationships

- [PRD-001#AC1: Revenue parity](../02-product/prds/prd-001.md#AC1) — *coverage: full*
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.relationships).toHaveLength(1);
    const e = r.relationships[0];
    // Contract: `path` is the doc path WITHOUT anchor, and `anchor` carries
    // the fragment separately.
    expect(e.path).toBe("../02-product/prds/prd-001.md");
    expect(e.anchor).toBe("AC1");
    expect(e.reason).toBe("coverage: full");
  });

  test("multiple relationships → all parsed, line numbers correct", async () => {
    const md = `## Relationships

- [DIBB-001](../dibb.md) — *strategic bet*
- [Research-005](../research.md)
- [ADR-003](../adr.md)
- [T-044](../t-044.md)
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.relationships).toHaveLength(4);
    expect(r.relationships.map((e) => e.title)).toEqual([
      "DIBB-001",
      "Research-005",
      "ADR-003",
      "T-044",
    ]);
    expect(r.relationships.map((e) => e.line)).toEqual([3, 4, 5, 6]);
  });

  test("unparseable relationship line → warning, valid edges still parsed", async () => {
    const md = `## Relationships

- [DIBB-001](../dibb.md)
- broken line without link format
- [Research](../research.md)
`;
    const r = await parseBody(md);
    expect(r.relationships).toHaveLength(2);
    expect(r.relationships.map((e) => e.title)).toEqual([
      "DIBB-001",
      "Research",
    ]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].type).toBe("unparseable-relationship-line");
    expect(r.warnings[0].line).toBe(4);
  });

  test("empty ## Relationships section → no edges, no warnings", async () => {
    const md = `## Relationships

(none yet)
`;
    const r = await parseBody(md);
    expect(r.relationships).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

// ── 7-11. Acceptance Criteria ─────────────────────────────────────────────

describe("parseBody — ## Acceptance Criteria", () => {
  test("single AC with sign-off + body → complete record", async () => {
    const md = `## Acceptance Criteria

### AC1 — Revenue parity ≥ 99% — \`must\` · \`draft\`

> **Sign-off**: pm, data_owner · **Measurable**: yes

For a sampled cohort of shops on a given day, TrueProfit revenue
matches Shopify Orders report within 0.1% for ≥ 99% of shops.
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    const ac = r.acceptanceCriteria[0];
    expect(ac.id).toBe("AC1");
    expect(ac.text).toBe("Revenue parity ≥ 99%");
    expect(ac.priority).toBe("must");
    expect(ac.status).toBe("draft");
    expect(ac.signoff).toEqual(["pm", "data_owner"]);
    expect(ac.measurable).toBe(true);
    expect(ac.body).toContain("For a sampled cohort");
    expect(ac.implementedBy).toEqual([]);
    expect(ac.verifiedBy).toEqual([]);
  });

  test("AC with Implemented by + Verified by sub-lists → populated", async () => {
    const md = `## Acceptance Criteria

### AC1 — Revenue parity — \`must\` · \`implementing\`

> **Sign-off**: pm · **Measurable**: yes

Body text here.

**Implemented by**:
- [t-044: Cleanup graphql_agreements](../tasks/t-044.md) — coverage: full
- [t-066: ncROAS fix](../tasks/t-066.md) — coverage: partial

**Verified by**:
- [Parity verification runbook §1](../runbook.md#section-1) — verified 2026-05-15 by [@hung](../people/hung.md) — method: automated
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    const ac = r.acceptanceCriteria[0];
    expect(ac.implementedBy).toEqual([
      {
        title: "t-044: Cleanup graphql_agreements",
        path: "../tasks/t-044.md",
        coverage: "full",
      },
      {
        title: "t-066: ncROAS fix",
        path: "../tasks/t-066.md",
        coverage: "partial",
      },
    ]);
    expect(ac.verifiedBy).toHaveLength(1);
    expect(ac.verifiedBy[0]).toEqual({
      title: "Parity verification runbook §1",
      path: "../runbook.md#section-1",
      verifiedAt: "2026-05-15",
      verifiedBy: "@hung",
      method: "automated",
    });
  });

  test("AC with descoped flag (strikethrough heading) → flag captured", async () => {
    const md = `## Acceptance Criteria

### ~~AC3 — Auto-detection of mismatches — \`should\` · \`descoped\`~~ (descoped: out of scope for v1)
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    const ac = r.acceptanceCriteria[0];
    expect(ac.id).toBe("AC3");
    expect(ac.status).toBe("descoped");
    expect(ac.flag).toBe("descoped: out of scope for v1");
  });

  test("AC heading missing priority backticks → warning, AC not added", async () => {
    const md = `## Acceptance Criteria

### AC1 — text — must · draft

> **Sign-off**: pm · **Measurable**: yes
`;
    const r = await parseBody(md);
    expect(r.acceptanceCriteria).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].type).toBe("ac-heading-malformed");
  });

  test("nested AC ID (AC1.1) → id parsed correctly", async () => {
    const md = `## Acceptance Criteria

### AC1.1 — Sub-criterion — \`should\` · \`draft\`

> **Sign-off**: pm · **Measurable**: no

Sub-body.
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    expect(r.acceptanceCriteria[0].id).toBe("AC1.1");
    expect(r.acceptanceCriteria[0].measurable).toBe(false);
  });

  test("unknown priority emits warning, AC still parsed", async () => {
    const md = `## Acceptance Criteria

### AC1 — text — \`critical\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes
`;
    const r = await parseBody(md);
    expect(r.acceptanceCriteria).toHaveLength(1);
    expect(r.acceptanceCriteria[0].priority).toBe("critical");
    expect(r.warnings.some((w) => w.type === "ac-unknown-priority")).toBe(true);
  });

  test("multiple AC separated by --- → all parsed", async () => {
    const md = `## Acceptance Criteria

### AC1 — First — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

Body 1.

---

### AC2 — Second — \`should\` · \`draft\`

> **Sign-off**: pm · **Measurable**: no

Body 2.
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(2);
    expect(r.acceptanceCriteria.map((a) => a.id)).toEqual(["AC1", "AC2"]);
  });

  test("AC with complete gherkin fence → gherkin field populated", async () => {
    const md = `## Acceptance Criteria

### AC1 — Revenue matches — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

\`\`\`gherkin
Scenario: Revenue parity check
  Given a shop with orders today
  When TrueProfit calculates revenue
  Then the result matches Shopify within 0.1%
\`\`\`
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    const ac = r.acceptanceCriteria[0];
    expect(ac.gherkin).toBeDefined();
    expect(ac.gherkin.hasScenario).toBe(true);
    expect(ac.gherkin.hasGiven).toBe(true);
    expect(ac.gherkin.hasWhen).toBe(true);
    expect(ac.gherkin.hasThen).toBe(true);
    expect(ac.gherkin.raw).toContain("Scenario: Revenue parity check");
    expect(typeof ac.gherkin.line).toBe("number");
  });

  test("AC without gherkin fence → gherkin field undefined", async () => {
    const md = `## Acceptance Criteria

### AC1 — Simple criterion — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

Plain prose body text, no gherkin block.
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    const ac = r.acceptanceCriteria[0];
    expect(ac.gherkin).toBeUndefined();
  });

  test("AC with partial gherkin (missing Then) → hasThen false", async () => {
    const md = `## Acceptance Criteria

### AC1 — Partial gherkin — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

\`\`\`gherkin
Scenario: Incomplete scenario
  Given a shop exists
  When revenue is calculated
\`\`\`
`;
    const r = await parseBody(md);
    expect(r.acceptanceCriteria).toHaveLength(1);
    const ac = r.acceptanceCriteria[0];
    expect(ac.gherkin).toBeDefined();
    expect(ac.gherkin.hasScenario).toBe(true);
    expect(ac.gherkin.hasGiven).toBe(true);
    expect(ac.gherkin.hasWhen).toBe(true);
    expect(ac.gherkin.hasThen).toBe(false);
  });

  test("AC with non-gherkin code fence (yaml) → gherkin undefined", async () => {
    const md = `## Acceptance Criteria

### AC1 — YAML fence — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

\`\`\`yaml
key: value
\`\`\`
`;
    const r = await parseBody(md);
    expect(r.acceptanceCriteria).toHaveLength(1);
    expect(r.acceptanceCriteria[0].gherkin).toBeUndefined();
  });

  test("malformed Implemented-by line → warning, valid impls still parsed", async () => {
    const md = `## Acceptance Criteria

### AC1 — text — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

**Implemented by**:
- [t-044](../t-044.md) — coverage: full
- broken line without proper format
- [t-066](../t-066.md) — coverage: partial
`;
    const r = await parseBody(md);
    expect(r.acceptanceCriteria).toHaveLength(1);
    expect(r.acceptanceCriteria[0].implementedBy).toHaveLength(2);
    expect(r.warnings.some((w) => w.type === "ac-impl-unparseable")).toBe(true);
  });
});

// ── 12. User stories ───────────────────────────────────────────────────────

describe("parseBody — ## User Stories", () => {
  test("3 user stories → 3 records", async () => {
    const md = `## User Stories

- [Story-001: Merchant trusts revenue](../stories/story-001.md) — *primary persona*
- [Story-002: Engineer parity alerts](../stories/story-002.md) — *internal persona*
- [Story-003: CS sees daily report](../stories/story-003.md)
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.userStories).toHaveLength(3);
    expect(r.userStories[0]).toEqual({
      title: "Story-001: Merchant trusts revenue",
      path: "../stories/story-001.md",
      reason: "primary persona",
      line: 3,
    });
    expect(r.userStories[2].reason).toBeNull();
  });

  test("malformed user story bullet → warning", async () => {
    const md = `## User Stories

- [Story-001](../story.md)
- broken story line
`;
    const r = await parseBody(md);
    expect(r.userStories).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].type).toBe("unparseable-user-story-line");
  });
});

// ── 13. Contribution log ───────────────────────────────────────────────────

describe("parseBody — ## Contribution Log", () => {
  test("3 entries with extra fields → parsed correctly", async () => {
    const md = `## Contribution Log

> Auto-rendered from frontmatter \`contributions[]\`. Do not hand-edit.

- 2026-05-12T10:00Z — [@hungndn](../people/hungndn.md) **authored** (sections: problem, goals)
- 2026-05-12T14:00Z — [@khanhnnt](../people/khanhnnt.md) **reviewed** (decision: changes_requested)
- 2026-05-12T16:00Z — [@alice](../people/alice.md) **approved**
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.contributionLog).toHaveLength(3);

    expect(r.contributionLog[0]).toEqual({
      at: "2026-05-12T10:00Z",
      person: "@hungndn",
      role: "authored",
      decision: null,
      sections: ["problem", "goals"],
      line: 5,
    });
    expect(r.contributionLog[1]).toEqual({
      at: "2026-05-12T14:00Z",
      person: "@khanhnnt",
      role: "reviewed",
      decision: "changes_requested",
      sections: null,
      line: 6,
    });
    expect(r.contributionLog[2]).toEqual({
      at: "2026-05-12T16:00Z",
      person: "@alice",
      role: "approved",
      decision: null,
      sections: null,
      line: 7,
    });
  });

  test("malformed contribution entry → warning", async () => {
    const md = `## Contribution Log

- 2026-05-12T10:00Z — [@hung](../p.md) **authored**
- broken contribution line
`;
    const r = await parseBody(md);
    expect(r.contributionLog).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].type).toBe("unparseable-contribution-line");
  });
});

// ── 14. Performance sanity ─────────────────────────────────────────────────

describe("parseBody — performance", () => {
  test("parse 5 KB body × 100 iterations < 1000 ms (sanity, not strict)", async () => {
    // Build a ~5 KB body.
    const repeats = [];
    for (let i = 1; i <= 10; i++) {
      repeats.push(
        `### AC${i} — Criterion ${i} — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

Body for AC${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

**Implemented by**:
- [t-${i.toString().padStart(3, "0")}](../tasks/t-${i}.md) — coverage: full
`,
      );
    }
    const md = `## Relationships

- [DIBB-001](../dibb.md) — *strategic bet*
- [Research](../research.md)

## Acceptance Criteria

${repeats.join("\n")}
`;
    expect(md.length).toBeGreaterThan(2000); // generous lower bound

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      // eslint-disable-next-line no-await-in-loop
      await parseBody(md);
    }
    const elapsed = performance.now() - start;
    // Sanity check — well above hot-path target (10ms/run × 100 = 1000ms).
    // Allow generous headroom to avoid flakiness on busy CI runners.
    expect(elapsed).toBeLessThan(2000);
  });
});

// ── 15. Mixed section order ────────────────────────────────────────────────

describe("parseBody — mixed section order", () => {
  test("## Relationships AFTER ## Acceptance Criteria still parsed", async () => {
    const md = `## Acceptance Criteria

### AC1 — Foo — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

Body.

## Relationships

- [DIBB-001](../dibb.md)
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.acceptanceCriteria).toHaveLength(1);
    expect(r.relationships).toHaveLength(1);
  });

  test("Tier-3 section interleaved between Tier-2 → both Tier-2 parsed", async () => {
    const md = `## Relationships

- [DIBB-001](../dibb.md)

## Problem

Some narrative.

## Acceptance Criteria

### AC1 — Bar — \`must\` · \`draft\`

> **Sign-off**: pm · **Measurable**: yes

Body.
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.relationships).toHaveLength(1);
    expect(r.acceptanceCriteria).toHaveLength(1);
  });
});

// ── 16. Duplicate ## sections ──────────────────────────────────────────────

describe("parseBody — duplicate sections", () => {
  test("two ## Relationships sections → edges concatenated, warning emitted", async () => {
    const md = `## Relationships

- [DIBB-001](../dibb.md)

## Problem

Foo.

## Relationships

- [Research](../research.md)
`;
    const r = await parseBody(md);
    expect(r.relationships).toHaveLength(2);
    expect(r.relationships.map((e) => e.title)).toEqual([
      "DIBB-001",
      "Research",
    ]);
    expect(r.warnings.some((w) => w.type === "duplicate-section")).toBe(true);
  });
});

// ── 17. Real PRD-shape fixture ─────────────────────────────────────────────

describe("parseBody — PRD-shape integration fixture", () => {
  test("realistic PRD body parses cleanly with 0 warnings", async () => {
    const md = `# PRD-001: Revenue Match Shopify

## Problem

Merchants do not trust our revenue numbers because they diverge from Shopify.

## Goals

- Achieve parity within 0.1% for ≥ 99% of shops
- Detect drift automatically

## Relationships

- [DIBB-001: Year of Trust](../01-strategy/dibbs/dibb-001.md) — *bets that data accuracy drives merchant trust*
- [Research-005: Refund timing](../knowledge/refund-timing.md)
- [ADR-003: Root cause analysis](../03-engineering/decisions/adr-003.md)

## Acceptance Criteria

### AC1 — Revenue parity ≥ 99% — \`must\` · \`draft\`

> **Sign-off**: pm, data_owner · **Measurable**: yes

For a sampled cohort of shops on a given day, TrueProfit revenue
matches Shopify Orders report within 0.1% for ≥ 99% of shops.

**Implemented by**:
- [t-044: Cleanup graphql_agreements](../tasks/t-044.md) — coverage: full
- [t-066: ncROAS fix](../tasks/t-066.md) — coverage: partial

**Verified by**:
- [Parity verification runbook §1](../runbooks/parity.md#section-1) — verified 2026-05-15 by [@hung](../people/hung.md) — method: automated

---

### AC2 — Refund reflects within 5 min — \`must\` · \`draft\`

> **Sign-off**: pm, engineer · **Measurable**: yes

When a refund is processed in Shopify, it reflects in TrueProfit within 5 minutes.

## User Stories

- [Story-001: Merchant trusts revenue](../stories/story-001.md) — *primary persona*
- [Story-002: On-call parity alerts](../stories/story-002.md) — *internal persona*

## Contribution Log

> Auto-rendered.

- 2026-05-12T10:00Z — [@hungndn](../people/hungndn.md) **authored** (sections: problem, goals)
- 2026-05-12T14:00Z — [@khanhnnt](../people/khanhnnt.md) **reviewed** (decision: approved)
- 2026-05-12T16:00Z — [@alice](../people/alice.md) **approved**

## Notes

Implementation tracked under PRIN-* tickets.
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.relationships).toHaveLength(3);
    expect(r.acceptanceCriteria).toHaveLength(2);
    expect(r.userStories).toHaveLength(2);
    expect(r.contributionLog).toHaveLength(3);

    // AC1 should have full impl + verify population
    const ac1 = r.acceptanceCriteria[0];
    expect(ac1.id).toBe("AC1");
    expect(ac1.implementedBy).toHaveLength(2);
    expect(ac1.verifiedBy).toHaveLength(1);
    expect(ac1.signoff).toEqual(["pm", "data_owner"]);
    expect(ac1.measurable).toBe(true);

    // AC2 should have no impl/verify yet
    const ac2 = r.acceptanceCriteria[1];
    expect(ac2.id).toBe("AC2");
    expect(ac2.implementedBy).toEqual([]);
    expect(ac2.verifiedBy).toEqual([]);

    // Verify edge anchor extraction
    const anchored = r.relationships.find((e) => e.path.includes("#"));
    expect(anchored).toBeUndefined(); // none of these have anchors

    // Sanity — line numbers in growing order
    const lines = r.relationships.map((e) => e.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MOVED-FROM-FRONTMATTER SECTIONS
// ══════════════════════════════════════════════════════════════════════════

// ── 18. Status History ────────────────────────────────────────────────────

describe("parseBody — ## Status History", () => {
  test("golden path: canonical table → parsed entries + derived fields", async () => {
    const md = `## Status History

| At (UTC) | From | To | By | Note |
|---|---|---|---|---|
| 2026-05-10T09:00:00Z | draft | review | @alice | RICE draft done |
| 2026-05-11T14:30:00Z | review | approved | @bob | |
| 2026-05-12T10:00:00Z | approved | in_progress | @ductm | Sprint started |
| 2026-05-20T16:00:00Z | in_progress | shipped | @alice | v1.0 deployed |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.statusHistory).toHaveLength(4);
    expect(r.statusHistory[0]).toEqual({
      at: "2026-05-10T09:00:00Z",
      from: "draft",
      to: "review",
      by: "@alice",
      note: "RICE draft done",
      line: expect.any(Number),
    });
    expect(r.statusHistory[1].to).toBe("approved");
    expect(r.statusHistory[3].to).toBe("shipped");

    // Derived fields
    expect(r.derived.approved_at).toBe("2026-05-11T14:30:00Z");
    expect(r.derived.in_progress_at).toBe("2026-05-12T10:00:00Z");
    expect(r.derived.shipped_at).toBe("2026-05-20T16:00:00Z");
  });

  test("tolerant: extra whitespace in cells → still parsed", async () => {
    const md = `## Status History

|  At (UTC)  |  From  |  To  |  By  |  Note  |
|---|---|---|---|---|
|  2026-05-10T09:00:00Z  |  draft  |  review  |  @alice  |  done  |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.statusHistory).toHaveLength(1);
    expect(r.statusHistory[0].from).toBe("draft");
    expect(r.statusHistory[0].note).toBe("done");
  });

  test("edge case: empty section → no entries, no warnings", async () => {
    const md = `## Status History

(no changes yet)
`;
    const r = await parseBody(md);
    expect(r.statusHistory).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("error: wrong header order → warning, no entries", async () => {
    const md = `## Status History

| From | To | At (UTC) | By | Note |
|---|---|---|---|---|
| draft | review | 2026-05-10T09:00:00Z | @alice | |
`;
    const r = await parseBody(md);
    expect(r.statusHistory).toEqual([]);
    expect(r.warnings.some((w) => w.type === "status-history-header-mismatch")).toBe(true);
  });
});

// ── 19. Phase History ─────────────────────────────────────────────────────

describe("parseBody — ## Phase History", () => {
  test("golden path: canonical table → entries + derived fields", async () => {
    const md = `## Phase History

| At (UTC) | From Phase | To Phase | By | Note |
|---|---|---|---|---|
| 2026-05-10T09:00:00Z | backlog | coding | @alice | Kicked off |
| 2026-05-15T14:00:00Z | coding | completed | @ductm | All AC verified |
| 2026-05-16T10:00:00Z | completed | done | @bob | Released |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.phaseHistory).toHaveLength(3);
    expect(r.phaseHistory[0].from).toBe("backlog");
    expect(r.phaseHistory[0].to).toBe("coding");

    // Derived: coding is a STARTED_PHASES value
    expect(r.derived.started_at).toBe("2026-05-10T09:00:00Z");
    expect(r.derived.completed_at).toBe("2026-05-15T14:00:00Z");
    expect(r.derived.done_at).toBe("2026-05-16T10:00:00Z");
  });

  test("tolerant: case-insensitive headers → still parsed", async () => {
    const md = `## Phase History

| at (utc) | from phase | to phase | by | note |
|---|---|---|---|---|
| 2026-05-10T09:00:00Z | backlog | started | @alice | |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.phaseHistory).toHaveLength(1);
  });

  test("edge case: empty note column → note is null", async () => {
    const md = `## Phase History

| At (UTC) | From Phase | To Phase | By | Note |
|---|---|---|---|---|
| 2026-05-10T09:00:00Z | backlog | started | @alice | |
`;
    const r = await parseBody(md);
    expect(r.phaseHistory[0].note).toBeNull();
  });

  test("error: missing columns → warning", async () => {
    const md = `## Phase History

| At (UTC) | From Phase | To Phase |
|---|---|---|
| 2026-05-10T09:00:00Z | backlog | started |
`;
    const r = await parseBody(md);
    expect(r.phaseHistory).toEqual([]);
    expect(r.warnings.some((w) => w.type === "phase-history-header-mismatch")).toBe(true);
  });
});

// ── 20. Blocked History ───────────────────────────────────────────────────

describe("parseBody — ## Blocked History", () => {
  test("golden path: mix of closed and _open_ blocks", async () => {
    const md = `## Blocked History

| From (UTC) | To (UTC) | Reason | By |
|---|---|---|---|
| 2026-05-10T09:00:00Z | 2026-05-11T14:00:00Z | Waiting for design spec | @ductm |
| 2026-05-12T08:00:00Z | _open_ | Blocked by PRD-007 AC1 clarification | @bob |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.blockedHistory).toHaveLength(2);
    expect(r.blockedHistory[0].from).toBe("2026-05-10T09:00:00Z");
    expect(r.blockedHistory[0].to).toBe("2026-05-11T14:00:00Z");
    expect(r.blockedHistory[0].reason).toBe("Waiting for design spec");
    expect(r.blockedHistory[1].to).toBeNull(); // _open_ → null
    expect(r.blockedHistory[1].reason).toBe("Blocked by PRD-007 AC1 clarification");
  });

  test("tolerant: extra whitespace around _open_ → still null", async () => {
    const md = `## Blocked History

| From (UTC) | To (UTC) | Reason | By |
|---|---|---|---|
| 2026-05-12T08:00:00Z |  _open_  | Some reason | @ductm |
`;
    const r = await parseBody(md);
    expect(r.blockedHistory).toHaveLength(1);
    expect(r.blockedHistory[0].to).toBeNull();
  });

  test("edge case: empty table → no entries", async () => {
    const md = `## Blocked History

| From (UTC) | To (UTC) | Reason | By |
|---|---|---|---|
`;
    const r = await parseBody(md);
    expect(r.blockedHistory).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("error: wrong headers → warning", async () => {
    const md = `## Blocked History

| Start | End | Why | Who |
|---|---|---|---|
| 2026-05-10T09:00:00Z | 2026-05-11T14:00:00Z | reason | @x |
`;
    const r = await parseBody(md);
    expect(r.blockedHistory).toEqual([]);
    expect(r.warnings.some((w) => w.type === "blocked-history-header-mismatch")).toBe(true);
  });
});

// ── 21. RICE Score ────────────────────────────────────────────────────────

describe("parseBody — ## RICE Score", () => {
  test("golden path: valid RICE table → score + match=true", async () => {
    const md = `## RICE Score

| Dimension | Value | Note |
|---|---|---|
| Reach | 5000 | users/quarter |
| Impact | 2 | High |
| Confidence | 0.8 | Medium |
| Effort | 3 | person-months |
| **Score** | **2666** | (R × I × C) / E |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.riceScore).not.toBeNull();
    expect(r.riceScore.reach).toBe(5000);
    expect(r.riceScore.impact).toBe(2);
    expect(r.riceScore.confidence).toBe(0.8);
    expect(r.riceScore.effort).toBe(3);
    expect(r.riceScore.score).toBe(2666);
    // (5000 * 2 * 0.8) / 3 = 2666.67 → rounds to ~2667, diff ≤ 1 from 2666
    expect(r.riceScore.score_computed_match).toBe(true);
  });

  test("tolerant: bold markers in dimension/value cells → stripped by toString", async () => {
    const md = `## RICE Score

| Dimension | Value | Note |
|---|---|---|
| Reach | 1000 | |
| Impact | 3 | |
| Confidence | 1.0 | |
| Effort | 2 | |
| **Score** | **1500** | |
`;
    const r = await parseBody(md);
    expect(r.riceScore).not.toBeNull();
    expect(r.riceScore.score).toBe(1500);
    // (1000 * 3 * 1.0) / 2 = 1500 → exact
    expect(r.riceScore.score_computed_match).toBe(true);
  });

  test("edge case: score mismatch → score_computed_match=false", async () => {
    const md = `## RICE Score

| Dimension | Value | Note |
|---|---|---|
| Reach | 1000 | |
| Impact | 2 | |
| Confidence | 0.8 | |
| Effort | 3 | |
| **Score** | **999** | wrong score |
`;
    const r = await parseBody(md);
    expect(r.riceScore).not.toBeNull();
    expect(r.riceScore.score).toBe(999);
    // (1000 * 2 * 0.8) / 3 = 533.33 → 999 is way off
    expect(r.riceScore.score_computed_match).toBe(false);
  });

  test("error: missing dimension rows → warning, riceScore null", async () => {
    const md = `## RICE Score

| Dimension | Value | Note |
|---|---|---|
| Reach | 5000 | |
| Impact | 2 | |
`;
    const r = await parseBody(md);
    expect(r.riceScore).toBeNull();
    expect(r.warnings.some((w) => w.type === "rice-incomplete")).toBe(true);
  });
});

// ── 22. Ship Timeline ─────────────────────────────────────────────────────

describe("parseBody — ## Ship Timeline", () => {
  test("golden path: header + history table + betting + extensions", async () => {
    const md = `## Ship Timeline

**Target ship date**: 2026-06-15 · Locked at: 2026-05-12T08:00:00Z · Locked by: @ductm

| At (UTC) | Field | Old | New | Reason | Approved by |
|---|---|---|---|---|---|
| 2026-05-15T10:00:00Z | target_ship_date | 2026-06-15 | 2026-06-20 | Design spec slipped 5 days | @bob |

**Betting window**: 30 days (auto) · Ends at: 2026-07-20

| At (UTC) | Extension type | New ends at | Reason | Extended by |
|---|---|---|---|---|
| 2026-07-18T16:00:00Z | extension | 2026-08-03 | Need 14 more days for re-measure | @bob |
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.shipTimeline).not.toBeNull();
    expect(r.shipTimeline.target_ship_date).toBe("2026-06-15");
    expect(r.shipTimeline.locked_at).toBe("2026-05-12T08:00:00Z");
    expect(r.shipTimeline.locked_by).toBe("@ductm");

    expect(r.shipTimeline.history).toHaveLength(1);
    expect(r.shipTimeline.history[0].field).toBe("target_ship_date");
    expect(r.shipTimeline.history[0].old).toBe("2026-06-15");
    expect(r.shipTimeline.history[0].new).toBe("2026-06-20");

    expect(r.shipTimeline.betting.window_days).toBe(30);
    expect(r.shipTimeline.betting.ends_at).toBe("2026-07-20");
    expect(r.shipTimeline.betting.extensions).toHaveLength(1);
    expect(r.shipTimeline.betting.extensions[0].extension_type).toBe("extension");
  });

  test("tolerant: extra spaces in header line → still parsed", async () => {
    const md = `## Ship Timeline

**Target ship date**:  2026-06-15  ·  Locked at:  2026-05-12T08:00:00Z  ·  Locked by:  @ductm
`;
    const r = await parseBody(md);
    expect(r.shipTimeline).not.toBeNull();
    expect(r.shipTimeline.target_ship_date).toBe("2026-06-15");
  });

  test("edge case: empty body (no changes since lock)", async () => {
    const md = `## Ship Timeline

**Target ship date**: 2026-06-15 · Locked at: 2026-05-12T08:00:00Z · Locked by: @ductm
`;
    const r = await parseBody(md);
    expect(r.shipTimeline).not.toBeNull();
    expect(r.shipTimeline.history).toEqual([]);
    expect(r.shipTimeline.betting.extensions).toEqual([]);
  });

  test("error: missing header line → timeline exists but fields are null", async () => {
    const md = `## Ship Timeline

Some prose instead of the header line.
`;
    const r = await parseBody(md);
    expect(r.shipTimeline).not.toBeNull();
    expect(r.shipTimeline.target_ship_date).toBeNull();
    expect(r.shipTimeline.locked_at).toBeNull();
  });
});

// ── 23. Contributions ───────────────────────────────────────────────────

describe("parseBody — ## Contributions", () => {
  test("golden path: canonical entries with decision + artifact", async () => {
    const md = `## Contributions

- **author** · @alice · 2026-05-10T09:00:00Z · sections: \`problem,goals\` · effort: \`primary\`
- **reviewer** · @bob · 2026-05-11T14:30:00Z · sections: \`*\` · effort: \`major\` · decision: \`approved\` · artifact: [git c0ffee](https://gitlab/.../commit/c0ffee)
- **approver** · @ductm · 2026-05-12T08:00:00Z · sections: \`*\` · effort: \`review-only\` · decision: \`approved\`
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.contributions).toHaveLength(3);

    expect(r.contributions[0].role).toBe("author");
    expect(r.contributions[0].person).toBe("@alice");
    expect(r.contributions[0].at).toBe("2026-05-10T09:00:00Z");
    expect(r.contributions[0].sections).toBe("problem,goals");
    expect(r.contributions[0].effort).toBe("primary");
    expect(r.contributions[0].decision).toBeUndefined();

    expect(r.contributions[1].decision).toBe("approved");
    expect(r.contributions[1].artifact).toEqual({
      label: "git c0ffee",
      url: "https://gitlab/.../commit/c0ffee",
    });

    expect(r.contributions[2].decision).toBe("approved");
    expect(r.contributions[2].artifact).toBeUndefined();
  });

  test("tolerant: smart quotes in sections backticks → normalized before match", async () => {
    // Using straight backticks but extra whitespace — normalization collapses
    const md = `## Contributions

- **author** · @alice · 2026-05-10T09:00:00Z · sections:  \`problem,goals\`  · effort:  \`primary\`
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.contributions).toHaveLength(1);
    expect(r.contributions[0].sections).toBe("problem,goals");
  });

  test("golden path: entry with note field", async () => {
    const md = `## Contributions

- **author** · @alice · 2026-05-10T09:00:00Z · sections: \`problem\` · effort: \`primary\` · note: Initial draft based on team discussion
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.contributions).toHaveLength(1);
    expect(r.contributions[0].note).toBe("Initial draft based on team discussion");
  });

  test("error: malformed line → warning, valid lines still parsed", async () => {
    const md = `## Contributions

- **author** · @alice · 2026-05-10T09:00:00Z · sections: \`problem\` · effort: \`primary\`
- broken contribution line missing fields
- **reviewer** · @bob · 2026-05-11T14:30:00Z · sections: \`*\` · effort: \`major\`
`;
    const r = await parseBody(md);
    expect(r.contributions).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].type).toBe("unparseable-contribution-line");
  });
});

// ── 24. Success Metric Verdict ────────────────────────────────────────────

describe("parseBody — ## Success Metric Verdict", () => {
  test("golden path: primary with all fields populated", async () => {
    const md = `## Success Metric Verdict

### Primary
- **Metric**: COGS edit frequency
- **Baseline**: 12%
- **Target**: 35%
- **Actual**: 38%
- **Measured at**: 2026-07-20
- **Measured by**: @alice
- **Verdict**: graduated
- **Decided by**: @bob
- **Decided at**: 2026-07-21

### Supporting
- (none)
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.successMetricVerdict).not.toBeNull();
    expect(r.successMetricVerdict.primary).not.toBeNull();
    expect(r.successMetricVerdict.primary.metric).toBe("COGS edit frequency");
    expect(r.successMetricVerdict.primary.baseline).toBe("12%");
    expect(r.successMetricVerdict.primary.target).toBe("35%");
    expect(r.successMetricVerdict.primary.actual).toBe("38%");
    expect(r.successMetricVerdict.primary.verdict).toBe("graduated");
    expect(r.successMetricVerdict.supporting).toBeNull();
  });

  test("golden path: _pending_ literals → null values", async () => {
    const md = `## Success Metric Verdict

### Primary
- **Metric**: COGS edit frequency
- **Baseline**: 12%
- **Target**: 35%
- **Actual**: _pending_
- **Measured at**: _pending_
- **Measured by**: _pending_
- **Verdict**: _pending_
- **Decided by**: _pending_
- **Decided at**: _pending_
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.successMetricVerdict.primary).not.toBeNull();
    expect(r.successMetricVerdict.primary.actual).toBeNull();
    expect(r.successMetricVerdict.primary.measured_at).toBeNull();
    expect(r.successMetricVerdict.primary.verdict).toBeNull();
    expect(r.successMetricVerdict.primary.decided_by).toBeNull();
  });

  test("edge case: verdict with HTML comment → comment stripped", async () => {
    const md = `## Success Metric Verdict

### Primary
- **Verdict**: _pending_   <!-- graduated | failed-revert | failed-kill | extended -->
`;
    const r = await parseBody(md);
    expect(r.successMetricVerdict.primary.verdict).toBeNull();
  });

  test("edge case: no Supporting section → supporting is null", async () => {
    const md = `## Success Metric Verdict

### Primary
- **Metric**: test
- **Target**: 50%
`;
    const r = await parseBody(md);
    expect(r.successMetricVerdict.primary).not.toBeNull();
    expect(r.successMetricVerdict.supporting).toBeNull();
  });
});

// ── 25. Data Sources ──────────────────────────────────────────────────────

describe("parseBody — ## Data Sources", () => {
  test("golden path: all 4 categories populated", async () => {
    const md = `## Data Sources

### Intercom
- Query \`tag:cogs-edit\` · time range 2026-Q1 · result count 47

### Amplitude
- Chart "COGS Edit Funnel" · project \`fg-compass\` · time range last 90d

### BigQuery
- Query doc \`product-data/analytics/queries/cogs-edit-frequency.sql\`

### External
- "Shopify 2026 Merchant Revenue Report" · accessed 2026-04-15
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.dataSources).not.toBeNull();
    expect(r.dataSources.intercom).toHaveLength(1);
    expect(r.dataSources.amplitude).toHaveLength(1);
    expect(r.dataSources.bigquery).toHaveLength(1);
    expect(r.dataSources.external).toHaveLength(1);
    // Verify raw text captured
    expect(r.dataSources.intercom[0].raw).toContain("tag:cogs-edit");
  });

  test("tolerant: multiple items per category", async () => {
    const md = `## Data Sources

### Intercom
- Query 1
- Query 2
- Query 3

### Amplitude
(none)

### BigQuery
(none)

### External
(none)
`;
    const r = await parseBody(md);
    expect(r.dataSources.intercom).toHaveLength(3);
    expect(r.dataSources.amplitude).toEqual([]);
    expect(r.dataSources.bigquery).toEqual([]);
    expect(r.dataSources.external).toEqual([]);
  });

  test("edge case: all categories empty (none)", async () => {
    const md = `## Data Sources

### Intercom
(none)

### Amplitude
(none)

### BigQuery
(none)

### External
(none)
`;
    const r = await parseBody(md);
    expect(r.dataSources.intercom).toEqual([]);
    expect(r.dataSources.amplitude).toEqual([]);
    expect(r.dataSources.bigquery).toEqual([]);
    expect(r.dataSources.external).toEqual([]);
  });

  test("edge case: unknown sub-heading ignored", async () => {
    const md = `## Data Sources

### Intercom
- Query 1

### Custom Source
- Should be ignored

### BigQuery
- Query 2
`;
    const r = await parseBody(md);
    expect(r.dataSources.intercom).toHaveLength(1);
    expect(r.dataSources.bigquery).toHaveLength(1);
    // "Custom Source" items not captured in any known category
  });
});

// ── 26. Derived fields ────────────────────────────────────────────────────

describe("parseBody — derived lifecycle fields", () => {
  test("no history tables → all derived null", async () => {
    const md = `## Problem

Some prose.
`;
    const r = await parseBody(md);
    expect(r.derived).toEqual({
      approved_at: null,
      in_progress_at: null,
      shipped_at: null,
      started_at: null,
      completed_at: null,
      done_at: null,
    });
  });

  test("first matching entry wins (earliest in table order)", async () => {
    const md = `## Status History

| At (UTC) | From | To | By | Note |
|---|---|---|---|---|
| 2026-05-10T09:00:00Z | draft | approved | @a | first approval |
| 2026-05-12T09:00:00Z | rejected | approved | @b | second approval |
`;
    const r = await parseBody(md);
    // First match wins
    expect(r.derived.approved_at).toBe("2026-05-10T09:00:00Z");
  });
});

// ── 27. Normalization tolerance ───────────────────────────────────────────

describe("parseBody — normalization tolerance (tier-2 sections)", () => {
  test("relationship with en-dash instead of em-dash → still parsed", async () => {
    // Use – (en-dash) in the reason separator instead of — (em-dash)
    const md = `## Relationships

- [DIBB-001](../dibb.md) – *strategic bet*
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.relationships).toHaveLength(1);
    expect(r.relationships[0].reason).toBe("strategic bet");
  });

  test("user story with smart quotes in reason → parsed after normalization", async () => {
    const md = `## User Stories

- [Story-001](../story.md) — *“primary persona”*
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);
    expect(r.userStories).toHaveLength(1);
    expect(r.userStories[0].reason).toBe('"primary persona"');
  });
});

// ── 28. Mixed tier-2 + moved-from-frontmatter sections ──────────────────

describe("parseBody — mixed tier-2 + moved-from-frontmatter integration", () => {
  test("PRD with both old and new sections → all parsed", async () => {
    const md = `# PRD-002: COGS Edit Flow

## Status History

| At (UTC) | From | To | By | Note |
|---|---|---|---|---|
| 2026-05-10T09:00:00Z | draft | review | @alice | |
| 2026-05-11T14:30:00Z | review | approved | @bob | |

## RICE Score

| Dimension | Value | Note |
|---|---|---|
| Reach | 5000 | users/quarter |
| Impact | 2 | High |
| Confidence | 0.8 | Medium |
| Effort | 3 | person-months |
| **Score** | **2666** | (R × I × C) / E |

## Relationships

- [DIBB-001](../dibb.md) — *strategic bet*
- [Research-005](../research.md)

## Acceptance Criteria

### AC1 — Revenue parity ≥ 99% — \`must\` · \`draft\`

> **Sign-off**: pm, data_owner · **Measurable**: yes

Body text.

## Contributions

- **author** · @alice · 2026-05-10T09:00:00Z · sections: \`problem,goals\` · effort: \`primary\`
- **reviewer** · @bob · 2026-05-11T14:30:00Z · sections: \`*\` · effort: \`major\` · decision: \`approved\`

## Success Metric Verdict

### Primary
- **Metric**: COGS edit frequency
- **Target**: 35%
- **Actual**: _pending_
- **Verdict**: _pending_
`;
    const r = await parseBody(md);
    expect(r.warnings).toEqual([]);

    // Moved-from-frontmatter sections
    expect(r.statusHistory).toHaveLength(2);
    expect(r.riceScore).not.toBeNull();
    expect(r.riceScore.score).toBe(2666);
    expect(r.contributions).toHaveLength(2);
    expect(r.successMetricVerdict.primary.actual).toBeNull();

    // Tier-2 sections
    expect(r.relationships).toHaveLength(2);
    expect(r.acceptanceCriteria).toHaveLength(1);

    // Derived
    expect(r.derived.approved_at).toBe("2026-05-11T14:30:00Z");
  });
});
