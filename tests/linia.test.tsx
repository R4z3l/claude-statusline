import { expect, test } from 'claude-code/testing'

import { COMPACT_INSTRUCTIONS, dots, gitMarks, hasCompactSection, modelLabel, parseGit, resetLabel, statusLine, tone } from '../hooks/register'

const BAND = {
  plugin: 'linia-statusu',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('formatowanie', async () => {
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(dots(28)).toEqual(['●●●', '○○○○○○○'])
  expect(dots(79)).toEqual(['●●●●●●●●', '○○'])
  expect(dots(100)).toEqual(['●●●●●●●●●●', ''])
  expect(tone(49)).toBe('success')
  expect(tone(50)).toBe('warning')
  expect(tone(80)).toBe('error')
  expect(resetLabel(new Date(2026, 10, 10, 10, 0).toISOString(), true)).toBe('10 lis, 10:00')
  expect(resetLabel(new Date(2026, 10, 3, 19, 5).toISOString(), false)).toBe('19:05')
  expect(parseGit('## main...origin/main [ahead 1]\n M a.js\n')).toEqual({ branch: 'main', isDirty: true, ahead: 1 })
  expect(parseGit('## main...origin/main [ahead 12, behind 3]\n')).toEqual({ branch: 'main', isDirty: false, ahead: 12, behind: 3 })
  expect(parseGit('## main...origin/main [behind 2]\n')).toEqual({ branch: 'main', isDirty: false, behind: 2 })
  expect(gitMarks({ isDirty: true, ahead: 1, behind: 2 })).toBe('* ↑1 ↓2')
  expect(gitMarks({ isDirty: false })).toBe('')
  expect(parseGit('## feature\n')).toEqual({ branch: 'feature', isDirty: false })
})

test('dwa wiersze: model/kontekst/katalog/stan + compact, limity 5h i tydz.', async ($, on) => {
  let submitted = ''
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: 'C:\\repo\\keynote' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '## main\n M x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 760_000, window: 1_000_000, percent: 76 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 28, resetsAt: new Date(2026, 10, 3, 19, 0).toISOString() },
        { kind: 'seven_day', percentUsed: 79, resetsAt: new Date(2026, 10, 10, 10, 0).toISOString() },
      ],
    },
  }))
  on('command.run', (_, e) => {
    submitted = e.command
    return {}
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Opus 5\.5/ }))?.text).toMatch(/🧠 Opus 5\.5.*76%/)
    expect((await ui.find({ type: 'Text', text: /keynote/ }))?.text).toMatch(/📁 keynote 🌿 main/)
    expect((await ui.find({ type: 'Text', text: /^\*/ }))?.text).toBe('*')
    expect(await ui.find({ type: 'Text', text: /idle|thinking/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toMatch(/5h ●●●○{7} 28% ⟳ 19:00 +│ +📅 tydz\. ●{8}○○ 79% ⟳ 10 lis, 10:00/)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect(submitted).toBe('compact')
  await ui.unmount()
})

test('wiersz statusu tylko gdy podpięty mobile/vscode', async ($, on) => {
  const statuses: (string | undefined)[] = []
  let surfaces: ('terminal' | 'desktop' | 'mobile')[] = ['desktop']
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/user/repo' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 400_000, window: 1_000_000, percent: 40 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 28, resetsAt: new Date(2026, 10, 3, 19, 0).toISOString() }],
    },
  }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(statuses.at(-1)).toBe(undefined)

  surfaces = ['desktop', 'mobile']
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  expect(statuses.at(-1)).toBe('🧠 Opus 5.5 │ ✍️ 40% │ 📁 repo 🌿 main │ ⏳ 5h 28% ⟳ 19:00')
  expect(statusLine({ model: 'x', dir: 'd', isDirty: false })).toBe('🧠 x │ ✍️ – │ 📁 d')
})

const MSGS = [{ role: 'user' as const, text: 'x', toolUses: [] }]

test('kompakcja: uniwersalne instrukcje tylko bez własnych i bez sekcji w CLAUDE.md', async ($, on) => {
  let claudeMd: string | undefined
  let seen: string | undefined = 'nie wywołano'
  on('fs.read', () => (claudeMd === undefined ? Promise.reject(new Error('brak')) : { value: claudeMd }))
  on('session.compact', (_, e) => {
    seen = e.instructions
    return { messages: MSGS }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1, percent: 0 }, rateLimits: [] } }))

  await $.session.compact({ trigger: 'manual', messages: MSGS })
  expect(seen).toBe(COMPACT_INSTRUCTIONS)

  await $.session.compact({ trigger: 'manual', messages: [], instructions: 'tylko plan' })
  expect(seen).toBe('tylko plan')

  claudeMd = '# Projekt\n\n# Compact instructions\n\nZachowaj gałąź.'
  await $.session.compact({ trigger: 'manual', messages: MSGS })
  expect(seen).toBe(undefined)

  expect(hasCompactSection('## compact instructions')).toBe(true)
  expect(hasCompactSection('tekst o compact instructions')).toBe(false)
})

test('odświeżenie gałęzi po poleceniu git w Bash, nie po innych', async ($, on) => {
  let gitRuns = 0
  on('tool.call', () => ({ result: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => {
    gitRuns++
    return { value: { exitCode: 0, stdout: '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(gitRuns).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'git checkout -b nowa' })
  expect(gitRuns).toBe(1)
})
