import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot } from '../types'

const snap = atom({ plugin: 'linia-statusu', key: 'snap' } as const, null)

const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru']

// "claude-opus-5-5[1m]" -> "Opus 5.5"
export function modelLabel(id: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id
  const [, family = '', major = '', minor] = m
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

// zielony < 50%, żółty < 80%, czerwony od 80%
export function tone(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

export function dots(percent: number, total = 10): [string, string] {
  const full = Math.min(total, Math.max(0, Math.round(percent / (100 / total))))
  return ['●'.repeat(full), '○'.repeat(total - full)]
}

const pad = (n: number) => String(n).padStart(2, '0')

// 5h: "19:00"; tydzień: "10 lis, 10:00"
export function resetLabel(iso: string, withDate: boolean): string {
  const d = new Date(iso)
  const time = `${d.getHours()}:${pad(d.getMinutes())}`
  return withDate ? `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}` : time
}

// pierwsza linia `git status --porcelain --branch`: "## main...origin/main [ahead 1, behind 2]"
export function parseGit(stdout: string): Pick<Snapshot, 'branch' | 'isDirty' | 'ahead' | 'behind'> {
  const [head = '', ...rest] = stdout.split('\n').filter(Boolean)
  const name = head.replace(/^## /, '').replace(/^No commits yet on /, '').split('...')[0]?.split(' ')[0]
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  return {
    branch: name || undefined,
    isDirty: rest.length > 0,
    ...(ahead ? { ahead } : {}),
    ...(behind ? { behind } : {}),
  }
}

// "*" = niezacommitowane zmiany, ↑/↓ = commity do wypchnięcia / do pobrania (wg ostatniego fetch)
export function gitMarks(s: Pick<Snapshot, 'isDirty' | 'ahead' | 'behind'>): string {
  return `${s.isDirty ? '*' : ''}${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}`
}

// jeden wiersz dla $.ui.status: AbovePrompt rysują tylko terminal i desktop
export function statusLine(s: Snapshot): string {
  const lim = (label: string, l: Limit | undefined, withDate: boolean) =>
    l && `${label} ${Math.round(l.percent)}%${l.resetsAt ? ` ⟳ ${resetLabel(l.resetsAt, withDate)}` : ''}`
  return [
    `🧠 ${modelLabel(s.model)}`,
    `✍️ ${s.ctxPercent === undefined ? '–' : `${Math.round(s.ctxPercent)}%`}`,
    `📁 ${s.dir}${s.branch ? ` 🌿 ${s.branch}${gitMarks(s)}` : ''}`,
    lim('⏳ 5h', s.fiveHour, false),
    lim('📅 tydz.', s.sevenDay, true),
  ]
    .filter(Boolean)
    .join(' │ ')
}

async function refresh($: EngineInterface) {
  const [u, model, cwd] = await Promise.all([$.session.usage(), $.session.model(), $.session.cwd()])
  const git = await $.process
    .run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 })
    .then(r => (r.exitCode === 0 ? parseGit(r.stdout) : { isDirty: false }))
    .catch(() => ({ isDirty: false }))
  const limit = (kind: string): Limit | undefined => {
    const r = u.rateLimits.find(l => l.kind === kind)
    return r && { percent: r.percentUsed, resetsAt: r.resetsAt }
  }
  const next: Snapshot = {
    model,
    ctxPercent: u.context.percent,
    dir: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    ...git,
    fiveHour: limit('five_hour'),
    sevenDay: limit('seven_day'),
  }
  await update($, snap, () => next)
  const surfaces = await $.session.surfaces()
  $.ui.status(surfaces.some(x => x === 'mobile' || x === 'vscode') ? statusLine(next) : undefined)
}

// dopisywane do kompakcji bez własnych instrukcji, gdy CLAUDE.md projektu nie ma sekcji „Compact instructions"
export const COMPACT_INSTRUCTIONS =
  'Zachowaj: cel zadania i prośby użytkownika dosłownie, podjęte decyzje z uzasadnieniem, poprawki i preferencje ' +
  'zgłoszone przez użytkownika, gałąź i ostatnie commity, stan PR, zmienione pliki, nazwy padających testów, ' +
  'otwarte kroki i to, na co czeka użytkownik. Pomiń pełne wyjścia narzędzi, treść przeczytanych plików, ' +
  'przechodzące testy i porzucone próby.'

export function hasCompactSection(md: string): boolean {
  return /^#{1,6}\s*compact instructions\b/im.test(md)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await refresh($).catch(() => {})
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await refresh($).catch(() => {})
    return r
  })

  // gałąź i ↑/↓ od razu po checkout/commit/push zrobionym przez Claude'a, bez odpytywania w tle
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (/\bgit\b/.test(e.command)) await refresh($).catch(() => {})
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await refresh($).catch(() => {})
    return r
  })

  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    await refresh($).catch(() => {})
    return r
  })

  on('session.compact', async ($, e, next) => {
    let input = e
    if (!e.instructions && !e.agentId) {
      const md = await $.fs.read('CLAUDE.md').catch(() => '')
      if (!hasCompactSection(md)) input = { ...e, instructions: COMPACT_INSTRUCTIONS }
    }
    const r = await next(input)
    await refresh($).catch(() => {})
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const sep = <Text dimColor> │ </Text>

    const limit = (label: string, l: Limit | undefined, withDate: boolean) => {
      if (!l) return null
      const [full, empty] = dots(l.percent)
      const c = tone(l.percent)
      return (
        <Text>
          <Text>{label} </Text>
          <Text color={c}>{full}</Text>
          <Text color={c} dimColor>{empty}</Text>
          <Text color={c}> {`${Math.round(l.percent)}%`}</Text>
          {l.resetsAt && <Text dimColor> ⟳ </Text>}
          {l.resetsAt && <Text>{resetLabel(l.resetsAt, withDate)}</Text>}
        </Text>
      )
    }

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Box flexDirection="row" flexShrink={1} minWidth={0}>
            <Box flexShrink={0}>
              <Text>
                <Text color="suggestion">🧠 {modelLabel(s.model)}</Text>
                {sep}
                <Text>✍️ </Text>
                <Text color={s.ctxPercent === undefined ? undefined : tone(s.ctxPercent)}>
                  {s.ctxPercent === undefined ? '–' : `${Math.round(s.ctxPercent)}%`}
                </Text>
                {/* kropka stanu kontekstu zawsze widoczna (emoji ma własny kolor): 🟢 <50%, 🟡 <80%, 🔴 od 80% (wtedy /compact) */}
                <Text> {s.ctxPercent === undefined ? '⚪' : { success: '🟢', warning: '🟡', error: '🔴' }[tone(s.ctxPercent)]}</Text>
                {sep}
              </Text>
            </Box>
            {/* długi katalog/branch ucina się wielokropkiem, reszta wiersza zostaje w jednej linii */}
            <Box flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text color="ide">📁 {s.dir}</Text>
                {s.branch && <Text color="success"> 🌿 {s.branch}</Text>}
              </Text>
            </Box>
            {s.branch && gitMarks(s) && (
              <Box flexShrink={0}>
                <Text color="warning">{gitMarks(s)}</Text>
              </Box>
            )}
          </Box>
          <Text wrap="truncate-end">
            {limit('⏳ 5h', s.fiveHour, false)}
            {s.fiveHour && s.sevenDay && <Text dimColor>  │  </Text>}
            {limit('📅 tydz.', s.sevenDay, true)}
          </Text>
        </Box>
      </Box>
    )
  })
}
