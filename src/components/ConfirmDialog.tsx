import { AppDialog, DialogTitle } from "@/components/ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  detail: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, detail, action, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <AppDialog open={open} onOpenChange={(next) => !next && onCancel()} className="dialog" label={title} top={160} style={{ maxWidth: 380 }}>
      <div className="flex flex-col gap-1">
        <DialogTitle className="h2">{title}</DialogTitle>
        <span className="meta">{detail}</span>
      </div>
      <footer className="flex justify-end gap-2">
        <button type="button" className="button button--secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="button button--primary btn-red" onClick={onConfirm} autoFocus>{action}</button>
      </footer>
    </AppDialog>
  );
}
