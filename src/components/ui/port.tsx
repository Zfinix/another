import { useEffect, useState } from "react";

const MIN_PORT = 1024;
const MAX_PORT = 65535;

interface PortRowProps {
  label: string;
  value: number;
  onCommit: (port: number) => void;
}

/** A cell with a numeric port that saves on Enter or blur and snaps back when the value is not a valid port. */
export function PortRow({ label, value, onCommit }: PortRowProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const port = Number(draft);
    if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) {
      if (port !== value) onCommit(port);
    } else {
      setDraft(String(value));
    }
  };

  return (
    <label className="row" style={{ cursor: "text" }}>
      <span>{label}</span>
      <input
        className="port-input"
        value={draft}
        inputMode="numeric"
        aria-label={label}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setDraft(String(value)); e.currentTarget.blur(); }
        }}
      />
    </label>
  );
}
