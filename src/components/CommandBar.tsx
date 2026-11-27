import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { AppDialog } from "@/components/ui/dialog";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";

export interface CommandDef {
  id: string;
  label: string;
  keys: string[];
  section: string;
  icon: IconName;
  meta?: string;
  /** Extra words the search matches but the row does not show. */
  keywords?: string;
  hidden?: boolean;
  action: () => void;
}

interface CommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: CommandDef[];
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b style={{ fontWeight: 600, color: "var(--foreground)" }}>{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  );
}

export function CommandBar({ open, onOpenChange, commands }: CommandBarProps) {
  const [query, setQuery] = useState("");
  const visible = commands.filter((c) => !c.hidden);
  const sections = [...new Set(visible.map((c) => c.section))];

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  return (
    <AppDialog open={open} onOpenChange={onOpenChange} label="Command bar" top={144} style={{ width: "100%", maxWidth: 576 }}>
      <Command label="Command bar" loop className="flex flex-col gap-2" filter={(value, search) => (value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
        <label className="flex items-center gap-2 px-2" style={{ height: 40, color: "var(--muted)" }}>
          <Icon name="search" />
          <Command.Input value={query} onValueChange={setQuery} placeholder="Search commands" aria-label="Search commands" className="flex-1 min-w-0 bg-transparent outline-none" style={{ fontSize: 15, color: "var(--foreground)" }} autoFocus />
          <span className="kbd">esc</span>
        </label>
        <hr className="rule" />
        <Command.List className="scroll" style={{ maxHeight: "min(420px, calc(100vh - 280px))" }}>
          <Command.Empty className="label" style={{ height: 36 }}>No matching commands</Command.Empty>
          {sections.map((section) => (
            <Command.Group key={section} heading={section} className="cmd-group">
              {visible
                .filter((c) => c.section === section)
                .map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`${c.label} ${c.section} ${c.keywords ?? ""}`}
                    className="item cmd-item"
                    onSelect={() => {
                      onOpenChange(false);
                      c.action();
                    }}
                  >
                    <Icon name={c.icon} />
                    <span className="flex-1 min-w-0 truncate"><Highlight text={c.label} query={query} /></span>
                    {c.meta && <span className="count">{c.meta}</span>}
                    {c.keys.length > 0 && <span className="kbd">{c.keys.join("")}</span>}
                  </Command.Item>
                ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </AppDialog>
  );
}
