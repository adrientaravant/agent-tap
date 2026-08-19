import { useState } from "react"
import { BrainIcon, ChevronRightIcon, InfoIcon, WrenchIcon } from "lucide-react"

import { Code } from "@/components/outline-pane"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
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
    // autoScroll opens the thread at its live edge and follows growth, which
    // is where a captured conversation is read from; scrolling up detaches.
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 p-4">
            {items.map((item, i) => {
              if (item.kind === "user" || item.kind === "assistant")
                return (
                  <MessageScrollerItem
                    key={i}
                    messageId={String(i)}
                    scrollAnchor={item.kind === "user"}
                  >
                    <Message align={item.kind === "user" ? "end" : "start"}>
                      <MessageContent>
                        <MessageHeader>
                          {item.kind === "user" ? "You" : "Agent"}
                        </MessageHeader>
                        <Bubble
                          variant={item.kind === "user" ? "default" : "muted"}
                          align={item.kind === "user" ? "end" : "start"}
                        >
                          <BubbleContent>
                            <ClampedText text={item.text} />
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                )
              if (item.kind === "thinking")
                return (
                  <MessageScrollerItem key={i} messageId={String(i)}>
                    <Fold icon={<BrainIcon />} title="Thinking" hint={oneLine(item.text)}>
                      <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap italic">
                        {item.text}
                      </p>
                    </Fold>
                  </MessageScrollerItem>
                )
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
                    hint={oneLine(item.text.replace(/^<[^>]+>\s*/, "").replace(/<\/[^>]+>\s*$/, ""))}
                  >
                    <Code>{item.text}</Code>
                  </Fold>
                </MessageScrollerItem>
              )
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
