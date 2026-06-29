// Best-effort local audio playback for the `--play` flag.
//
// We shell out to whatever player the platform ships or the user installed,
// trying candidates in order. Playback is a convenience, never load-bearing: the
// caller has already written the audio file, so a missing player is a warning.
import { spawn } from "node:child_process";
import { platform } from "node:os";

export class PlaybackUnavailableError extends Error {
  constructor() {
    super("No audio player found. Install ffmpeg (provides ffplay) or mpv, or open the saved file manually.");
    this.name = "PlaybackUnavailableError";
  }
}

interface Player {
  cmd: string;
  args: (file: string) => string[];
}

function candidates(): Player[] {
  switch (platform()) {
    case "darwin":
      return [{ cmd: "afplay", args: (f) => [f] }];
    case "win32":
      return [
        { cmd: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] },
        { cmd: "powershell", args: (f) => ["-c", `(New-Object Media.SoundPlayer '${f}').PlaySync();`] },
      ];
    default:
      return [
        { cmd: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] },
        { cmd: "mpv", args: (f) => ["--no-video", "--really-quiet", f] },
        { cmd: "paplay", args: (f) => [f] },
        { cmd: "aplay", args: (f) => [f] },
      ];
  }
}

type Outcome = "ok" | "missing" | "failed";

function trySpawn(cmd: string, args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", (err) => {
      resolve((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed");
    });
    child.on("close", (code) => resolve(code === 0 ? "ok" : "failed"));
  });
}

export async function playAudio(filePath: string): Promise<void> {
  for (const player of candidates()) {
    const outcome = await trySpawn(player.cmd, player.args(filePath));
    if (outcome === "ok") return;
    // "missing" or "failed": fall through to the next candidate.
  }
  throw new PlaybackUnavailableError();
}
