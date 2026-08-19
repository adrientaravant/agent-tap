import { useEffect, useMemo, useState } from "react"

import { Explain, SourceBadge } from "@/components/explain"
import { Code, OutlinePane, type OutlineItem } from "@/components/outline-pane"
import { Transcript } from "@/components/transcript"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  blockText,
  cacheBreakpoints,
  describeKind,
  diffLines,
  fmtMs,
  fmtNum,
  messagesText,
  paramsText,
  replyText,
  systemTextOf,
  toolLabel,
  toolsText,
  transcriptOf,
  viewOf,
  type CallSummary,
  type WireRecord,
} from "@/lib/wire"

function PaneHeader({ derived, children }: { derived?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <SourceBadge derived={derived} />
      <span className="text-muted-foreground text-xs">{children}</span>
    </div>
  )
}

export function CallDetail({
  call,
  prev,
  session,
  onSelectSeq,
}: {
  call: WireRecord
  prev: WireRecord | null
  session: CallSummary[]
  onSelectSeq?: (seq: number) => void
}) {
  const req = call.request
  const usage = call.response?.usage ?? {}
  const promptTotal =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const promptShare = (n?: number) => (promptTotal ? ((n ?? 0) / promptTotal) * 100 : 0)
  // The client can compact the history mid-session. Only an EARLIER call can
  // hold what this one no longer carries — a fuller call later in time is a
  // different window, not this call's lost history.
  const fullest = session.reduce<CallSummary | null>(
    (a, b) => (b.seq < call.seq && b.messages > (a?.messages ?? 0) ? b : a),
    null
  )
  const kind = describeKind(call)
  const codex = (call.provider ?? "anthropic") !== "anthropic"
  const breaks = cacheBreakpoints(req)
  const view = viewOf(call)
  const prevView = prev ? viewOf(prev) : null
  const sys = view.system
  const tools = view.tools
  const messages = view.messages
  const prevMessageCount = prevView?.messages.length ?? 0
  const prevTools = useMemo(() => new Set((prevView?.tools ?? []).map((t) => t.name)), [prevView])

  const calls = call.calls ?? []
  const transcript = useMemo(() => transcriptOf(view), [call.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [callIdx, setCallIdx] = useState<string | null>(null)
  const [tool, setTool] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [sysIdx, setSysIdx] = useState<string | null>(null)
  useEffect(() => {
    setTool(tools[0]?.name ?? null)
    setMsg(messages.length ? String(messages.length - 1) : null)
    setSysIdx(sys.length ? "0" : null)
    setCallIdx(calls.length ? "0" : null)
    // A new call resets the outline selection.
  }, [call.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const toolItems: OutlineItem[] = tools.map((t) => ({
    id: t.name,
    label: t.name,
    hint: t.description?.split("\n")[0],
    tags: [
      ...(t.cache_control ? ["cache breakpoint"] : []),
      ...(prev && !prevTools.has(t.name) ? ["new"] : []),
    ],
    search: t.name + " " + (t.description ?? ""),
  }))

  const msgItems: OutlineItem[] = messages.map((m, i) => {
    const text = blockText(m.content)
    return {
      id: String(i),
      label: m.name ? `[${i}] ${m.role} → ${m.name}` : `[${i}] ${m.role}`,
      hint: text.slice(0, 90).replace(/\s+/g, " "),
      tags: [
        ...(m.cache_control ? ["cache breakpoint"] : []),
        ...(Array.isArray(m.content) && m.content.some((c) => c.cache_control)
          ? ["cache breakpoint"]
          : []),
        ...(prev && i >= prevMessageCount ? ["new"] : []),
      ],
      search: m.role + " " + text,
    }
  })

  const sysItems: OutlineItem[] = sys.map((b, i) => ({
    id: String(i),
    label: `system[${i}]`,
    hint: `${(b.text ?? "").length.toLocaleString("en-US")} chars — ${(b.text ?? "")
      .slice(0, 70)
      .replace(/\s+/g, " ")}`,
    tags: b.cache_control ? ["cache breakpoint"] : [],
    search: b.text ?? "",
  }))

  const selectedTool = tools.find((t) => t.name === tool)
  const selectedMsg = msg != null ? messages[Number(msg)] : undefined
  const selectedSys = sysIdx != null ? sys[Number(sysIdx)] : undefined
  const selectedCall = callIdx != null ? calls[Number(callIdx)] : undefined

  return (
    // h-full, not flex-1: the resizable panel wrapper is a block element, so a
    // flex hint is ignored and the pane grows to its content instead of scrolling.
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The "data strip" header: one identity line, one number line. The
          old six-stat grid moved into the strip; the kind's explanation
          lives in the badge's hover. */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <span className="text-sm font-semibold">Call #{call.seq}</span>
        <Explain term="kind">
          <Badge variant={call.kind === "session" ? "default" : "secondary"}>{kind.label}</Badge>
        </Explain>
        <span className="text-muted-foreground font-mono text-xs">{call.model}</span>
        <span className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          <Badge variant={call.response?.status === 200 ? "outline" : "destructive"}>
            {call.response?.status}
          </Badge>
          <Explain term="stop_reason">{call.response?.stop_reason ?? "–"}</Explain>
          <span>·</span>
          <Explain term="ttfb">{fmtMs(call.ttfb_ms)} ttfb</Explain>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3.5 border-b px-4 py-2 text-xs">
        <span className="text-muted-foreground shrink-0">
          <Explain term="input">Prompt</Explain>{" "}
          <span className="text-foreground font-medium tabular-nums">{fmtNum(promptTotal)}</span>
        </span>
        <span className="bg-muted flex h-1.5 min-w-16 flex-1 overflow-hidden rounded-sm">
          <span className="bg-primary" style={{ width: `${promptShare(usage.input_tokens)}%` }} />
          <span
            className="bg-primary/50"
            style={{ width: `${promptShare(usage.cache_creation_input_tokens)}%` }}
          />
          <span
            className="bg-muted-foreground/40"
            style={{ width: `${promptShare(usage.cache_read_input_tokens)}%` }}
          />
        </span>
        <span className="text-muted-foreground shrink-0">
          <Explain term="cache_read">
            {promptTotal ? Math.round(promptShare(usage.cache_read_input_tokens)) : 0}% cached
          </Explain>
        </span>
        <span className="text-muted-foreground shrink-0">
          <Explain term="output">out</Explain>{" "}
          <span className="text-foreground font-medium tabular-nums">
            {fmtNum(usage.output_tokens)}
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 border-l pl-3.5">
          ran {calls.length} tools · {messages.length} messages
        </span>
      </div>

      <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 mt-3 shrink-0">
          <TabsTrigger value="chat">Conversation</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
          <span className="bg-border mx-1.5 h-4 w-px shrink-0" />
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="calls">Tool calls</TabsTrigger>
          <TabsTrigger value="params">Params</TabsTrigger>
          <TabsTrigger value="reply">Reply</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>

        <TabsContent value="chat" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader derived>
            The conversation rebuilt for reading: turns in full, thinking, tool runs and
            harness notes folded. Click a folded row to open it. The Messages tab shows the
            same content as sent.
          </PaneHeader>
          {fullest && fullest.seq !== call.seq && fullest.messages > messages.length + 20 ? (
            <div className="text-muted-foreground flex shrink-0 items-center gap-1 border-b px-4 py-1.5 text-xs">
              <Explain term="compaction">
                The history was compacted: this call carries {messages.length} messages, call #
                {fullest.seq} still holds {fullest.messages}.
              </Explain>
              <button
                onClick={() => onSelectSeq?.(fullest.seq)}
                className="text-primary underline underline-offset-4"
              >
                Open #{fullest.seq}
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <Transcript items={transcript} conversation={call.kind === "session"} />
          </div>
        </TabsContent>

        <TabsContent value="context" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader derived>
            What fills the context window on this call, and how it grows over the session.
            Sizes are measured on the captured request; token counts are what the API
            reported.
          </PaneHeader>
          <ScrollArea className="min-h-0 flex-1">
            <ContextPane call={call} view={view} session={session} onSelectSeq={onSelectSeq} />
          </ScrollArea>
        </TabsContent>

        <TabsContent value="overview" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader derived>wiretap built this summary from the record.</PaneHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Request shape</h3>
                <Code>
                  {[
                    `system blocks : ${sys.length}`,
                    `tools         : ${tools.length}`,
                    `messages      : ${messages.length}`,
                    `stream        : ${req.stream ?? false}`,
                    ...(codex
                      ? [
                          `reasoning     : ${req.reasoning ? JSON.stringify(req.reasoning) : "–"}`,
                          `verbosity     : ${(req.text as { verbosity?: string })?.verbosity ?? "–"}`,
                          `service_tier  : ${req.service_tier ?? "–"}`,
                          `store         : ${req.store ?? "–"}`,
                          `cache key     : ${req.prompt_cache_key ?? "–"}`,
                        ]
                      : [
                          `max_tokens    : ${req.max_tokens ?? "–"}`,
                          `temperature   : ${req.temperature ?? "–"}`,
                          `thinking      : ${req.thinking ? JSON.stringify(req.thinking) : "–"}`,
                        ]),
                  ].join("\n")}
                </Code>
              </section>
              {codex ? (
                <section className="flex flex-col gap-2">
                  <Explain term="auto_cache" icon>
                    <h3 className="text-sm font-medium">Caching</h3>
                  </Explain>
                  <p className="text-muted-foreground text-sm">
                    No markers on the wire. This API caches on its own and groups calls by
                    the cache key above.
                  </p>
                </section>
              ) : (
                <section className="flex flex-col gap-2">
                  <Explain term="cache_control" icon>
                    <h3 className="text-sm font-medium">Cache breakpoints ({breaks.length})</h3>
                  </Explain>
                  {breaks.length ? (
                    <Code>{breaks.map((b) => `${b.where.padEnd(28)} ${b.type}`).join("\n")}</Code>
                  ) : (
                    <p className="text-muted-foreground text-sm">None on this call.</p>
                  )}
                </section>
              )}
              <section className="flex flex-col gap-2">
                <Explain term={codex ? "codex_headers" : "betas"} icon>
                  <h3 className="text-sm font-medium">Client flags</h3>
                </Explain>
                <Code>
                  {codex
                    ? Object.entries(call.request_headers ?? {})
                        .filter(([k]) => k.startsWith("x-codex") || k === "originator")
                        .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)
                        .join("\n") || "none"
                    : (call.request_headers?.["anthropic-beta"] ?? "none")}
                </Code>
              </section>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="system" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader>The system prompt, block by block, as sent.</PaneHeader>
          <OutlinePane
            items={sysItems}
            selected={sysIdx}
            onSelect={setSysIdx}
            placeholder="Search the system prompt…"
          >
            {selectedSys ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-mono text-sm">system[{sysIdx}]</h3>
                  {selectedSys.cache_control ? (
                    <Explain term="cache_control">
                      <Badge variant="secondary">cache_control {selectedSys.cache_control.type}</Badge>
                    </Explain>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    {(selectedSys.text ?? "").length.toLocaleString("en-US")} characters
                  </span>
                </div>
                <Code>{selectedSys.text ?? JSON.stringify(selectedSys, null, 2)}</Code>
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No system prompt</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </OutlinePane>
        </TabsContent>

        <TabsContent value="tools" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader>Every tool schema offered on this call.</PaneHeader>
          <OutlinePane
            items={toolItems}
            selected={tool}
            onSelect={setTool}
            placeholder="Search tools…"
          >
            {selectedTool ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-mono text-sm font-medium">{selectedTool.name}</h3>
                  {selectedTool.cache_control ? (
                    <Explain term="cache_control">
                      <Badge variant="secondary">cache breakpoint</Badge>
                    </Explain>
                  ) : null}
                  {prev && !prevTools.has(selectedTool.name) ? (
                    <Explain term="new_badge">
                      <Badge>new</Badge>
                    </Explain>
                  ) : null}
                </div>
                {selectedTool.description ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {selectedTool.description}
                  </p>
                ) : null}
                <Separator />
                <Code>{JSON.stringify(selectedTool.input_schema ?? {}, null, 2)}</Code>
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No tools</EmptyTitle>
                  <EmptyDescription>
                    A call without tools is a background job, not the conversation.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </OutlinePane>
        </TabsContent>

        <TabsContent value="messages" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader>The conversation as sent on this call.</PaneHeader>
          <OutlinePane
            items={msgItems}
            selected={msg}
            onSelect={setMsg}
            placeholder="Search messages…"
          >
            {selectedMsg ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-mono text-sm">
                    [{msg}] {selectedMsg.role}
                  </h3>
                  {prev && Number(msg) >= prevMessageCount ? (
                    <Explain term="new_badge">
                      <Badge>new</Badge>
                    </Explain>
                  ) : null}
                </div>
                <Code>{blockText(selectedMsg.content)}</Code>
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No messages</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </OutlinePane>
        </TabsContent>

        <TabsContent value="calls" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader derived>
            Each tool the agent ran on this turn, paired with the result it got back.
          </PaneHeader>
          <OutlinePane
            items={calls.map((c) => ({
              id: String(c.index),
              label: `${c.index + 1}. ${toolLabel(c.name, c.input)}`,
              hint: c.input.slice(0, 90).replace(/\s+/g, " "),
              tags: c.is_error ? ["failed"] : [],
              search: c.name + " " + c.input + " " + (c.output ?? ""),
            }))}
            selected={callIdx}
            onSelect={setCallIdx}
            placeholder="Search tool calls…"
          >
            {selectedCall ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-mono text-sm font-medium">{selectedCall.name}</h3>
                  {selectedCall.is_error ? <Badge variant="destructive">failed</Badge> : null}
                  <span className="text-muted-foreground text-xs">
                    message [{selectedCall.message}]
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <h4 className="text-muted-foreground text-xs tracking-wide uppercase">Input</h4>
                  <Code>{selectedCall.input || "(none)"}</Code>
                </div>
                <div className="flex flex-col gap-1">
                  <h4 className="text-muted-foreground text-xs tracking-wide uppercase">Result</h4>
                  <Code>{selectedCall.output ?? "(no result in this request — the call was still running)"}</Code>
                </div>
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No tool calls</EmptyTitle>
                  <EmptyDescription>
                    Nothing was run in the conversation this call carries.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </OutlinePane>
        </TabsContent>

        <TabsContent value="params" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader>Model parameters and headers, credentials removed.</PaneHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Parameters</h3>
                <Code>{paramsText(req)}</Code>
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Request headers</h3>
                <Code>{JSON.stringify(call.request_headers, null, 2)}</Code>
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Response headers</h3>
                <Code>{JSON.stringify(call.response_headers, null, 2)}</Code>
              </section>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="reply" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader>What the API sent back.</PaneHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Reply text</h3>
                <Code>{replyText(call.response) || "(none)"}</Code>
              </section>
              {call.response?.thinking ? (
                <section className="flex flex-col gap-2">
                  <Explain term="thinking" icon>
                    <h3 className="text-sm font-medium">Thinking</h3>
                  </Explain>
                  <Code>{call.response.thinking}</Code>
                </section>
              ) : null}
              {call.response?.tool_calls?.length ? (
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">Tool calls</h3>
                  <Code>{JSON.stringify(call.response.tool_calls, null, 2)}</Code>
                </section>
              ) : null}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="diff" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader derived>
            wiretap compared this call with the previous call of the same shape — a
            conversation turn against a conversation turn, not against a background job.
          </PaneHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {prev ? (
                <>
                  <DiffSection
                    title="System"
                    a={systemTextOf(prevView!)}
                    b={systemTextOf(view)}
                  />
                  <DiffSection title="Tools" a={toolsText(prevView!)} b={toolsText(view)} />
                  <DiffSection
                    title="Messages"
                    a={messagesText(prevView!)}
                    b={messagesText(view)}
                  />
                  <DiffSection title="Parameters" a={paramsText(prev.request)} b={paramsText(req)} />
                </>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>First call of this kind</EmptyTitle>
                    <EmptyDescription>
                      Nothing earlier in this session has the same shape, so a diff would compare
                      a conversation turn against a background job.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="raw" className="mt-3 flex min-h-0 flex-1 flex-col">
          <PaneHeader>The stored record, exactly as written to the file.</PaneHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <Code>{JSON.stringify(call, null, 2)}</Code>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// One measured row of the composition table: a label, a size, a share bar.
function ShareRow({ label, chars, total, hint }: { label: string; chars: number; total: number; hint?: string }) {
  const pct = total ? (chars / total) * 100 : 0
  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <span className="w-40 shrink-0">{label}</span>
      <span className="text-muted-foreground w-24 shrink-0 text-right">
        {chars.toLocaleString("en-US")} ch
      </span>
      <span className="text-muted-foreground w-14 shrink-0 text-right">{pct.toFixed(1)}%</span>
      <span className="bg-muted relative h-2 min-w-0 flex-1 overflow-hidden rounded-sm">
        <span className="bg-primary/60 absolute inset-y-0 left-0" style={{ width: `${pct}%` }} />
      </span>
      {hint ? <span className="text-muted-foreground w-28 shrink-0 truncate">{hint}</span> : null}
    </div>
  )
}

// What fills the context window, measured on the captured request, plus the
// token growth the API reported call by call. All derived; nothing here is
// an estimate of tokens from text.
function ContextPane({
  call,
  view,
  session,
  onSelectSeq,
}: {
  call: WireRecord
  view: ReturnType<typeof viewOf>
  session: CallSummary[]
  onSelectSeq?: (seq: number) => void
}) {
  const sizes = useMemo(() => {
    const sys = view.system.reduce((n, b) => n + (b.text ?? "").length, 0)
    const tools = view.tools.reduce((n, t) => n + JSON.stringify(t).length, 0)
    const msgs = view.messages.reduce((n, m) => n + blockText(m.content).length, 0)
    const perTool = view.tools
      .map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars)
    return { sys, tools, msgs, total: sys + tools + msgs, perTool }
  }, [call.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const prompt = (c: CallSummary) =>
    (c.usage.input ?? 0) + (c.usage.cache_read ?? 0) + (c.usage.cache_write ?? 0)
  const maxPrompt = Math.max(1, ...session.map(prompt))
  const u = call.response?.usage ?? {}
  const promptNow =
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">What fills the prompt on this call</h3>
        <p className="text-muted-foreground text-xs">
          Measured in characters of the captured request. The API reported{" "}
          {fmtNum(promptNow)} prompt tokens for it in total.
        </p>
        <div className="flex flex-col gap-1.5">
          <ShareRow
            label={`system (${view.system.length} blocks)`}
            chars={sizes.sys}
            total={sizes.total}
          />
          <ShareRow
            label={`tools (${view.tools.length} definitions)`}
            chars={sizes.tools}
            total={sizes.total}
          />
          <ShareRow
            label={`messages (${view.messages.length})`}
            chars={sizes.msgs}
            total={sizes.total}
          />
        </div>
      </section>

      {sizes.perTool.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Largest tool definitions</h3>
          <div className="flex flex-col gap-1.5">
            {sizes.perTool.slice(0, 8).map((t) => (
              <ShareRow key={t.name} label={t.name} chars={t.chars} total={sizes.tools} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Growth over the session</h3>
        <p className="text-muted-foreground text-xs">
          Prompt tokens the API reported per call — new input, cache reads and cache
          writes together. The bar that keeps growing is the conversation carrying its
          own history forward. Click a row to open that call.
        </p>
        <div className="flex flex-col gap-1">
          {session.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectSeq?.(c.seq)}
              className={cn(
                "hover:bg-accent flex w-full items-center gap-2 rounded-sm px-1 text-left font-mono text-[11px]",
                c.seq === call.seq && "bg-accent"
              )}
            >
              <span className="w-10 shrink-0">#{c.seq}</span>
              <span className="text-muted-foreground w-24 shrink-0 text-right">
                {fmtNum(prompt(c))} tok
              </span>
              <span className="bg-muted relative h-2 min-w-0 flex-1 overflow-hidden rounded-sm">
                <span
                  className="bg-primary/60 absolute inset-y-0 left-0"
                  style={{ width: `${(prompt(c) / maxPrompt) * 100}%` }}
                />
              </span>
              <span className="text-muted-foreground w-20 shrink-0 text-right">
                out {fmtNum(c.usage.output)}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function DiffSection({ title, a, b }: { title: string; a: string; b: string }) {
  const rows = a === b ? [] : diffLines(a, b)
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {a === b ? (
          <Badge variant="outline">identical</Badge>
        ) : (
          <Badge variant="secondary">changed</Badge>
        )}
      </div>
      {rows.length ? (
        <div className="overflow-x-auto rounded-md border font-mono text-xs">
          {rows.map((r, i) => (
            <div
              key={i}
              className={
                r.kind === "add"
                  ? "bg-primary/10 text-primary px-3 py-0.5 whitespace-pre-wrap"
                  : r.kind === "del"
                    ? "bg-destructive/10 text-destructive px-3 py-0.5 whitespace-pre-wrap"
                    : r.kind === "hunk"
                      ? "bg-muted text-muted-foreground px-3 py-0.5"
                      : "text-muted-foreground px-3 py-0.5 whitespace-pre-wrap"
              }
            >
              {r.kind === "add" ? "+ " : r.kind === "del" ? "- " : r.kind === "hunk" ? "@@ " : "  "}
              {r.text}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
