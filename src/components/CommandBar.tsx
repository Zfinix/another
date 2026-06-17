import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
} from "@/components/ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

interface CommandDef {
  id: string;
  label: string;
  keys: string[];
  section: string;
  action: () => void;
}

interface CommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: CommandDef[];
}

export function CommandBar({ open, onOpenChange, commands }: CommandBarProps) {
  const sections = [...new Set(commands.map((c) => c.section))];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup className="fixed top-20 left-1/2 -translate-x-1/2 w-[360px] max-w-[90vw] max-h-[400px] z-50 animate-in fade-in zoom-in-95 duration-100">
          <Command className="rounded-xl bg-surface border border-border shadow-[0_16px_48px_rgba(0,0,0,0.3)] overflow-hidden">
            <CommandInput placeholder="Type a command..." />
            <CommandList>
              <CommandEmpty>No matching commands</CommandEmpty>
              {sections.map((section) => (
                <CommandGroup key={section} heading={section}>
                  {commands
                    .filter((c) => c.section === section)
                    .map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        onSelect={() => {
                          onOpenChange(false);
                          cmd.action();
                        }}
                      >
                        <span>{cmd.label}</span>
                        {cmd.keys.length > 0 && (
                          <CommandShortcut className="flex gap-1 tracking-normal">
                            {cmd.keys.map((k, i) => (
                              <kbd key={i} className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-[5px] bg-surface-3 border border-border rounded-[5px] text-[11px] font-sans font-medium text-text-2 shadow-[0_1px_0] shadow-border tracking-normal">
                                {k}
                              </kbd>
                            ))}
                          </CommandShortcut>
                        )}
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
