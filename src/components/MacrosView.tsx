import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@/components/Icon";
import { ContextMenu, MenuPopup, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { macroSteps, type MacroStep } from "@/lib/macroSteps";
import type { MacroInfo } from "../hooks/useMacro";
import type { SavedMacro } from "../types";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const TONES = ["g-violet", "g-blue", "g-orange", "g-pink", "g-teal", "g-green"];

interface MacrosViewProps {
  macros: MacroInfo[];
  macrosDir: string;
  playingMacro: string | null;
  canRun: boolean;
  onRecord: () => void;
  onRun: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onExport: (name: string) => void;
  onImport: () => void;
}

export function MacrosView({ macros, macrosDir, playingMacro, canRun, onRecord, onRun, onRename, onDelete, onExport, onImport }: MacrosViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<MacroStep[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const current = macros.find((m) => m.name === selected) ?? macros[0] ?? null;

  useEffect(() => {
    if (!current || !macrosDir) {
      setSteps(null);
      return;
    }
    let cancelled = false;
    invoke<SavedMacro>("load_macro_file", { dir: macrosDir, name: current.name })
      .then((m) => !cancelled && setSteps(macroSteps(m.events)))
      .catch(() => !cancelled && setSteps([]));
    return () => { cancelled = true; };
  }, [current?.name, current?.event_count, macrosDir]);

  const saveRename = () => {
    const name = draft.trim();
    if (renaming && name && name !== renaming) {
      onRename(renaming, name);
      setSelected(name);
    }
    setRenaming(null);
  };

  const runTitle = canRun ? "Run on the phone you are mirroring" : "Mirror a phone to run macros";

  if (macros.length === 0) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="rise w-full max-w-[400px] flex flex-col gap-4">
          <span className="gi gi--lg logo g-violet"><Icon name="wandOn" /></span>
          <div className="flex flex-col gap-1">
            <h2 className="h2">No macros yet</h2>
            <span className="meta">{canRun ? "Press ⇧⌘M to record what you do on the phone" : "Mirror a phone, then press ⇧⌘M to record what you do"}</span>
          </div>
          <div className="flex gap-2">
            <button type="button" className={canRun ? "button button--secondary" : "button button--primary btn-violet"} onClick={onImport}>Import from a file</button>
            {canRun && <button type="button" className="button button--primary btn-violet" onClick={onRecord}><Icon name="record" />Record</button>}
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="rise flex gap-8 min-h-full">
      <div className="flex-[0_0_224px] min-w-0 flex flex-col gap-0.5">
        <div className="label">Macros</div>
        {macros.map((m, index) =>
          renaming === m.name ? (
            <label key={m.name} className="field">
              <input value={draft} aria-label="Macro name" autoFocus onChange={(e) => setDraft(e.target.value)} onBlur={saveRename} onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenaming(null); }} />
            </label>
          ) : (
            <ContextMenu.Root key={m.name}>
              <ContextMenu.Trigger render={<button type="button" className={current?.name === m.name ? "item on" : "item"} onClick={() => setSelected(m.name)} />}>
                <span className={`gi ${TONES[index % TONES.length]}`}><Icon name="wandOn" /></span>
                <span className="flex-1 min-w-0 truncate text-left">{m.name}</span>
                <span className="count">{m.event_count}</span>
              </ContextMenu.Trigger>
              <MenuPopup context width={208}>
                <MenuItem icon="play" label="Run" disabled={!canRun} onClick={() => onRun(m.name)} />
                <MenuItem icon="edit" label="Rename" onClick={() => { setDraft(m.name); setRenaming(m.name); }} />
                <MenuItem icon="copy" label="Export" onClick={() => onExport(m.name)} />
                <MenuSeparator />
                <MenuItem icon="trash" label="Delete" danger onClick={() => setDeleting(m.name)} />
              </MenuPopup>
            </ContextMenu.Root>
          ),
        )}
        <button type="button" className="item mt-2" style={{ color: "var(--muted)" }} onClick={onRecord} disabled={!canRun} title={canRun ? "Record a new macro" : "Mirror a phone to record"}>
          <Icon name="add" />
          <span className="flex-1 text-left">New macro</span>
        </button>
        <button type="button" className="item" style={{ color: "var(--muted)" }} onClick={onImport}>
          <Icon name="folder" />
          <span className="flex-1 text-left">Import</span>
        </button>
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-8">
        {current && (
          <>
            <header className="flex flex-wrap items-center gap-4">
              <div className="flex-[1_1_240px] min-w-0 flex flex-col gap-1">
                <h1 className="title truncate">{current.name}</h1>
                <span className="meta">{steps ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}${canRun ? "" : " · Mirror a phone to run or record"}` : " "}</span>
              </div>
              <div className="flex gap-2">
                <button type="button" className="button button--secondary" onClick={onRecord} disabled={!canRun} title={canRun ? "Record a new macro" : "Mirror a phone to record"}>
                  <Icon name="record" />Record
                </button>
                <button type="button" className="button button--primary btn-violet" onClick={() => onRun(current.name)} disabled={!canRun || !!playingMacro} title={runTitle}>
                  {playingMacro === current.name ? <span className="spinner" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} /> : <Icon name="playOn" />}Run
                </button>
              </div>
            </header>
            <section className="flex flex-col gap-2">
              <div className="label">Steps</div>
              <div className="list">
                {(steps ?? []).map((s, n) => (
                  <div key={n} className="row" style={{ justifyContent: "flex-start" }}>
                    <span className="mono" style={{ width: 16, color: "var(--muted)", flexShrink: 0 }}>{n + 1}</span>
                    <Icon name={s.icon} style={{ color: "var(--foreground)" }} />
                    <span className="flex-1 min-w-0 truncate">{s.text}</span>
                    {s.target && <span className="mono truncate" style={{ color: "var(--muted)", maxWidth: "45%" }}>{s.target}</span>}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting ?? ""}?`}
        detail="The macro file is removed from the macros folder."
        action="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) onDelete(deleting); setDeleting(null); }}
      />
    </div>
  );
}
