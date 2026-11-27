import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@/components/Icon";
import { Switch } from "@/components/ui/switch";
import { PortRow } from "@/components/ui/port";
import { CodeBlock } from "@/components/CodeBlock";
import { AGENT_GROUPS, groupLabel, type AgentGroup, type AgentLogoSource } from "@/lib/agents";
import type { IconName } from "@/lib/icons";
import type { ShowToast } from "../types";

const DEFAULT_MCP_PORT = 7070;

const CAPABILITIES: { icon: IconName; text: string }[] = [
  { icon: "eye", text: "See the screen" },
  { icon: "search", text: "Read the UI tree" },
  { icon: "handDraw", text: "Tap and swipe" },
  { icon: "edit", text: "Type text" },
  { icon: "powerOn", text: "Press buttons" },
  { icon: "apps", text: "Open apps and links" },
  { icon: "rotateOn", text: "Rotate the screen" },
  { icon: "console", text: "Run adb commands" },
  { icon: "wandOn", text: "Record and replay macros" },
];

const CLI_EXAMPLES: { command: string; does: string }[] = [
  { command: "another status", does: "What is connected and streaming" },
  { command: "another devices", does: "Phones Another can see" },
  { command: "another connect <serial>", does: "Start mirroring a phone" },
  { command: "another set max_size=1920", does: "Change stream settings live" },
  { command: "another measure", does: "Time touch to screen latency" },
];

function TerminalLine({ command, does, onCopy }: { command: string; does: string; onCopy: (text: string) => void }) {
  const [program, ...rest] = command.split(" ");
  return (
    <button type="button" className="term-line" onClick={() => onCopy(command)} title={`Copy ${command}`}>
      <span className="tok-punct">$</span>
      <span className="truncate">
        <span className="tok-command">{program}</span>{" "}
        {rest.map((part, i) => (
          <span key={i} className={part.startsWith("<") ? "tok-flag" : part.includes("=") ? "tok-string" : "tok-arg"}>{part}{i < rest.length - 1 ? " " : ""}</span>
        ))}
      </span>
      <span className="term-comment"># {does}</span>
      <Icon name="copy" size="sm" className="hover-reveal" />
    </button>
  );
}

const STACK_MAX = 3;

function AgentLogo({ source, size }: { source: AgentLogoSource; size: number }) {
  const dark = document.documentElement.classList.contains("t-dark");
  const src = dark && source.dark ? source.dark : source.src;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={{ width: size, height: size, flexShrink: 0, objectFit: "contain", borderRadius: source.mono || source.dark ? 0 : 4, filter: source.mono && dark ? "invert(1)" : undefined }}
    />
  );
}

function LogoStack({ group }: { group: AgentGroup }) {
  const shown = group.clients.slice(0, STACK_MAX);
  return (
    <span className="logo-stack">
      {shown.map((c) => (
        <span key={c.name} className="logo-stack-item"><AgentLogo source={c.logo} size={16} /></span>
      ))}
    </span>
  );
}

export function AgentsView({ showToast }: { showToast: ShowToast }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("mcp_enabled") !== "false");
  const [running, setRunning] = useState(false);
  const [port, setPort] = useState(() => parseInt(localStorage.getItem("mcp_port") || String(DEFAULT_MCP_PORT), 10));
  const url = `http://localhost:${port}/mcp`;
  const [cliPath, setCliPath] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [groupId, setGroupId] = useState(AGENT_GROUPS[0].id);
  const [copied, setCopied] = useState(false);
  const group = AGENT_GROUPS.find((g) => g.id === groupId) ?? AGENT_GROUPS[0];
  const snippet = group.config(url);

  const check = useCallback(() => {
    invoke<boolean>("get_mcp_status").then(setRunning).catch(() => setRunning(false));
  }, []);

  useEffect(() => {
    check();
    invoke<string | null>("cli_status").then(setCliPath).catch(() => setCliPath(null));
  }, [check]);

  const installCli = async () => {
    setInstalling(true);
    try {
      const path = await invoke<string>("install_cli");
      setCliPath(path);
      showToast("The another command is installed", "success", { detail: "Open a new Terminal window and run another status" });
    } catch (e) {
      if (`${e}` !== "Cancelled") showToast("Could not install the another command", "error", { detail: `${e}` });
    } finally {
      setInstalling(false);
    }
  };

  const toggle = async (on: boolean) => {
    setEnabled(on);
    localStorage.setItem("mcp_enabled", String(on));
    try {
      await invoke(on ? "start_mcp_server" : "stop_mcp_server", on ? { port } : undefined);
    } catch (e) {
      showToast("Could not change the MCP server", "error", { detail: `${e}` });
    }
    check();
  };

  const changePort = async (next: number) => {
    setPort(next);
    localStorage.setItem("mcp_port", String(next));
    if (!enabled) return;
    try {
      await invoke("stop_mcp_server");
      await invoke("start_mcp_server", { port: next });
      showToast(`MCP server moved to port ${next}`, "success", { detail: "Update the address in your agents" });
    } catch (e) {
      showToast(`Could not use port ${next}`, "error", { detail: `${e}` });
    }
    check();
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    showToast("Copied", "success");
  };

  return (
    <div className="rise flex flex-col gap-8 max-w-[680px]">
      <header className="flex items-center gap-4">
        <span className="gi gi--lg logo g-blue"><Icon name="sparkle" /></span>
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="title">AI and the command line</h1>
          <span className="meta">Let agents and scripts see and drive your phone</span>
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <div className="label">MCP server</div>
        <div className="list">
          <div className="row">
            <span>Let AI agents control the phone</span>
            <Switch checked={enabled} onCheckedChange={toggle} label="Let AI agents control the phone" />
          </div>
          <div className="row">
            <span>Status</span>
            <span className="value mono"><span className="dot" style={{ background: running ? "var(--live)" : "var(--muted)" }} />{running ? url : "Off"}</span>
          </div>
          <PortRow label="Port" value={port} onCommit={changePort} />
        </div>
      </section>

      {enabled && (
        <section className="flex flex-col gap-2">
          <div className="label">Add Another to an agent</div>
          <div className="grid gap-1.5" role="tablist" aria-label="Agents" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {AGENT_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={g.id === group.id}
                className={g.id === group.id ? "agent-tile on" : "agent-tile"}
                title={g.clients.map((c) => c.name).join(", ")}
                onClick={() => { setGroupId(g.id); setCopied(false); }}
              >
                {g.clients.length > 1 ? <LogoStack group={g} /> : <AgentLogo source={g.clients[0].logo} size={18} />}
                <span className="truncate">{groupLabel(g)}</span>
              </button>
            ))}
          </div>
          <div className="code-panel" role="tabpanel" aria-label={`Setup for ${group.clients.map((c) => c.name).join(", ")}`}>
            <div className="flex items-start justify-between gap-3">
              <span className="meta" style={{ paddingTop: 6 }}>{group.clients.length === 1 ? group.clients[0].where : "Paste this into each app's MCP settings"}</span>
              <button
                type="button"
                className="button button--secondary"
                style={{ height: 28, padding: "0 10px", fontSize: 13, color: "var(--muted)", flexShrink: 0 }}
                onClick={() => { copy(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              >
                <Icon name={copied ? "done" : "copy"} size="sm" />{copied ? "Copied" : "Copy"}
              </button>
            </div>
            <CodeBlock code={snippet} lang={group.lang} />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="label">What agents can do</div>
        <div className="flex flex-wrap gap-2">
          {CAPABILITIES.map((c) => (
            <span key={c.text} className="chip">
              <Icon name={c.icon} size="sm" />
              {c.text}
            </span>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="label">Command line</div>
        <div className="code-panel">
          <div className="flex items-center justify-between gap-3">
            <span className="meta">{cliPath ? <>Installed as <span className="mono">another</span> in {cliPath.replace(/\/another$/, "")}</> : <>Add the <span className="mono">another</span> command to your Terminal</>}</span>
            {cliPath ? (
              <span className="value" style={{ fontSize: 13 }}><Icon name="done" style={{ color: "var(--live)" }} />Installed</span>
            ) : (
              <button type="button" className="button button--primary" style={{ height: 28, padding: "0 12px", fontSize: 13 }} onClick={installCli} disabled={installing}>
                {installing ? <span className="spinner" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} /> : "Install"}
              </button>
            )}
          </div>
          <div className="terminal">
            {CLI_EXAMPLES.map((e) => <TerminalLine key={e.command} command={e.command} does={e.does} onCopy={copy} />)}
          </div>
        </div>
        <span className="meta" style={{ padding: "0 12px" }}>another talks to this app while it runs. Click a line to copy it.</span>
      </section>
    </div>
  );
}
