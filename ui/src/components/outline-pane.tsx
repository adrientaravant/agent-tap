import { useMemo, useState } from "react"

import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export type OutlineItem = {
  id: string
  label: string
  hint?: string
  tags?: string[]
  search?: string
}

// A filterable list beside the content. A session can send more than two
// hundred tools, so a flat list of expanded blocks is unreadable.
export function OutlinePane({
  items,
  selected,
  onSelect,
  placeholder,
  children,
}: {
  items: OutlineItem[]
  selected: string | null
  onSelect: (id: string) => void
  placeholder: string
  children: React.ReactNode
}) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => (i.search ?? i.label + " " + (i.hint ?? "")).toLowerCase().includes(q))
  }, [items, query])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-64 min-w-56 shrink-0 flex-col overflow-hidden border-r">
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="h-8"
          />
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col p-1">
            {filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "hover:bg-accent flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  selected === item.id && "bg-accent"
                )}
              >
                <span className="w-full truncate font-mono text-xs">{item.label}</span>
                {item.hint ? (
                  <span className="text-muted-foreground w-full truncate text-[11px]">
                    {item.hint}
                  </span>
                ) : null}
                {item.tags?.length ? (
                  <span className="text-primary font-mono text-[10px]">{item.tags.join(" · ")}</span>
                ) : null}
              </button>
            ))}
            {filtered.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">Nothing matches.</p>
            ) : null}
          </div>
        </ScrollArea>
        <div className="text-muted-foreground border-t px-3 py-1.5 font-mono text-[11px]">
          {filtered.length} / {items.length}
        </div>
      </div>
      <ScrollArea className="min-w-0 flex-1">
        <div className="p-4">{children}</div>
      </ScrollArea>
    </div>
  )
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-muted/40 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {children}
    </pre>
  )
}
