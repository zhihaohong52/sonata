/**
 * The sonata-loop skill folder: the skill, and the mod Claude Code auto-loads
 * from a skills folder. Installed whole by `init`, refreshed whole by `sync`.
 * Tests and the engine's generated types are never copied.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface LoopSkillFile { rel: string; content: Buffer }

export function loopSkillSource(packageRoot: string): string {
  return existsSync(join(packageRoot, 'skills', 'loop', 'SKILL.md')) ? packageRoot : process.cwd();
}

export function loopSkillFiles(root: string): LoopSkillFile[] {
  const base = join(root, 'skills', 'loop');
  if (!existsSync(base)) return [];
  const out: LoopSkillFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(base, path).split(sep).join('/');
      if (rel === '.claude-plugin/types' || rel === 'node_modules') continue;
      if (entry.isDirectory()) walk(path);
      else if (!rel.endsWith('.test.ts')) out.push({ rel, content: readFileSync(path) });
    }
  };
  walk(base);
  // Code-point order, so the listing is the same under every locale.
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function writeLoopSkill(dir: string, files: LoopSkillFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const path = join(dir, file.rel);
    if (existsSync(path) && readFileSync(path).equals(file.content)) continue;
    mkdirSync(dirname(path), { recursive: true });
    // Temp file + rename, so an interrupted write never leaves half a file.
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, file.content);
      renameSync(tmp, path);
      written.push(path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return written;
}
