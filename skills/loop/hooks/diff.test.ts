import { test, expect } from 'claude-code/testing'
import { hunksFor, addHunks, diffStat, spawnAgent, HUNK_LINES, MAX_HUNKS } from './model'

test('an Edit becomes one hunk with every line of both sides', () => {
  const [h] = hunksFor('Edit', { file_path: '/r/a.ts', old_string: 'x\ny', new_string: 'x\ny\nz', replace_all: true })
  expect(h).toEqual({ file: '/r/a.ts', removed: ['x', 'y'], added: ['x', 'y', 'z'], omitted: 0, isNewFile: false })
})

test('a Write is a whole-file hunk, capped at 40 lines', () => {
  const content = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')
  const [h] = hunksFor('Write', { file_path: '/r/b.ts', content })
  expect(h.isNewFile).toBe(true)
  expect(h.added).toHaveLength(HUNK_LINES)
  expect(h.omitted).toBe(60)
})

test('other tools and malformed input give no hunk', () => {
  expect(hunksFor('Read', { file_path: '/r/a.ts' })).toEqual([])
  expect(hunksFor('Edit', { file_path: '/r/a.ts' })).toEqual([])
})

test('an agent keeps its last 30 hunks, and a Write after an Edit stays separate', () => {
  let agents = spawnAgent({ loop: null, agents: [] }, { agentId: 'a', subagentType: 'code-simple', description: 'x' }, 0).agents
  for (let i = 0; i < 35; i++) agents = addHunks(agents, 'a', hunksFor('Edit', { file_path: `/r/${i}.ts`, old_string: 'a', new_string: 'b' }))
  agents = addHunks(agents, 'a', hunksFor('Write', { file_path: '/r/34.ts', content: 'new' }))
  expect(agents[0].hunks).toHaveLength(MAX_HUNKS)
  expect(agents[0].hunks.at(-1)).toMatchObject({ file: '/r/34.ts', isNewFile: true })
  expect(agents[0].hunks.at(-2)).toMatchObject({ file: '/r/34.ts', isNewFile: false })
  expect(diffStat(agents[0].hunks)).toEqual({ added: 30, removed: 29, files: 29 })
})
