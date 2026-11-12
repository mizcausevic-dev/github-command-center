// Applies the saved theme before first paint (separate file: the CSP forbids inline scripts).
(function () {
  var themes = ["bento", "cosmic", "swiss", "aqua", "brutalist", "tactical", "parchment"];
  var theme = "bento";
  var mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  try {
    var saved = JSON.parse(localStorage.getItem("gcc.theme") || "null");
    if (saved && themes.indexOf(saved.theme) !== -1) theme = saved.theme;
    if (saved && (saved.mode === "light" || saved.mode === "dark")) mode = saved.mode;
  } catch (e) {}
  // Shareable overrides: ?theme=swiss&mode=light
  var params = new URLSearchParams(location.search);
  if (themes.indexOf(params.get("theme")) !== -1) theme = params.get("theme");
  if (params.get("mode") === "light" || params.get("mode") === "dark") mode = params.get("mode");
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-mode", mode);
})();
