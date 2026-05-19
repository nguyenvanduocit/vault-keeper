import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');

function listSkillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function readSkill(name) {
  const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(skillPath)) return null;
  return { path: skillPath, raw: readFileSync(skillPath, 'utf8') };
}

describe('skills-lint', () => {
  const skillNames = listSkillDirs();

  test('at least the 6 v0.8.0 skills are present', () => {
    const required = ['vault.setup', 'vault.new', 'vault.health', 'vault.fix', 'vault.sync', 'vault.monitor-git-sync'];
    for (const name of required) {
      expect(skillNames).toContain(name);
    }
  });

  for (const name of skillNames) {
    describe(`skills/${name}`, () => {
      const skill = readSkill(name);

      test('SKILL.md exists', () => {
        expect(skill).not.toBeNull();
      });

      test('frontmatter has name + description', () => {
        const { data } = matter(skill.raw);
        expect(data.name).toBe(name);
        expect(typeof data.description).toBe('string');
        expect(data.description.length).toBeGreaterThan(20);
      });

      test('cross-references resolve to actual skill dirs', () => {
        const body = matter(skill.raw).content;
        const refs = [...body.matchAll(/\/vault\.[a-z][a-z0-9.-]*/g)].map(m => m[0].slice(1));
        for (const ref of refs) {
          const refName = ref.split(/[\s<`]/)[0];
          if (refName === name) continue;
          expect(skillNames).toContain(refName);
        }
      });
    });
  }
});
