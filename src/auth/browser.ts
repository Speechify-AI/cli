// Open a URL in the user's default browser. Best-effort and non-blocking — if it
// fails, the caller has already printed the URL for manual paste.
import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(cmd, [...args], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignored — the URL was printed for manual use.
  }
}
