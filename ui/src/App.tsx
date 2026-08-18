import { useCallback, useEffect, useState } from "react"
import { MoonIcon, RefreshCwIcon, SunIcon, Trash2Icon } from "lucide-react"

import { CallDetail } from "@/components/call-detail"
import { Explain } from "@/components/explain"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import {
  fmtBytes,
  fmtMs,
  fmtNum,
  fmtTime,
  type CallSummary,
  type SessionInfo,
  type WireRecord,
} from "@/lib/wire"

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch("/__wire/api" + path, init)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// Deleting a record is the only write the viewer performs. Records pile up
// fast — a working session is tens of megabytes — and clearing before a run
// is the simplest way to look at one session on its own.
function ConfirmDelete({
  title,
  description,
  onConfirm,
  children,
}: {
  title: string
  description: string
  onConfirm: () => void
  children: React.ReactNode
}) {
  // AlertDialogAction is a plain button, not a Close, so the dialog has to be
  // controlled or it stays open after the action runs.
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={children as never} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// A session file belongs to one client. Say which, in words a reader knows.
const CLIENTS: Record<string, { label: string; short: string }> = {
  anthropic: { label: "Claude Code", short: "claude" },
  codex: { label: "Codex", short: "codex" },
  openai: { label: "OpenAI", short: "openai" },
}
const clientOf = (p?: string) => CLIENTS[p ?? "anthropic"] ?? CLIENTS.anthropic

// The file name is <date>_<session id>, and for Codex it also carries the
// client prefix. Neither is worth reading, so show the tail only.
function shortId(file: string) {
  const id = file.replace(/\.ndjson$/, "").replace(/^\d{4}-\d{2}-\d{2}_/, "")
  return id.replace(/^(codex|openai)-/, "").slice(0, 8)
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  )
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  const dark = theme === "dark" || (theme === "system" && systemDark)
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Switch to light" : "Switch to dark"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [session, setSession] = useState<string | null>(null)
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [seq, setSeq] = useState<number | null>(null)
  const [client, setClient] = useState<string>("all")
  const [detail, setDetail] = useState<{
    call: WireRecord
    prev: WireRecord | null
    comparable: WireRecord | null
  } | null>(null)

  const refresh = useCallback(async () => {
    const list = await api<SessionInfo[]>("/sessions")
    setSessions(list)
    if (session) {
      try {
        setCalls(await api<CallSummary[]>("/session/" + encodeURIComponent(session)))
      } catch {
        setSession(null)
        setCalls([])
        setSeq(null)
        setDetail(null)
      }
    }
  }, [session])

  useEffect(() => {
    refresh().catch(() => {})
    const t = setInterval(() => refresh().catch(() => {}), 3000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (session == null || seq == null) return
    api<{ call: WireRecord; prev: WireRecord | null; comparable: WireRecord | null }>(
      `/call/${encodeURIComponent(session)}/${seq}`
    )
      .then(setDetail)
      .catch(() => setDetail(null))
  }, [session, seq])

  const forget = async (file: string) => {
    await api(`/session/${encodeURIComponent(file)}`, { method: "DELETE" }).catch(() => {})
    if (session === file) {
      setSession(null)
      setCalls([])
      setSeq(null)
      setDetail(null)
    }
    refresh().catch(() => {})
  }

  const forgetAll = async () => {
    await api("/sessions", { method: "DELETE" }).catch(() => {})
    setSession(null)
    setCalls([])
    setSeq(null)
    setDetail(null)
    refresh().catch(() => {})
  }

  const pickSession = (file: string) => {
    setSession(file)
    setSeq(null)
    setDetail(null)
    api<CallSummary[]>("/session/" + encodeURIComponent(file))
      .then((list) => {
        setCalls(list)
        // Open on the newest conversation call — the one with tools — so a
        // reader lands on the discussion, not on a background job.
        const conv = [...list].reverse().find((c) => c.tools > 0) ?? list[list.length - 1]
        if (conv) setSeq(conv.seq)
      })
      .catch(() => setCalls([]))
  }

  return (
    <div className="bg-background text-foreground flex h-svh flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <span className="text-primary font-mono text-xs font-medium tracking-widest uppercase">
          agent-tap
        </span>
        <span className="text-muted-foreground text-xs">
          what your agent actually sends to the API
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs">
            {sessions?.length ?? 0} sessions
          </span>
          <Button variant="ghost" size="icon" onClick={() => refresh()} aria-label="Refresh">
            <RefreshCwIcon />
          </Button>
          <ConfirmDelete
            title="Delete every captured session?"
            description="All records are removed from disk, so the next session you start is the only one in the list. The proxy keeps running and stays routed."
            onConfirm={forgetAll}
          >
            <Button variant="ghost" size="icon" aria-label="Clear all sessions">
              <Trash2Icon />
            </Button>
          </ConfirmDelete>
          <ThemeSwitch />
        </div>
      </header>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="20" minSize="14">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <Tabs value={client} onValueChange={setClient} className="shrink-0 p-2 pb-0">
              <TabsList className="w-full">
                <TabsTrigger value="all">
                  All ({sessions?.length ?? 0})
                </TabsTrigger>
                <TabsTrigger value="anthropic">
                  Claude ({(sessions ?? []).filter((s) => (s.provider ?? "anthropic") === "anthropic").length})
                </TabsTrigger>
                <TabsTrigger value="codex">
                  Codex ({(sessions ?? []).filter((s) => s.provider === "codex").length})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col p-2">
              {sessions == null ? (
                <div className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : sessions.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Nothing captured</EmptyTitle>
                    <EmptyDescription>
                      Run <code className="font-mono">wiretap on</code>, then start a new session.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                sessions
                  .filter(
                    (s) => client === "all" || (s.provider ?? "anthropic") === client
                  )
                  .map((s) => (
                    <div
                      key={s.file}
                      className={cn(
                        "group hover:bg-accent relative rounded-md",
                        session === s.file && "bg-accent"
                      )}
                    >
                      <button
                        onClick={() => pickSession(s.file)}
                        className="flex w-full flex-col gap-1 px-2 py-2 text-left"
                      >
                        <span className="flex items-center gap-2">
                          <Badge variant={s.provider === "codex" ? "secondary" : "outline"}>
                            {clientOf(s.provider).label}
                          </Badge>
                          <span className="text-muted-foreground truncate font-mono text-[11px]">
                            {shortId(s.file)}
                          </span>
                        </span>
                        <span className="truncate font-mono text-xs">{s.model ?? "–"}</span>
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {fmtTime(s.mtime)} · {s.calls} calls · {fmtBytes(s.bytes)}
                        </span>
                      </button>
                      <ConfirmDelete
                        title="Delete this session?"
                        description={`${s.calls} calls, ${fmtBytes(s.bytes)}. The file is removed from disk and cannot be recovered.`}
                        onConfirm={() => forget(s.file)}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete session"
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100"
                        >
                          <Trash2Icon />
                        </Button>
                      </ConfirmDelete>
                    </div>
                  ))
              )}
            </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="22" minSize="15">
          <ScrollArea className="h-full">
            <div className="flex flex-col p-2">
              {!session ? (
                <p className="text-muted-foreground p-3 text-sm">Pick a session.</p>
              ) : calls.length === 0 ? (
                <p className="text-muted-foreground p-3 text-sm">No calls yet.</p>
              ) : (
                calls.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSeq(c.seq)}
                    className={cn(
                      "hover:bg-accent flex flex-col gap-1 rounded-md px-2 py-2 text-left",
                      seq === c.seq && "bg-accent"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">#{c.seq}</span>
                      <span className="truncate font-mono text-xs">{c.model}</span>
                      {c.status !== 200 ? (
                        <Badge variant="destructive">{c.status}</Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {fmtTime(c.ts)} · {c.tools} tools · {c.messages} msg · {fmtMs(c.took_ms)}
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      <Explain term="cache_read">read {fmtNum(c.usage.cache_read)}</Explain>
                      {" · "}
                      <Explain term="cache_write">write {fmtNum(c.usage.cache_write)}</Explain>
                      {" · "}
                      <Explain term="output">out {fmtNum(c.usage.output)}</Explain>
                    </span>
                    {c.tool_calls.length ? (
                      <span className="text-primary truncate font-mono text-[11px]">
                        → {c.tool_calls.join(", ")}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="60" minSize="30">
          {detail ? (
            <CallDetail call={detail.call} prev={detail.comparable} />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>Pick a call</EmptyTitle>
                <EmptyDescription>
                  One prompt produces several API calls. The one with a large tool count is the
                  conversation; the others are background jobs.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default App
