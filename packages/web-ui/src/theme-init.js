// Classic script loaded from <head> so a saved light or dark choice applies before first paint.
// It also follows changes made in another tab. Inline scripts are blocked by the page CSP.
(() => {
  const apply = () => {
    let value = null;
    try { value = localStorage.getItem('scout.theme'); } catch {}
    if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  };
  apply();
  addEventListener('storage', event => { if (event.key === 'scout.theme' || event.key === null) apply(); });
})();
