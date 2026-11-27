import { useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export interface RecordingFile {
  name: string;
  path: string;
  size: number;
  modified_ms: number;
}

interface RecordingsViewProps {
  files: RecordingFile[];
  folder: string;
  canRecord: boolean;
  onOpen: (file: RecordingFile) => void;
  onReveal: (path: string) => void;
  onDelete: (file: RecordingFile) => void;
}

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(ms: number) {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today, ${time}` : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function RecordingsView({ files, folder, canRecord, onOpen, onReveal, onDelete }: RecordingsViewProps) {
  const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
  const [deleting, setDeleting] = useState<RecordingFile | null>(null);

  if (files.length === 0) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="rise w-full max-w-[400px] flex flex-col gap-4">
          <span className="gi gi--lg logo g-red"><Icon name="recDot" /></span>
          <div className="flex flex-col gap-1">
            <h2 className="h2">No recordings yet</h2>
            <span className="meta">{canRecord ? "Press ⇧⌘R to record the phone screen" : "Mirror a phone, then press ⇧⌘R to record its screen"}</span>
          </div>
          <button type="button" className="button button--primary btn-red self-start" onClick={() => onReveal(folder)}>Open {folderName}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rise flex flex-col gap-8 max-w-[640px]">
      <header className="flex flex-wrap items-center gap-4">
        <div className="flex-[1_1_240px] min-w-0 flex flex-col gap-1">
          <h1 className="title">Recordings</h1>
          <span className="meta">{files.length} in {folderName}</span>
        </div>
        <button type="button" className="button button--primary btn-red" onClick={() => onReveal(files[0].path)}>Show in Finder</button>
      </header>
      <section className="flex flex-col gap-2">
        <div className="label">Screen recordings</div>
        <div className="list">
          {files.map((f) => (
            <div key={f.path} className="row row--icon" style={{ paddingRight: 4 }}>
              <span><span className="gi"><Icon name="video" /></span>{when(f.modified_ms)}</span>
              <span className="flex items-center gap-1">
                <span className="value" style={{ fontVariantNumeric: "tabular-nums", marginRight: 4 }}>{size(f.size)}</span>
                <button type="button" className="icon-button" style={{ width: 28, height: 28 }} aria-label="Open" title="Open" onClick={() => onOpen(f)}><Icon name="open" /></button>
                <button type="button" className="icon-button" style={{ width: 28, height: 28 }} aria-label="Show in Finder" title="Show in Finder" onClick={() => onReveal(f.path)}><Icon name="folder" /></button>
                <button type="button" className="icon-button" style={{ width: 28, height: 28, color: "var(--rec)" }} aria-label="Delete" title="Delete" onClick={() => setDeleting(f)}><Icon name="delete" /></button>
              </span>
            </div>
          ))}
        </div>
      </section>
      <ConfirmDialog
        open={!!deleting}
        title="Delete this recording?"
        detail={deleting ? `${deleting.name} is deleted from ${folderName}. This cannot be undone.` : ""}
        action="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) onDelete(deleting); setDeleting(null); }}
      />
    </div>
  );
}
