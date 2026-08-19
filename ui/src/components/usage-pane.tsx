import { useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"

// Which skills and tools the session invoked, and what was loaded — the
// view for trimming a harness. Data comes from the usage endpoint, derived
// from the records; Codex numbers are a floor, since its MCP calls and
// skill reads are found by pattern inside exec code.

type UsageRow = { name: string; count: number; seqs: number[] }
type Usage = {
  provider: string
  approximate: boolean
  skills: UsageRow[]
  mcp: { server: string; count: number; tools: UsageRow[] }[]
  builtin: UsageRow[]
  loaded: {
    tools_total: number
    mcp_servers: string[]
    builtin: string[]
    skills: string[] | null
  } | null
}

const CHIP_CAP = 30

function SeqChips({
  seqs,
  name,
  current,
  onJump,
}: {
  seqs: number[]
  name: string
  current: number
  onJump?: (seq: number, name: string) => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? seqs : seqs.slice(0, CHIP_CAP)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((s) => (
        <button
          key={s}
          onClick={() => onJump?.(s, name)}
          className={cn(
            "hover:bg-accent hover:text-foreground rounded border px-1 font-mono text-[10px]",
            s === current ? "text-foreground bg-accent" : "text-muted-foreground"
          )}
        >
          #{s}
        </button>
      ))}
      {!all && seqs.length > CHIP_CAP ? (
        <button
          onClick={() => setAll(true)}
          className="text-primary text-[10px] underline underline-offset-2"
        >
          +{seqs.length - CHIP_CAP} more
        </button>
      ) : null}
    </span>
  )
}

function UsageRows({
  rows,
  current,
  onJump,
}: {
  rows: UsageRow[]
  current: number
  onJump?: (seq: number, name: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.name} className="flex items-start gap-3">
          <span className="w-56 shrink-0 truncate font-mono text-xs">{r.name}</span>
          <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-xs">
            {r.count}×
          </span>
          <SeqChips seqs={r.seqs} name={r.name} current={current} onJump={onJump} />
        </div>
      ))}
    </div>
  )
}

export function UsagePane({
  file,
  currentSeq,
  onJump,
}: {
  file: string
  currentSeq: number
  onJump?: (seq: number, name: string) => void
}) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setUsage(null)
    setFailed(false)
    fetch("/__wire/api/usage/" + encodeURIComponent(file))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setUsage)
      .catch(() => setFailed(true))
  }, [file])

  if (failed)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Could not load usage</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  if (!usage) return <p className="text-muted-foreground p-4 text-sm">Reading the session…</p>

  const usedServers = new Set(usage.mcp.map((m) => m.server))
  const unusedServers = (usage.loaded?.mcp_servers ?? []).filter((s) => !usedServers.has(s))
  const usedSkills = new Set(usage.skills.map((s) => s.name))
  const unusedSkills = (usage.loaded?.skills ?? []).filter((s) => !usedSkills.has(s))

  return (
    <div className="flex flex-col gap-6 p-4">
      {usage.approximate ? (
        <p className="text-muted-foreground text-xs">
          Codex hides MCP calls and skill reads inside exec code, so these are found by
          pattern — counts are a floor, not an exact number.
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Skills used ({usage.skills.length})</h3>
        {usage.skills.length ? (
          <UsageRows rows={usage.skills} current={currentSeq} onJump={onJump} />
        ) : (
          <p className="text-muted-foreground text-sm">None detected in this session.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">MCP tools used ({usage.mcp.length} servers)</h3>
        {usage.mcp.length ? (
          usage.mcp.map((m) => (
            <div key={m.server} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium">{m.server}</span>
                <Badge variant="secondary">{m.count} calls</Badge>
              </div>
              <div className="pl-4">
                <UsageRows rows={m.tools} current={currentSeq} onJump={onJump} />
              </div>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground text-sm">None detected in this session.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Other tools used</h3>
        <UsageRows rows={usage.builtin} current={currentSeq} onJump={onJump} />
      </section>

      {usage.loaded ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Loaded vs used</h3>
          <p className="text-muted-foreground text-xs">
            What the newest conversation call offered the model, against what the session
            actually invoked. The unused part is what a leaner harness would drop.
          </p>
          <div className="flex flex-col gap-1 font-mono text-xs">
            <span>
              {usage.loaded.tools_total} tool definitions on the wire ·{" "}
              {usage.loaded.mcp_servers.length} MCP servers ·{" "}
              {usage.loaded.builtin.length} others
            </span>
            {unusedServers.length ? (
              <span className="text-muted-foreground">
                loaded, never used: {unusedServers.join(", ")}
              </span>
            ) : usage.loaded.mcp_servers.length ? (
              <span className="text-muted-foreground">every loaded MCP server was used</span>
            ) : null}
            {usage.loaded.skills ? (
              <span className="text-muted-foreground">
                {usage.loaded.skills.length} skills offered
                {unusedSkills.length
                  ? ` — unused: ${unusedSkills.slice(0, 20).join(", ")}${unusedSkills.length > 20 ? "…" : ""}`
                  : " — all used"}
              </span>
            ) : (
              <span className="text-muted-foreground">
                skills offered: not detectable in this capture
              </span>
            )}
          </div>
        </section>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No conversation call</EmptyTitle>
            <EmptyDescription>This file holds only background jobs.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}
