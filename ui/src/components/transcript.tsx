import { useState } from "react"
import { BrainIcon, ChevronRightIcon, InfoIcon, WrenchIcon } from "lucide-react"

import { Code } from "@/components/outline-pane"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { TranscriptItem } from "@/lib/wire"

// The conversation the way a person reads a chat: spoken turns in full,
// machinery folded away. Everything here is rebuilt from the messages of
// the call, so the pane is labelled computed.

const CLAMP = 3000

// A spoken turn is shown whole unless it is huge; folded blocks show one
// line until opened.
function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= CLAMP || open)
    return <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{text.slice(0, CLAMP)}…</p>
      <button
        onClick={() => setOpen(true)}
        className="text-primary text-xs underline underline-offset-4"
      >
        Show the rest ({(text.length - CLAMP).toLocaleString("en-US")} more characters)
      </button>
    </div>
  )
}

function Fold({
  icon,
  title,
  hint,
  tags,
  children,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  tags?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left">
        <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
        {icon}
        <span className="shrink-0 font-mono text-xs">{title}</span>
        {tags}
        {hint ? (
          <span className="text-muted-foreground min-w-0 truncate text-xs">{hint}</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 py-2 pr-2 pl-8">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const oneLine = (s: string, n = 110) => s.replace(/\s+/g, " ").trim().slice(0, n)

function Turn({ who, children }: { who: "user" | "assistant"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-md border-l-2 py-1 pl-3",
        who === "user" ? "border-primary" : "border-muted-foreground/40"
      )}
    >
      <span
        className={cn(
          "text-[11px] font-medium tracking-wide uppercase",
          who === "user" ? "text-primary" : "text-muted-foreground"
        )}
      >
        {who === "user" ? "You" : "Agent"}
      </span>
      {children}
    </div>
  )
}

export function Transcript({ items }: { items: TranscriptItem[] }) {
  if (!items.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing to read</EmptyTitle>
          <EmptyDescription>
            This call carries no conversation. Background jobs live in the Messages tab.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
      {items.map((item, i) => {
        if (item.kind === "user" || item.kind === "assistant")
          return (
            <Turn key={i} who={item.kind}>
              <ClampedText text={item.text} />
            </Turn>
          )
        if (item.kind === "thinking")
          return (
            <Fold
              key={i}
              icon={<BrainIcon className="text-muted-foreground size-3.5 shrink-0" />}
              title="Thinking"
              hint={oneLine(item.text)}
            >
              <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap italic">
                {item.text}
              </p>
            </Fold>
          )
        if (item.kind === "tool")
          return (
            <Fold
              key={i}
              icon={<WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />}
              title={item.name ?? "tool"}
              hint={oneLine(item.text)}
              tags={item.is_error ? <Badge variant="destructive">failed</Badge> : null}
            >
              <div className="flex flex-col gap-1">
                <h4 className="text-muted-foreground text-xs tracking-wide uppercase">Input</h4>
                <Code>{item.text || "(none)"}</Code>
              </div>
              <div className="flex flex-col gap-1">
                <h4 className="text-muted-foreground text-xs tracking-wide uppercase">Result</h4>
                <Code>
                  {item.output ?? "(no result in this request — the call was still running)"}
                </Code>
              </div>
            </Fold>
          )
        // A harness note: real, but not the person talking.
        return (
          <Fold
            key={i}
            icon={<InfoIcon className="text-muted-foreground size-3.5 shrink-0" />}
            title="Harness note"
            hint={oneLine(item.text.replace(/^<[^>]+>\s*/, "").replace(/<\/[^>]+>\s*$/, ""))}
          >
            <Code>{item.text}</Code>
          </Fold>
        )
      })}
    </div>
  )
}
