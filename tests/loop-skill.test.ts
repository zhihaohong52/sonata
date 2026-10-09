import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLoopSkill, loopSkillFiles, writeLoopSkill } from '../src/loop-skill.js';

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

  // Claude Code loads one plugin per name and lets the user-level copy shadow
  // the project's, reporting the project's as a load error. The mod therefore
  // lives at one level: the user's, when there is one.
  it('writes the skill alone into a project copy shadowed by a user-level copy, removing the old mod', () => {
    const files = loopSkillFiles(fakePackage());
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    writeLoopSkill(join(home, '.claude', 'skills', 'sonata-loop'), files);
    const project = join(mkdtempSync(join(tmpdir(), 'proj-')), '.claude', 'skills', 'sonata-loop');
    writeLoopSkill(project, files);
    installLoopSkill(project, files, home);
    expect(existsSync(join(project, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.claude-plugin'))).toBe(false);
    expect(existsSync(join(project, 'hooks'))).toBe(false);
  });

  it('writes the whole folder when there is no user-level copy, and at the user level itself', () => {
    const files = loopSkillFiles(fakePackage());
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'proj-')), '.claude', 'skills', 'sonata-loop');
    installLoopSkill(project, files, home);
    expect(existsSync(join(project, '.claude-plugin', 'plugin.json'))).toBe(true);
    const user = join(home, '.claude', 'skills', 'sonata-loop');
    installLoopSkill(user, files, home);
    expect(existsSync(join(user, 'hooks', 'register.tsx'))).toBe(true);
  });
});
