import { useMemo, useRef, useState } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BrainIcon,
  ChevronRightIcon,
  InfoIcon,
  WrenchIcon,
} from "lucide-react"

import { Explain } from "@/components/explain"
import { Code } from "@/components/outline-pane"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { toolLabel, type TranscriptItem } from "@/lib/wire"

// The conversation the way a person reads a chat: spoken turns as bubbles,
// machinery folded into marker rows. Everything here is rebuilt from the
// messages of the call, so the pane is labelled computed.

const CLAMP = 3000

// A spoken turn is shown whole unless it is huge; folded blocks show one
// line until opened.
function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= CLAMP || open)
    return <span className="whitespace-pre-wrap">{text}</span>
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="whitespace-pre-wrap">{text.slice(0, CLAMP)}…</span>
      <button
        onClick={() => setOpen(true)}
        className="text-xs underline underline-offset-4 opacity-80"
      >
        Show the rest ({(text.length - CLAMP).toLocaleString("en-US")} more characters)
      </button>
    </span>
  )
}

const oneLine = (s: string, n = 110) => s.replace(/\s+/g, " ").trim().slice(0, n)

// A folded row: a Marker as the trigger, the payload below it. Thinking,
// tool runs and harness notes all read as one quiet line until opened.
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
      <CollapsibleTrigger
        render={
          <Marker
            render={<button type="button" />}
            className="group/fold hover:bg-accent w-full cursor-pointer rounded-md px-2 py-1.5"
          />
        }
      >
        <ChevronRightIcon className="shrink-0 transition-transform group-data-[panel-open]/fold:rotate-90" />
        <MarkerIcon>{icon}</MarkerIcon>
        <span className="text-foreground shrink-0 font-mono text-xs">{title}</span>
        {tags}
        {hint ? <MarkerContent className="truncate text-xs">{hint}</MarkerContent> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 py-2 pr-2 pl-8">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Transcript({
  items,
  conversation = true,
}: {
  items: TranscriptItem[]
  // False for a background job: its "user" is the harness, not the person.
  conversation?: boolean
}) {
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      q
        ? items.filter((i) =>
            (i.text + " " + (i.name ?? "") + " " + (i.output ?? "")).toLowerCase().includes(q)
          )
        : items,
    [items, q]
  )
  const userTurns = shown.filter((i) => i.kind === "user").length

  // Jump to the user turn just above or below the current view. DOM-based on
  // purpose: the scroller virtualises heights, so positions live there.
  const jump = (dir: 1 | -1) => {
    const vp = rootRef.current?.querySelector('[data-slot="message-scroller-viewport"]')
    if (!vp) return
    const turns = [...vp.querySelectorAll<HTMLElement>('[data-turn="user"]')]
    if (!turns.length) return
    const top = vp.getBoundingClientRect().top
    const next =
      dir === 1
        ? turns.find((t) => t.getBoundingClientRect().top > top + 8)
        : [...turns].reverse().find((t) => t.getBoundingClientRect().top < top - 8)
    ;(next ?? (dir === 1 ? turns[turns.length - 1] : turns[0])).scrollIntoView({
      block: "start",
      behavior: "smooth",
    })
  }

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
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this conversation…"
          className="h-7 max-w-64 text-xs"
        />
        <span className="text-muted-foreground font-mono text-[11px]">
          {q ? `${shown.length} of ${items.length} match` : `${userTurns} user turns`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Previous user turn"
            onClick={() => jump(-1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Next user turn"
            onClick={() => jump(1)}
          >
            <ArrowDownIcon />
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 p-4">
                {shown.map((item, i) => {
                  if (item.kind === "user" || item.kind === "assistant") {
                    // In a background job the "user" is the harness driving
                    // it, so the turn reads as Harness, quiet and left.
                    const you = item.kind === "user" && conversation
                    const label =
                      item.kind === "assistant" ? "Agent" : conversation ? "You" : "Harness"
                    return (
                      <MessageScrollerItem
                        key={i}
                        messageId={String(i)}
                        scrollAnchor={item.kind === "user"}
                      >
                        <Message
                          align={you ? "end" : "start"}
                          data-turn={item.kind === "user" ? "user" : undefined}
                        >
                          <MessageContent>
                            <MessageHeader>{label}</MessageHeader>
                            <Bubble
                              variant={you ? "default" : "muted"}
                              align={you ? "end" : "start"}
                            >
                              <BubbleContent>
                                <ClampedText text={item.text} />
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  }
                  if (item.kind === "thinking") {
                    const encrypted = item.text.trim() === "[encrypted]"
                    return (
                      <MessageScrollerItem key={i} messageId={String(i)}>
                        <Fold
                          icon={<BrainIcon />}
                          title="Thinking"
                          hint={encrypted ? undefined : oneLine(item.text)}
                          tags={
                            encrypted ? (
                              <Explain term="encrypted">
                                <Badge variant="secondary">encrypted</Badge>
                              </Explain>
                            ) : null
                          }
                        >
                          <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap italic">
                            {item.text}
                          </p>
                        </Fold>
                      </MessageScrollerItem>
                    )
                  }
                  if (item.kind === "tool")
                    return (
                      <MessageScrollerItem key={i} messageId={String(i)}>
                        <Fold
                          icon={<WrenchIcon />}
                          title={toolLabel(item.name ?? "tool", item.text)}
                          hint={oneLine(item.text)}
                          tags={item.is_error ? <Badge variant="destructive">failed</Badge> : null}
                        >
                          <div className="flex flex-col gap-1">
                            <h4 className="text-muted-foreground text-xs tracking-wide uppercase">
                              Input
                            </h4>
                            <Code>{item.text || "(none)"}</Code>
                          </div>
                          <div className="flex flex-col gap-1">
                            <h4 className="text-muted-foreground text-xs tracking-wide uppercase">
                              Result
                            </h4>
                            <Code>
                              {item.output ??
                                "(no result in this request — the call was still running)"}
                            </Code>
                          </div>
                        </Fold>
                      </MessageScrollerItem>
                    )
                  // A harness note: real, but not the person talking.
                  return (
                    <MessageScrollerItem key={i} messageId={String(i)}>
                      <Fold
                        icon={<InfoIcon />}
                        title="Harness note"
                        hint={oneLine(
                          item.text.replace(/^<[^>]+>\s*/, "").replace(/<\/[^>]+>\s*$/, "")
                        )}
                      >
                        <Code>{item.text}</Code>
                      </Fold>
                    </MessageScrollerItem>
                  )
                })}
                {q && !shown.length ? (
                  <p className="text-muted-foreground p-4 text-sm">Nothing matches.</p>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </div>
  )
}
