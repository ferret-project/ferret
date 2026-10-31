// Appearance — Automatic (follow the device), Light or Dark — applied before the page draws, so a Dark choice never
// flashes light. A file of its own rather than an inline script: the app's CSP allows only its own script files.
// The choice is per device, under the same name the help (/docs, VitePress) uses, so the two always match.
(function () {
  var KEY = "vitepress-theme-appearance";
  var COLORS = { light: "#fdf9f4", dark: "#28211c" }; // base-100: the header, so the status bar matches it
  var system = window.matchMedia("(prefers-color-scheme: dark)");

  function choice() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }

  function apply() {
    var c = choice();
    var dark = c === "dark" || (c === "auto" && system.matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.dataset.appearance = c;
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", dark ? COLORS.dark : COLORS.light);
    window.dispatchEvent(new CustomEvent("ferret:appearance", { detail: { choice: c, dark: dark } }));
  }

  window.ferretAppearance = {
    get: choice,
    set: function (c) {
      try {
        if (c === "auto") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, c);
      } catch (e) {
        // private browsing: this page only
      }
      apply();
    },
    isDark: function () {
      return document.documentElement.classList.contains("dark");
    },
  };

  system.addEventListener("change", apply);
  // Changed in another tab, or in the help.
  window.addEventListener("storage", function (e) {
    if (e.key === KEY || e.key === null) apply();
  });
  apply();
})();
