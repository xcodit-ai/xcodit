import { render } from "ink";
import { App, type TuiOptions } from "./App.js";
import { caps } from "./theme.js";
import { MOUSE_OFF } from "./mouse.js";

/** Full-screen session in the alternate screen buffer; restores the terminal on exit. */
export async function startTui(opts: TuiOptions): Promise<void> {
  const out = process.stdout;
  // Dumb terminals and pipes get no alternate buffer and no cursor games.
  const alt = caps.tty && process.env.TERM !== "dumb";
  // The mouse stays with the terminal so a plain drag selects text; /mouse on
  // takes it when clicking blocks open is worth more than that.
  if (alt) out.write("\x1b[?1049h\x1b[H");
  const restore = () => { if (alt) out.write(MOUSE_OFF + "\x1b[?1049l"); };
  process.on("exit", restore);
  // A resize can leave stale rows behind; clear once and let Ink repaint.
  const onResize = () => { if (alt) out.write("\x1b[2J\x1b[H"); };
  out.on("resize", onResize);

  const app = render(<App opts={opts} />, { exitOnCtrlC: false, patchConsole: true });
  await app.waitUntilExit();

  out.off("resize", onResize);
  restore();
  process.off("exit", restore);
}
