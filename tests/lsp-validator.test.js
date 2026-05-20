/**
 * Tests for server/validator.js#validateBuffer — the LSP-side per-buffer
 * validation pipeline (operates on in-memory text, no vault scan).
 *
 * Focus: the built-in `section-rules` fence leak rule. validateBuffer must
 *   - flag a `yaml section-rules` fence in a document buffer, with the
 *     diagnostic line pointing at the offending fence;
 *   - leave a clean document untouched;
 *   - skip template buffers entirely (the fence is legitimate there).
 */

import { describe, test, expect } from "bun:test";
import { validateBuffer } from "../server/validator.js";

const FENCE = "```yaml section-rules";

/** Build a frontmatter + body buffer string. */
function buffer(body) {
  return `---\ntemplate: templates/note-template.md\n---\n${body}`;
}

describe("validateBuffer — section-rules fence leak", () => {
  test("document buffer with the fence → section-rules-leak diagnostic", async () => {
    const text = buffer(
      ["## Acceptance Criteria", "", FENCE, "required: true", "```", ""].join(
        "\n",
      ),
    );

    const { issues, skipped } = await validateBuffer({
      text,
      filepath: "product-knowledge/notes/my-note.md",
      projectRoot: process.cwd(),
    });

    expect(skipped).toBe(false);
    const leaks = issues.filter((i) => i.error_type === "section-rules-leak");
    expect(leaks).toHaveLength(1);
    expect(leaks[0].level).toBe("error");
    expect(leaks[0].field).toBe("body");

    // The diagnostic line must point at the offending fence — verified
    // against the actual buffer, not a hand-counted constant.
    const docLines = text.split("\n");
    expect(docLines[leaks[0].line]).toBe(FENCE);
  });

  test("clean document buffer → no section-rules-leak diagnostic", async () => {
    const text = buffer(
      ["## Notes", "", "```yaml", "key: value", "```", ""].join("\n"),
    );

    const { issues } = await validateBuffer({
      text,
      filepath: "product-knowledge/notes/my-note.md",
      projectRoot: process.cwd(),
    });

    expect(
      issues.filter((i) => i.error_type === "section-rules-leak"),
    ).toHaveLength(0);
  });

  test("template buffer carrying the fence is skipped, not flagged", async () => {
    const text = `---\ntemplate_id: prd\n---\n${[
      "## Acceptance Criteria",
      "",
      FENCE,
      "required: true",
      "```",
    ].join("\n")}`;

    const { issues, skipped } = await validateBuffer({
      text,
      filepath: "templates/prd-template.md",
      projectRoot: process.cwd(),
    });

    expect(skipped).toBe(true);
    expect(issues).toEqual([]);
  });
});
