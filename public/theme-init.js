// Paints the saved theme before the app loads, so dark mode never flashes white.
(function () {
  try {
    var pref = localStorage.getItem('cc_theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) { /* storage blocked */ }
})();
