// Apply the saved theme before the UI paints. Dark is the default on every device.
(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('bot-bots-theme') === 'light') theme = 'light';
  } catch {
    /* The default still works when browser storage is unavailable. */
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.documentElement.style.backgroundColor = theme === 'dark' ? '#202124' : '#f8f7f3';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#202124' : '#f8f7f3');
})();
