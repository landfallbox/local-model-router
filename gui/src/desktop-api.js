export function getDesktopApi() {
  if (!window.localModelRouter) {
    throw new Error("Desktop API is unavailable. Close this window and reopen the app with npm run gui or dist\\LocalModelRouter\\gui.ps1.");
  }

  return window.localModelRouter;
}