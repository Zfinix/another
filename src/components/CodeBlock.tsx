export type CodeLang = "json" | "shell" | "toml" | "yaml" | "url";

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;
const URL = /^[a-z]+:\/\//i;

function value(text: string, key: string | number) {
  const trimmed = text.trim();
  const unquoted = trimmed.replace(/^"|"$/g, "");
  if (URL.test(unquoted)) return <span key={key} className="tok-url">{text}</span>;
  if (/^(true|false|null|\d+)$/.test(trimmed)) return <span key={key} className="tok-number">{text}</span>;
  return <span key={key} className="tok-string">{text}</span>;
}

function highlightJson(code: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(code.slice(last, at));
    const [whole, str, colon, num, literal, punct] = match;
    if (str) {
      parts.push(colon ? <span key={at} className="tok-key">{str}</span> : value(str, at));
      if (colon) parts.push(<span key={`${at}:`} className="tok-punct">{colon}</span>);
    } else if (num || literal) {
      parts.push(<span key={at} className="tok-number">{whole}</span>);
    } else if (punct) {
      parts.push(<span key={at} className="tok-punct">{punct}</span>);
    } else {
      parts.push(whole);
    }
    last = at + whole.length;
  }
  if (last < code.length) parts.push(code.slice(last));
  return parts;
}

function highlightShell(code: string) {
  return code.split(/(\s+)/).map((word, i) => {
    if (!word.trim()) return word;
    if (i === 0) return <span key={i} className="tok-command">{word}</span>;
    if (word.startsWith("-")) return <span key={i} className="tok-flag">{word}</span>;
    if (URL.test(word)) return <span key={i} className="tok-url">{word}</span>;
    return <span key={i} className="tok-arg">{word}</span>;
  });
}

function highlightLines(code: string, separator: "=" | ":") {
  return code.split("\n").map((line, i) => {
    const nodes: React.ReactNode[] = [];
    const section = line.match(/^(\s*)(\[[^\]]+\])\s*$/);
    if (section) {
      nodes.push(section[1], <span key="s" className="tok-command">{section[2]}</span>);
    } else {
      const pattern = separator === "=" ? /^(\s*)([\w.-]+)(\s*=\s*)(.*)$/ : /^(\s*)(-\s+)?([\w.-]+)(:)(\s*)(.*)$/;
      const m = line.match(pattern);
      if (m && separator === "=") {
        nodes.push(m[1], <span key="k" className="tok-key">{m[2]}</span>, <span key="p" className="tok-punct">{m[3]}</span>, value(m[4], "v"));
      } else if (m) {
        if (m[2]) nodes.push(m[1], <span key="d" className="tok-punct">{m[2]}</span>);
        else nodes.push(m[1]);
        nodes.push(<span key="k" className="tok-key">{m[3]}</span>, <span key="p" className="tok-punct">{m[4]}</span>, m[5]);
        if (m[6]) nodes.push(value(m[6], "v"));
      } else {
        nodes.push(line);
      }
    }
    return (
      <span key={i}>
        {nodes}
        {i < code.split("\n").length - 1 ? "\n" : ""}
      </span>
    );
  });
}

function highlight(code: string, lang: CodeLang) {
  if (lang === "json") return highlightJson(code);
  if (lang === "toml") return highlightLines(code, "=");
  if (lang === "yaml") return highlightLines(code, ":");
  if (lang === "url") return <span className="tok-url">{code}</span>;
  return highlightShell(code);
}

export function CodeBlock({ code, lang }: { code: string; lang: CodeLang }) {
  return (
    <pre className="code-block">
      <code>{highlight(code, lang)}</code>
    </pre>
  );
}
