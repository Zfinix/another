import { useState, useEffect, useRef, useCallback } from "react";

interface Command {
  id: string;
  label: string;
  keys: string[];
  section: string;
  action: () => void;
}

interface CommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}

export function CommandBar({ open, onOpenChange, commands }: CommandBarProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query
    ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands;

  const sections = [...new Set(filtered.map((c) => c.section))];

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector("[data-selected]");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const run = useCallback((cmd: Command) => {
    onOpenChange(false);
    cmd.action();
  }, [onOpenChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      run(filtered[selectedIndex]);
    } else if (e.key === "Escape") {
      onOpenChange(false);
    }
  };

  if (!open) return null;

  let itemIndex = 0;

  return (
    <div className="cmdbar-overlay" onClick={() => onOpenChange(false)}>
      <div className="cmdbar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdbar-input"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmdbar-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="cmdbar-empty">No matching commands</div>
          )}
          {sections.map((section) => (
            <div key={section}>
              <div className="cmdbar-section">{section}</div>
              {filtered
                .filter((c) => c.section === section)
                .map((cmd) => {
                  const idx = itemIndex++;
                  return (
                    <div
                      key={cmd.id}
                      className={`cmdbar-item ${idx === selectedIndex ? "selected" : ""}`}
                      data-selected={idx === selectedIndex ? "" : undefined}
                      onClick={() => run(cmd)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <span className="cmdbar-item-label">{cmd.label}</span>
                      {cmd.keys.length > 0 && (
                        <span className="cmdbar-keys">
                          {cmd.keys.map((k, i) => <kbd key={i} className="cmdbar-key">{k}</kbd>)}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
