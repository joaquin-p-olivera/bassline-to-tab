// Light/dark theme shared by every page. Loaded as a classic script in <head>,
// right after the Tailwind CDN, so the theme is set before the body paints.
//
// The choice is kept in localStorage. On the first visit there is nothing
// stored yet, so the operating system's preference is used and saved.
(() => {
  const KEY = "bassline-to-tab.theme";
  const root = document.documentElement;

  // Tailwind's `dark:` classes follow a `dark` class on <html> instead of the
  // OS setting, so the toggle can override it.
  window.tailwind = window.tailwind || {};
  window.tailwind.config = { ...(window.tailwind.config || {}), darkMode: "class" };

  function read() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      // Storage blocked (private mode, etc.): fall back to the OS.
    }
    return null;
  }

  function save(theme) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Nothing to do; the theme still applies for this page view.
    }
  }

  function apply(theme) {
    root.classList.toggle("dark", theme === "dark");
    // Native controls (selects, scrollbars) follow too.
    root.style.colorScheme = theme;
  }

  let theme = read();
  if (!theme) {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    save(theme);
  }
  apply(theme);

  const SUN =
    '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON =
    '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function render(button) {
    // The button shows the mode it switches to.
    const next = theme === "dark" ? "light" : "dark";
    button.innerHTML = `${next === "light" ? SUN : MOON}<span>${next === "light" ? "Light" : "Dark"}</span>`;
    button.setAttribute("aria-label", `Switch to ${next} mode`);
    button.title = `Switch to ${next} mode`;
  }

  function wire() {
    const buttons = document.querySelectorAll("[data-theme-toggle]");
    buttons.forEach((button) => {
      render(button);
      button.addEventListener("click", () => {
        theme = theme === "dark" ? "light" : "dark";
        save(theme);
        apply(theme);
        buttons.forEach(render);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // Another tab changed the theme: follow it.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    const stored = read();
    if (!stored || stored === theme) return;
    theme = stored;
    apply(theme);
    document.querySelectorAll("[data-theme-toggle]").forEach(render);
  });
})();
