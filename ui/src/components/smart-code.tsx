import { useMemo, useState } from "react"

import { Code } from "@/components/outline-pane"
import { cn } from "@/lib/utils"

// Tool inputs and results are often JSON on one line, with newlines as
// literal \n. That is exact but unreadable. This renders a computed pretty
// view — indented JSON, escapes expanded — with the raw bytes one click
// away, so the reading aid never hides what crossed the wire.

function prettify(text: string): string | null {
  const t = text.trim()
  if (/^[[{]/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "  ")
    } catch {
      // fall through to the line pass
    }
  }
  let changed = false
  const lines = text.split("\n").map((l) => {
    const s = l.trim()
    if (/^[[{]/.test(s) && s.length > 100) {
      try {
        const p = JSON.stringify(JSON.parse(s), null, 2)
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "  ")
        changed = true
        return p
      } catch {
        return l
      }
    }
    return l
  })
  if (changed) return lines.join("\n")
  if ((text.match(/\\n/g)?.length ?? 0) >= 3) return text.replace(/\\n/g, "\n")
  return null
}

export function SmartCode({ children }: { children: string }) {
  const pretty = useMemo(() => prettify(children), [children])
  const [raw, setRaw] = useState(false)
  if (pretty == null) return <Code>{children}</Code>
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end gap-1">
        {(["pretty", "raw"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setRaw(mode === "raw")}
            title={
              mode === "pretty"
                ? "Computed rendering: JSON indented, \\n expanded"
                : "Exactly as captured"
            }
            className={cn(
              "rounded border px-1.5 font-mono text-[10px]",
              (mode === "raw") === raw
                ? "text-foreground bg-accent"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {mode}
          </button>
        ))}
      </div>
      <Code>{raw ? children : pretty}</Code>
    </div>
  )
}
