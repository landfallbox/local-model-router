export function getDesktopApi() {
  if (!window.heimdall) {
    throw new Error("Desktop API is unavailable. Close this window and reopen the app with npm run gui or dist\\Heimdall\\gui.ps1.");
  }

  return window.heimdall;
}