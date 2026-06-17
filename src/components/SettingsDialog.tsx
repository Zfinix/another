import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDownIcon,
  ClipboardDocumentIcon,
  FolderOpenIcon,
} from "@heroicons/react/24/outline";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Settings, QuickActionId } from "../types";
import { PRESETS, RESOLUTION_OPTIONS, CODEC_OPTIONS, QUICK_ACTIONS } from "../types";

const DEFAULT_MCP_PORT = 7070;
const APP_VERSION = "0.3.0";

function getMcpUrl(port: number) {
  return `http://localhost:${port}/mcp`;
}

function getMcpConfig(port: number) {
  return JSON.stringify({
    mcpServers: {
      another: { type: "http", url: getMcpUrl(port) },
    },
  }, null, 2);
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  activePreset: string;
  pinnedActions: QuickActionId[];
  onApplyPreset: (name: string) => void;
  onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onPinnedActionsChange: (actions: QuickActionId[]) => void;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function SectionHeader({ children, open }: { children: React.ReactNode; open?: boolean }) {
  return (
    <CollapsibleTrigger className="flex items-center justify-between w-full px-5 py-3 border-b border-border/60 cursor-pointer hover:bg-surface-hover/50 transition-colors">
      <span className="text-[10px] font-bold uppercase tracking-widest text-text-3">{children}</span>
      <ChevronDownIcon className={cn("size-3 text-text-3 transition-transform duration-200", open && "rotate-180")} />
    </CollapsibleTrigger>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  activePreset,
  pinnedActions,
  onApplyPreset,
  onUpdateSetting,
  onPinnedActionsChange,
}: SettingsDialogProps) {
  const [mcpInstructionsOpen, setMcpInstructionsOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  const [videoOpen, setVideoOpen] = useState(true);
  const [audioOpen, setAudioOpen] = useState(true);
  const [storageOpen, setStorageOpen] = useState(true);
  const [mcpOpen, setMcpOpen] = useState(true);
  const [savePath, setSavePath] = useState(() => localStorage.getItem("save_path") || "");
  const [toolbarOpen, setToolbarOpen] = useState(true);

  const [mcpEnabled, setMcpEnabled] = useState(() => {
    const stored = localStorage.getItem("mcp_enabled");
    return stored === null ? true : stored === "true";
  });
  const [mcpPort] = useState(() => {
    const stored = localStorage.getItem("mcp_port");
    return stored ? parseInt(stored, 10) : DEFAULT_MCP_PORT;
  });
  const [mcpRunning, setMcpRunning] = useState(false);

  const checkMcpStatus = useCallback(async () => {
    try {
      const running = await invoke<boolean>("get_mcp_status");
      setMcpRunning(running);
    } catch { }
  }, []);

  useEffect(() => {
    checkMcpStatus();
  }, [checkMcpStatus]);

  async function handleMcpToggle(enabled: boolean) {
    setMcpEnabled(enabled);
    localStorage.setItem("mcp_enabled", String(enabled));
    try {
      if (enabled) {
        await invoke("start_mcp_server", { port: mcpPort });
      } else {
        await invoke("stop_mcp_server");
      }
      await checkMcpStatus();
    } catch { }
  }

  function handleCopyUrl() {
    copyToClipboard(getMcpUrl(mcpPort));
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  }

  function handleCopySnippet(key: string, text: string) {
    copyToClipboard(text);
    setCopiedSnippet(key);
    setTimeout(() => setCopiedSnippet(null), 2000);
  }

  const mcpConfig = getMcpConfig(mcpPort);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          className="fixed left-0 right-0 bottom-0 max-h-[92vh] bg-surface border-t border-border rounded-t-2xl flex flex-col overflow-y-auto z-51 animate-in slide-in-from-bottom duration-250 no-scrollbar"
        >
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <DialogTitle className="text-[15px] font-bold text-foreground">Settings</DialogTitle>
          </div>

          <div className="px-5 py-4 border-b border-border/60">
            <div className="text-[10px] font-bold uppercase tracking-widest text-text-3 mb-3.5">Presets</div>
            <div className="flex gap-1.5">
              {Object.keys(PRESETS).map((name) => (
                <Button
                  key={name}
                  variant={activePreset === name ? "default" : "outline"}
                  size="sm"
                  className="flex-1 text-[11px]"
                  onClick={() => onApplyPreset(name)}
                >
                  {name.charAt(0).toUpperCase() + name.slice(1)}
                </Button>
              ))}
            </div>
          </div>

          <Collapsible open={videoOpen} onOpenChange={setVideoOpen}>
            <SectionHeader open={videoOpen}>Video</SectionHeader>
            <CollapsibleContent>
              <div className="px-5 py-4 border-b border-border/60">
                <div style={{ opacity: settings.adaptive ? 0.5 : 1, pointerEvents: settings.adaptive ? 'none' : 'auto' }}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[13px] font-medium text-foreground">Resolution</span>
                    <Select value={settings.max_size} onValueChange={(val) => onUpdateSetting("max_size", val as number)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue>{RESOLUTION_OPTIONS.find((o) => o.value === settings.max_size)?.label}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {RESOLUTION_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[13px] font-medium text-foreground">Max FPS</span>
                    <span className="text-xs font-medium font-mono text-text-2 min-w-[50px] text-right">{settings.max_fps}</span>
                  </div>
                  <Slider
                    className="mb-1"
                    value={settings.max_fps}
                    onValueChange={(val) => onUpdateSetting("max_fps", val as number)}
                    min={15} max={120} step={5}
                  />

                  <div className="flex items-center justify-between mb-3 mt-3">
                    <span className="text-[13px] font-medium text-foreground">Bitrate</span>
                    <span className="text-xs font-medium font-mono text-text-2 min-w-[50px] text-right">{(settings.video_bit_rate / 1000000).toFixed(0)} Mbps</span>
                  </div>
                  <Slider
                    className="mb-1"
                    value={settings.video_bit_rate}
                    onValueChange={(val) => onUpdateSetting("video_bit_rate", val as number)}
                    min={1000000} max={32000000} step={1000000}
                  />
                </div>

                <div className="flex items-center justify-between mt-3">
                  <span className="text-[13px] font-medium text-foreground">Codec</span>
                  <Select value={settings.video_codec} onValueChange={(val) => onUpdateSetting("video_codec", val as string)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue>{CODEC_OPTIONS.find((o) => o.value === settings.video_codec)?.label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {CODEC_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between mt-4">
                  <span className="text-[13px] font-medium text-foreground">Adaptive Quality</span>
                  <Switch
                    checked={settings.adaptive}
                    onCheckedChange={(checked) => onUpdateSetting("adaptive", checked)}
                  />
                </div>
                <div className="text-[11px] text-text-3 mt-1">Automatically adjusts quality based on network conditions</div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={audioOpen} onOpenChange={setAudioOpen}>
            <SectionHeader open={audioOpen}>Audio</SectionHeader>
            <CollapsibleContent>
              <div className="px-5 py-4 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-foreground">Forward device audio</span>
                  <Switch
                    checked={settings.audio}
                    onCheckedChange={(checked) => onUpdateSetting("audio", checked)}
                  />
                </div>
                <div className="text-[11px] text-text-3 mt-2">Requires Android 11+</div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={storageOpen} onOpenChange={setStorageOpen}>
            <SectionHeader open={storageOpen}>Storage</SectionHeader>
            <CollapsibleContent>
              <div className="px-5 py-4 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-foreground">Save location</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[11px] gap-1.5 [&_svg]:size-3.5"
                    onClick={async () => {
                      const dir = await openDialog({ directory: true, multiple: false });
                      if (dir) {
                        setSavePath(dir);
                        localStorage.setItem("save_path", dir);
                      }
                    }}
                  >
                    <FolderOpenIcon />
                    Browse
                  </Button>
                </div>
                {savePath ? (
                  <div className="flex items-center justify-between mt-2.5">
                    <code className="text-[11px] font-mono text-text-2 truncate flex-1 mr-2">{savePath}</code>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-[10px] text-text-3 shrink-0"
                      onClick={() => {
                        setSavePath("");
                        localStorage.removeItem("save_path");
                      }}
                    >
                      Reset
                    </Button>
                  </div>
                ) : (
                  <div className="text-[11px] text-text-3 mt-2">Screenshots and recordings will use browser downloads</div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={toolbarOpen} onOpenChange={setToolbarOpen}>
            <SectionHeader open={toolbarOpen}>Toolbar</SectionHeader>
            <CollapsibleContent>
              <div className="px-5 py-4 border-b border-border/60">
                <div className="text-[11px] text-text-3 mb-3">Toggle quick-action buttons on the toolbar</div>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_ACTIONS.map((action) => {
                    const active = pinnedActions.includes(action.id);
                    return (
                      <Button
                        key={action.id}
                        variant={active ? "default" : "outline"}
                        size="sm"
                        className="text-[11px]"
                        onClick={() => {
                          const next = active
                            ? pinnedActions.filter((a) => a !== action.id)
                            : [...pinnedActions, action.id];
                          onPinnedActionsChange(next);
                          localStorage.setItem("pinned_actions", JSON.stringify(next));
                        }}
                      >
                        {action.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={mcpOpen} onOpenChange={setMcpOpen}>
            <SectionHeader open={mcpOpen}>MCP Server</SectionHeader>
            <CollapsibleContent>
              <div className="px-5 py-4 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-foreground">Enabled</span>
                  <Switch
                    checked={mcpEnabled}
                    onCheckedChange={handleMcpToggle}
                  />
                </div>
                {mcpRunning && (
                  <div className="text-[13px] font-medium text-foreground mt-1.5">Running on port {mcpPort}</div>
                )}
                {mcpEnabled && (
                  <div className="mt-3.5">
                    <p className="text-[11px] text-text-3 mb-3">Let AI agents control your Android device</p>
                    <div className="flex items-center gap-2 mb-3">
                      <code className="flex-1 py-2 px-2.5 bg-surface-2 border border-border rounded-md text-xs font-mono text-foreground select-text">{getMcpUrl(mcpPort)}</code>
                      <Button variant="outline" size="xs" className="shrink-0 [&_svg]:size-[13px]" onClick={handleCopyUrl}>
                        <ClipboardDocumentIcon />
                        {copiedUrl ? "Copied" : "Copy URL"}
                      </Button>
                    </div>
                    <Button variant="ghost" className="flex items-center justify-between w-full h-auto p-0 mt-1 mb-1 text-foreground" onClick={() => setMcpInstructionsOpen(!mcpInstructionsOpen)}>
                      <span className="text-[13px] font-medium">Setup Instructions</span>
                      <ChevronDownIcon className={cn("size-3.5 text-text-3 transition-transform duration-150", mcpInstructionsOpen && "rotate-180")} />
                    </Button>
                    {mcpInstructionsOpen && (
                      <div className="flex flex-col gap-2.5 mt-2.5">
                        <div className="border border-border rounded-lg overflow-hidden">
                          <div className="flex items-center justify-between py-1.5 px-2.5 bg-surface-2 border-b border-border">
                            <span className="text-[11px] font-semibold text-text-2">Claude Code, Claude Desktop, Cursor, etc.</span>
                            <Button variant="outline" size="xs" className="shrink-0 text-[10px] [&_svg]:size-[11px]" onClick={() => handleCopySnippet("config", mcpConfig)}>
                              <ClipboardDocumentIcon />
                              {copiedSnippet === "config" ? "Copied" : "Copy"}
                            </Button>
                          </div>
                          <pre className="p-2.5 m-0 text-[11px] font-mono text-foreground bg-surface overflow-x-auto leading-relaxed select-text">{mcpConfig}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="px-5 py-4 text-[11px] text-text-3 flex items-center justify-between">
            <span>Another v{APP_VERSION}</span>
            <span>Changes apply live</span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
