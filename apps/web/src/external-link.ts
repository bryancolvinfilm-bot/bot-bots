export function openExternal(url: string) {
  if (window.botBotsDesktop?.openExternal) return window.botBotsDesktop.openExternal(url);
  window.open(url, '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}
