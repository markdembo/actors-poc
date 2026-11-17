// Docs site behavior: copy buttons, theme toggle, mobile nav, "On this page" highlighting.
(() => {
  for (const btn of document.querySelectorAll("figure.code .copy")) {
    btn.addEventListener("click", async () => {
      const code = btn.parentElement.querySelector("code").innerText;
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Press ⌘C";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
  }

  const root = document.documentElement;
  document.querySelector(".theme-toggle")?.addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("theme", root.dataset.theme);
    } catch {}
  });

  const toggle = document.querySelector(".menu-toggle");
  toggle?.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  const links = [...document.querySelectorAll(".toc a")];
  const headings = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (headings.length && "IntersectionObserver" in window) {
    const visible = new Set();
    const mark = () => {
      const first = headings.find((h) => visible.has(h)) ?? null;
      if (!first) return;
      for (const a of links) a.classList.toggle("current", a.hash === `#${first.id}`);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
        mark();
      },
      { rootMargin: "-64px 0px -70% 0px" },
    );
    headings.forEach((h) => io.observe(h));
  }
})();
