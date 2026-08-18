import { InfoIcon } from "lucide-react"

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"

// Short explanations of how the harness works, attached to the label they
// belong to. The aim is that a reader never has to guess what a number means.
export const GLOSSARY: Record<string, { title: string; body: string }> = {
  input: {
    title: "Input tokens",
    body: "New tokens the model had to read this call, excluding anything served from the cache. A large context with a small input number means the cache did its job.",
  },
  output: {
    title: "Output tokens",
    body: "Tokens the model produced: reply text, thinking, and tool call arguments.",
  },
  cache_write: {
    title: "Cache write",
    body: "Tokens stored in the prompt cache on this call. The first call of a session writes the whole prefix — system prompt and tool definitions — which is why it is large and slow. Writing costs more than a normal input token.",
  },
  cache_read: {
    title: "Cache read",
    body: "Tokens served from the cache instead of being processed again. Cheap and fast. This is the number that should grow as a session continues.",
  },
  cache_control: {
    title: "Cache breakpoint",
    body: "A cache_control marker on a block. Everything before it is cached as one prefix. The client moves the last breakpoint forward as the conversation grows, so the stable head stays cached and only the new tail is processed.",
  },
  system: {
    title: "System blocks",
    body: "The system prompt, sent as an ordered list of blocks. The harness builds it from several parts: a billing header, the agent identity, the main instructions, and the environment. It is not in the session .jsonl files.",
  },
  tools: {
    title: "Tool definitions",
    body: "The full JSON schema of every tool offered on this call. They sit at the head of the prompt, so they dominate the first cache write. A session with many MCP servers connected sends a very large tool list on every call.",
  },
  betas: {
    title: "Beta flags",
    body: "The anthropic-beta header. It lists the optional API features the client asked for on this call, such as prompt caching scope or interleaved thinking.",
  },
  stream: {
    title: "Streaming",
    body: "Whether the reply arrives as server-sent events. Interactive calls stream; short background jobs usually do not.",
  },
  thinking: {
    title: "Thinking",
    body: "The extended thinking setting for this call. Disabled means the model answers directly.",
  },
  ttfb: {
    title: "Time to first byte",
    body: "How long the API took to send the first byte of the reply. Compare it with the total to see whether a call was slow to start or slow to finish.",
  },
  stop_reason: {
    title: "Stop reason",
    body: "Why the model stopped: end_turn for a finished reply, tool_use when it is calling a tool, max_tokens when it hit the budget.",
  },
  max_tokens: {
    title: "Max tokens",
    body: "The output budget for this call. Background jobs get a small budget, an interactive turn gets a large one.",
  },
  auto_cache: {
    title: "Automatic caching",
    body: "This API has no cache_control markers. It caches the prefix on its own and reports only how many tokens were read from the cache. Codex passes a cache key so its turns share one entry.",
  },
  no_cache_write: {
    title: "Cache write, not reported here",
    body: "The Responses API does not report a cache write. Only the read is visible, so this stays empty for Codex.",
  },
  codex_headers: {
    title: "Client flags",
    body: "The x-codex headers Codex adds to each call: the beta features it asked for, the window it belongs to, and where the call came from.",
  },
  derived: {
    title: "Computed by wiretap",
    body: "This panel is not part of the payload. wiretap built it from the record to make the call readable. The system, tools, messages, params and raw tabs show what actually crossed the wire.",
  },
  captured: {
    title: "Sent on the wire",
    body: "Exactly what the client sent to the API, byte for byte, with credentials removed from the headers. Nothing here was written by wiretap.",
  },
  kind: {
    title: "What this call is",
    body: "One prompt from you produces several API calls. Only one is the conversation; the others are background jobs such as naming the session or deciding whether the agent is still working. wiretap reads the system prompt to tell them apart.",
  },
  ask_agent: {
    title: "Ask an agent about this session",
    body: "Copies a prompt with the path of this session's record file. Paste it into Claude Code (or any agent that reads files) and ask questions — which skills ran, why a tool failed, what a turn added. The viewer itself holds no model and no key, so the questions run in the agent, on the raw file. For a standing setup, register the bundled MCP server instead: claude mcp add agent-tap -- node <repo>/mcp.mjs",
  },
  new_badge: {
    title: "New since the previous call",
    body: "This block was not present in the previous call of the same session. It is what this turn added.",
  },
}

export function Explain({
  term,
  children,
  className,
  icon = false,
}: {
  term: keyof typeof GLOSSARY | string
  children: React.ReactNode
  className?: string
  icon?: boolean
}) {
  const entry = GLOSSARY[term]
  if (!entry) return <>{children}</>
  return (
    <HoverCard>
      <HoverCardTrigger
        className={cn(
          "inline-flex cursor-help items-center gap-1 underline decoration-dotted underline-offset-4",
          className
        )}
      >
        {children}
        {icon ? <InfoIcon className="size-3 opacity-60" /> : null}
      </HoverCardTrigger>
      <HoverCardContent className="w-96">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{entry.title}</p>
          <p className="text-muted-foreground text-sm leading-relaxed">{entry.body}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export function SourceBadge({ derived = false }: { derived?: boolean }) {
  return (
    <Explain term={derived ? "derived" : "captured"}>
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide",
          derived ? "text-muted-foreground" : "border-primary/40 text-primary"
        )}
      >
        {derived ? "computed" : "on the wire"}
      </span>
    </Explain>
  )
}
