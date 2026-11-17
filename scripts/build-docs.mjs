#!/usr/bin/env node
// Renders docs/**/*.md into a static HTML site in site/ (relative links: works from file:// or any static host).
//
//   node scripts/build-docs.mjs
//
// Layout follows the common developer-docs pattern (sidebar, content, "On this page"). It deliberately carries no
// third-party branding: every page says it is an unofficial, AI-generated proof of concept.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import plaintext from "highlight.js/lib/languages/plaintext";
import typescript from "highlight.js/lib/languages/typescript";
import { Marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const OUT = join(ROOT, "site");
const REPO_URL = "https://github.com/markdembo/actors-poc";
const PRODUCT = "Actors";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("plaintext", plaintext);
const LANG_ALIASES = { ts: "typescript", js: "javascript", jsonc: "json", sh: "bash", shell: "bash", txt: "plaintext" };

/** Sidebar, in order. Each page: [title, path under docs/]. */
const NAV = [
  { title: null, pages: [["Overview", "README.md"], ["Get started", "get-started.md"]] },
  { title: "Concepts", pages: [["What are actors?", "concepts/what-are-actors.md"], ["How actors work", "concepts/how-actors-work.md"]] },
  {
    title: "Tutorials",
    pages: [["Build a chat room", "tutorials/build-a-chat-room.md"], ["Build a persistent AI agent", "tutorials/build-an-ai-agent.md"]],
  },
  { title: "Best practices", pages: [["Rules of actors", "best-practices/rules-of-actors.md"], ["WebSockets", "best-practices/websockets.md"]] },
  {
    title: "API",
    pages: [
      ["API reference", "api/README.md"],
      ["actor()", "api/actor.md"],
      ["Action context", "api/action-context.md"],
      ["Connections", "api/connections.md"],
      ["Errors", "api/errors.md"],
      ["Custom classes", "api/durable.md"],
    ],
  },
  {
    title: "Reference",
    pages: [
      ["CLI", "reference/cli.md"],
      ["Configuration", "reference/configuration.md"],
      ["Limits", "reference/limits.md"],
      ["Semantics", "semantics.md"],
    ],
  },
  { title: "About", pages: [["Findings", "findings.md"]] },
];
const ORDER = NAV.flatMap((s) => s.pages.map(([title, path]) => ({ title, path, section: s.title })));

const outPathFor = (docPath) => docPath.replace(/(^|\/)README\.md$/, "$1index.md").replace(/\.md$/, ".html");
const toPosix = (p) => p.split(sep).join("/");
const relLink = (fromOut, toOut) => {
  const r = toPosix(relative(dirname(fromOut), toOut));
  return r === "" ? "./" : r;
};
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Tag-free plain text: strips tags and decodes the entities Marked emits, so it can be escaped exactly once. */
const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
/** GitHub-compatible heading slug, so the same anchors work on GitHub and here. */
const slug = (text) =>
  text.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function renderPage(docPath) {
  const srcFile = join(DOCS, docPath);
  const outFile = outPathFor(docPath);
  const md = readFileSync(srcFile, "utf8");
  const toc = [];
  const seen = new Map();

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        let id = slug(text.replace(/`/g, ""));
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2 || depth === 3) toc.push({ depth, id, html: stripTags(inner) });
        if (depth === 1) return `<h1>${inner}</h1>\n`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const info = lang ?? "";
        const language = LANG_ALIASES[info.split(/\s+/)[0]] ?? info.split(/\s+/)[0] ?? "plaintext";
        const title = info.match(/title="([^"]+)"/)?.[1];
        const body = hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text);
        const label = title ?? (language === "plaintext" ? "" : language === "bash" ? "Terminal" : "");
        return (
          `<figure class="code${label ? " has-title" : ""}">` +
          (label ? `<figcaption><span>${escapeHtml(label)}</span></figcaption>` : "") +
          `<button class="copy" type="button" aria-label="Copy code">Copy</button>` +
          `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre></figure>\n`
        );
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        if (/^https?:\/\//.test(href)) return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener">${inner}</a>`;
        if (href.startsWith("#")) return `<a href="${escapeHtml(href)}"${t}>${inner}</a>`;
        const [pathPart, anchor] = href.split("#");
        const abs = resolve(dirname(srcFile), pathPart);
        const hash = anchor ? `#${anchor}` : "";
        const inDocs = abs.startsWith(DOCS + sep);
        if (inDocs && abs.endsWith(".md")) {
          return `<a href="${escapeHtml(relLink(outFile, outPathFor(toPosix(relative(DOCS, abs)))) + hash)}"${t}>${inner}</a>`;
        }
        // Outside docs/ (README, examples, tests): link to the file on GitHub.
        const repoPath = toPosix(relative(ROOT, abs));
        const kind = existsSync(abs) && statSync(abs).isDirectory() ? "tree" : "blob";
        return `<a href="${REPO_URL}/${kind}/main/${repoPath}${hash}"${t} target="_blank" rel="noopener">${inner}</a>`;
      },
      table(token) {
        // Default table rendering, wrapped for horizontal scrolling on small screens.
        const header = token.header.map((c) => `<th${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
        const rows = token.rows
          .map((r) => `<tr>${r.map((c) => `<td${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
          .join("\n");
        return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });

  let html = marked.parse(md);
  html = toCallouts(html);

  const title = stripTags(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "Docs");
  const description = stripTags(
    html.replace(/<aside[\s\S]*?<\/aside>/g, "").match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "",
  ).trim();
  return { docPath, outFile, html, toc, title, description };
}

/** GitHub alert blockquotes (> [!NOTE]) → callout asides. */
function toCallouts(html) {
  const LABELS = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };
  const open = /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;
  let out = "";
  let rest = html;
  for (let m = rest.match(open); m; m = rest.match(open)) {
    const kind = m[1];
    const end = rest.indexOf("</blockquote>", m.index);
    const body = rest.slice(m.index + m[0].length, end);
    out += `${rest.slice(0, m.index)}<aside class="callout callout-${kind.toLowerCase()}" role="note"><p class="callout-title">${LABELS[kind]}</p><p>${body}</aside>`;
    rest = rest.slice(end + "</blockquote>".length);
  }
  return out + rest;
}

function sidebar(currentOut) {
  return NAV.map((section) => {
    const items = section.pages
      .map(([label, path]) => {
        const out = outPathFor(path);
        const active = out === currentOut ? ' aria-current="page" class="active"' : "";
        return `<li><a href="${relLink(currentOut, out)}"${active}>${escapeHtml(label)}</a></li>`;
      })
      .join("");
    return `<div class="nav-section">${section.title ? `<p class="nav-title">${escapeHtml(section.title)}</p>` : ""}<ul>${items}</ul></div>`;
  }).join("");
}

function layout(page, built) {
  const rel = (p) => relLink(page.outFile, p);
  const i = ORDER.findIndex((o) => o.path === page.docPath);
  const prev = ORDER[i - 1];
  const next = ORDER[i + 1];
  const section = ORDER[i]?.section;
  const toc = page.toc.length
    ? `<p class="toc-title">On this page</p><ul>${page.toc
        .map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${escapeHtml(h.html)}</a></li>`)
        .join("")}</ul>`
    : "";
  const pager = `<nav class="pager" aria-label="Pagination">${
    prev ? `<a class="prev" href="${rel(outPathFor(prev.path))}"><span>Previous</span>${escapeHtml(prev.title)}</a>` : "<span></span>"
  }${next ? `<a class="next" href="${rel(outPathFor(next.path))}"><span>Next</span>${escapeHtml(next.title)}</a>` : "<span></span>"}</nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.docPath === "README.md" ? `${PRODUCT} · unofficial proof of concept` : `${escapeHtml(page.title)} · ${PRODUCT} (unofficial PoC)`}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${rel("assets/style.css")}">
<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<header class="topbar">
  <button class="menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false">☰</button>
  <a class="brand" href="${rel("index.html")}"><span class="brand-mark" aria-hidden="true">◇</span>${PRODUCT}<span class="badge">Unofficial PoC</span></a>
  <span class="spacer"></span>
  <a class="top-link" href="${REPO_URL}" target="_blank" rel="noopener">GitHub ↗</a>
  <button class="theme-toggle" type="button" aria-label="Toggle dark mode">◐</button>
</header>
<div class="disclaimer" role="note"><strong>Unofficial, AI-generated proof of concept.</strong> Not Cloudflare documentation, not affiliated with or endorsed by Cloudflare, and not supported.</div>
<div class="layout">
  <nav class="sidebar" aria-label="Documentation">${sidebar(page.outFile)}</nav>
  <main class="content">
    ${section ? `<p class="crumb">${escapeHtml(section)}</p>` : ""}
    <article>${page.html}</article>
    <p class="meta">Last built ${built} · <a href="${REPO_URL}/blob/main/docs/${page.docPath}" target="_blank" rel="noopener">View source ↗</a></p>
    ${pager}
    <footer class="footer">Generated by AI as part of an experimental proof of concept. No warranty, no support. MIT licensed.</footer>
  </main>
  <aside class="toc" aria-label="On this page">${toc}</aside>
</div>
<script src="${rel("assets/site.js")}"></script>
</body>
</html>
`;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  const built = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  for (const { path } of ORDER) {
    if (!existsSync(join(DOCS, path))) throw new Error(`NAV lists ${path}, which does not exist`);
    const page = renderPage(path);
    const file = join(OUT, page.outFile);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, layout(page, built));
  }
  cpSync(join(ROOT, "scripts/docs-assets"), join(OUT, "assets"), { recursive: true });
  console.log(`Built ${ORDER.length} pages into ${toPosix(relative(process.cwd(), OUT)) || "."}/`);
}

main();
