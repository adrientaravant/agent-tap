import { useCallback, useEffect, useState } from "react"
import {
  ArrowDownUpIcon,
  CheckIcon,
  CopyIcon,
  MoonIcon,
  RadioIcon,
  RefreshCwIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react"

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

// The viewer answers no questions itself: it has no model and no key. The
// detective is an agent the user already runs, pointed at the record file.
// This builds the prompt that makes that a one-paste move.
function detectivePrompt(dir: string, file: string) {
  return [
    `Read the captured agent session in ${dir}/${file} and answer my questions about it.`,
    ``,
    `The file is NDJSON: one API call per line, in time order. Each record has`,
    `request.system (system prompt blocks), request.tools (tool schemas),`,
    `request.messages (the conversation; a Codex record uses request.input instead),`,
    `and response (reply text, tool calls, usage). The conversation grows call by`,
    `call, so the last record with a large tool list holds the whole exchange —`,
    `read that one first, and use earlier records to see how a turn changed things.`,
    `The file can be large: locate with grep, then read around the match.`,
    ``,
    `Answer from the file only, and cite the seq number of the record you used.`,
    `If the file does not show it, say so.`,
    ``,
    `My first question: `,
  ].join("\n")
}

function AskAgentButton({ dir, file }: { dir: string | null; file: string }) {
  const [copied, setCopied] = useState(false)
  if (!dir) return null
  return (
    <Explain term="ask_agent">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-6 gap-1 px-2 text-[11px]"
        onClick={() => {
          navigator.clipboard.writeText(detectivePrompt(dir, file)).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {copied ? "copied" : "ask an agent"}
      </Button>
    </Explain>
  )
}

// A session file belongs to one client. Say which, in words a reader knows.
const CLIENTS: Record<string, { label: string; short: string }> = {
  anthropic: { label: "Claude Code", short: "claude" },
  codex: { label: "Codex", short: "codex" },
  openai: { label: "OpenAI", short: "openai" },
}
const clientOf = (p?: string) => CLIENTS[p ?? "anthropic"] ?? CLIENTS.anthropic

// The newest call that carries the conversation — the one a reader wants.
const latestConv = (list: CallSummary[]) =>
  [...list].reverse().find((c) => c.tools > 0) ?? list[list.length - 1]

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
  // The list reads top-down; a session can run to sixty calls, so newest
  // first keeps the current turn in reach.
  const [newestFirst, setNewestFirst] = useState(true)
  // Following keeps the newest conversation call selected while a session
  // runs. Clicking an older call detaches; the toggle re-attaches.
  const [follow, setFollow] = useState(true)
  // Title generators and status updaters live in their own files. They are
  // hidden by default so the list is one row per thread.
  const [showBackground, setShowBackground] = useState(false)
  const [dir, setDir] = useState<string | null>(null)
  useEffect(() => {
    api<{ dir: string }>("/info")
      .then((i) => setDir(i.dir))
      .catch(() => {})
  }, [])
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
        const callList = await api<CallSummary[]>("/session/" + encodeURIComponent(session))
        setCalls(callList)
        if (follow) {
          const conv = latestConv(callList)
          if (conv && conv.seq !== seq) setSeq(conv.seq)
        }
      } catch {
        setSession(null)
        setCalls([])
        setSeq(null)
        setDetail(null)
      }
    }
  }, [session, follow, seq])

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
    setFollow(true)
    api<CallSummary[]>("/session/" + encodeURIComponent(file))
      .then((list) => {
        setCalls(list)
        // Open on the newest conversation call — the one with tools — so a
        // reader lands on the discussion, not on a background job.
        const conv = latestConv(list)
        if (conv) setSeq(conv.seq)
      })
      .catch(() => setCalls([]))
  }

  // One row per thread by default; the background files stay reachable.
  const visible = (sessions ?? []).filter(
    (s) => showBackground || (s.kind ?? "session") === "session"
  )
  const bgCount = (sessions?.length ?? 0) - (sessions ?? []).filter(
    (s) => (s.kind ?? "session") === "session"
  ).length

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
                  All ({visible.length})
                </TabsTrigger>
                <TabsTrigger value="anthropic">
                  Claude ({visible.filter((s) => (s.provider ?? "anthropic") === "anthropic").length})
                </TabsTrigger>
                <TabsTrigger value="codex">
                  Codex ({visible.filter((s) => s.provider === "codex").length})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {bgCount > 0 ? (
              <button
                onClick={() => setShowBackground((v) => !v)}
                className="text-muted-foreground hover:text-foreground shrink-0 px-4 pt-1.5 text-left font-mono text-[11px]"
              >
                {showBackground ? "hide" : "show"} {bgCount} background job
                {bgCount > 1 ? "s" : ""} (titles, status updates)
              </button>
            ) : null}
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
                visible
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
                        <span className="line-clamp-2 text-xs font-medium">
                          {s.title ?? s.model ?? "–"}
                        </span>
                        <span className="text-muted-foreground truncate font-mono text-[11px]">
                          {s.model ?? "–"} · {fmtTime(s.mtime)} · {s.calls} calls ·{" "}
                          {fmtBytes(s.bytes)}
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
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {session ? (
              <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
                <span className="text-muted-foreground mr-auto font-mono text-[11px]">
                  {calls.length} calls
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-6 gap-1 px-2 text-[11px]",
                    follow ? "text-primary" : "text-muted-foreground"
                  )}
                  onClick={() => {
                    const next = !follow
                    setFollow(next)
                    if (next) {
                      const conv = latestConv(calls)
                      if (conv) setSeq(conv.seq)
                    }
                  }}
                >
                  <RadioIcon className="size-3" />
                  {follow ? "following" : "follow"}
                </Button>
                <AskAgentButton dir={dir} file={session} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-6 gap-1 px-2 text-[11px]"
                  onClick={() => setNewestFirst((v) => !v)}
                >
                  <ArrowDownUpIcon className="size-3" />
                  {newestFirst ? "newest first" : "oldest first"}
                </Button>
              </div>
            ) : null}
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col p-2">
                {!session ? (
                  <p className="text-muted-foreground p-3 text-sm">Pick a session.</p>
                ) : calls.length === 0 ? (
                  <p className="text-muted-foreground p-3 text-sm">No calls yet.</p>
                ) : (
                  (newestFirst ? [...calls].reverse() : calls).map((c) => (
                    <button
                      key={c.id}
                      // Selection can come from elsewhere (following, the
                      // Context timeline), so the list keeps it in view.
                      ref={seq === c.seq ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      onClick={() => {
                        setSeq(c.seq)
                        // Picking an older call means the reader left the
                        // live edge; stop following until asked again.
                        setFollow(latestConv(calls)?.seq === c.seq)
                      }}
                      className={cn(
                        "hover:bg-accent flex flex-col gap-1 rounded-md px-2 py-2 text-left",
                        seq === c.seq && "bg-accent"
                      )}
                    >
                      <span className="flex items-center gap-2 font-mono text-xs">
                        <span>#{c.seq}</span>
                        <span className="text-muted-foreground">
                          {fmtTime(c.ts)} · {c.messages} msg · {fmtMs(c.took_ms)}
                        </span>
                        {c.status !== 200 ? (
                          <Badge variant="destructive">{c.status}</Badge>
                        ) : null}
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
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="60" minSize="30">
          {detail ? (
            <CallDetail
              call={detail.call}
              prev={detail.comparable}
              session={calls}
              file={session ?? ""}
              onSelectSeq={(n) => {
                setSeq(n)
                setFollow(latestConv(calls)?.seq === n)
              }}
            />
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
