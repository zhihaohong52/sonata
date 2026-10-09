import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopSkillFiles, writeLoopSkill } from '../src/loop-skill.js';

function fakePackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'loop-skill-'));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, 'skills/loop', rel, '..'), { recursive: true });
    writeFileSync(join(root, 'skills/loop', rel), text);
  };
  put('SKILL.md', '# skill');
  put('.claude-plugin/plugin.json', '{"name":"sonata-loop"}');
  put('hooks/register.tsx', 'export const register = () => {}');
  put('hooks/model.test.ts', 'test');
  put('.claude-plugin/types/claude-code/index.d.ts', 'generated');
  return root;
}

describe('loop skill folder', () => {
  it('lists the plugin files and leaves out tests and generated types', () => {
    const rels = loopSkillFiles(fakePackage()).map((f) => f.rel);
    expect(rels).toEqual(['.claude-plugin/plugin.json', 'SKILL.md', 'hooks/register.tsx']);
  });

  it('writes the whole folder and skips unchanged files on a second write', () => {
    const files = loopSkillFiles(fakePackage());
    const dir = join(mkdtempSync(join(tmpdir(), 'loop-dest-')), 'sonata-loop');
    expect(writeLoopSkill(dir, files)).toHaveLength(3);
    expect(readFileSync(join(dir, 'hooks/register.tsx'), 'utf8')).toContain('register');
    expect(existsSync(join(dir, 'hooks/model.test.ts'))).toBe(false);
    expect(writeLoopSkill(dir, files)).toEqual([]);
  });

  it('lists nothing, rather than throwing, when the package has no skill folder', () => {
    expect(loopSkillFiles(mkdtempSync(join(tmpdir(), 'no-skill-')))).toEqual([]);
  });
});
