// A raw-mode line editor (readline) for the interactive shell prompt.
//
// The kernel TTY is a *cooked* line discipline for programs that read stdin. An
// interactive shell instead does its own editing in raw mode — exactly how
// bash/GNU readline work — because cooked mode has no cursor movement or history.
// So the REPL feeds this editor the raw keystrokes and paints the result itself:
// in-line cursor motion (←/→, Home/End, Ctrl-A/E/B/F), editing (Backspace, Del,
// Ctrl-U/K/W), and ↑/↓ history.
//
// It is pure and event-driven — `feed(bytes)` in, terminal output through the
// injected `write`, and a single `done(result)` when the line is submitted — so
// it unit-tests without a real terminal.

const dec = new TextDecoder();

/**
 * @param {object} o
 * @param {string} o.prompt   the prompt string (already styled)
 * @param {string[]} o.history shared history ring (most-recent last); read-only here
 * @param {(s: string) => void} o.write  emit terminal bytes/ANSI (as a string)
 * @param {(r: {line?: string, aborted?: boolean, eof?: boolean}) => void} o.done
 * @returns {{ start: () => void, feed: (bytes: Uint8Array) => void }}
 */
export function createLineEditor({ prompt, history = [], write, done }) {
  let buf = []; // the line as an array of characters (one JS char each)
  let pos = 0; // cursor index within buf
  let hist = history.length; // history cursor; === length means "editing a new line"
  let stash = ""; // the new line saved while browsing history
  let escBuf = null; // chars of an in-progress ESC sequence, or null
  let finished = false;

  // Redraw the whole line: CR to column 0, prompt, text, clear to EOL, then move
  // the cursor back to `pos`. Single-line only (no soft-wrap) — see §4.
  const render = () => {
    let out = "\r" + prompt + buf.join("") + "\x1b[K";
    const tail = buf.length - pos;
    if (tail > 0) out += "\x1b[" + tail + "D";
    write(out);
  };

  const setLine = (s) => { buf = [...s]; pos = buf.length; };
  const finish = (r) => { if (!finished) { finished = true; done(r); } };

  const historyPrev = () => {
    if (hist === 0) return;
    if (hist === history.length) stash = buf.join("");
    hist--;
    setLine(history[hist]);
    render();
  };
  const historyNext = () => {
    if (hist === history.length) return;
    hist++;
    setLine(hist === history.length ? stash : history[hist]);
    render();
  };

  // Handle a recognized escape sequence (the bytes after ESC), e.g. "[A", "[3~".
  const handleEsc = (seq) => {
    const m = seq.match(/^[[O]([0-9;]*)([A-Z~])$/);
    if (!m) return;
    const [, param, final] = m;
    if (final === "A") historyPrev();
    else if (final === "B") historyNext();
    else if (final === "C") { if (pos < buf.length) { pos++; render(); } } // →
    else if (final === "D") { if (pos > 0) { pos--; render(); } } // ←
    else if (final === "H" || param === "1" || param === "7") { pos = 0; render(); } // Home
    else if (final === "F" || param === "4" || param === "8") { pos = buf.length; render(); } // End
    else if (final === "~" && param === "3") { if (pos < buf.length) { buf.splice(pos, 1); render(); } } // Del
  };

  const insertStr = (s) => { for (const ch of s) buf.splice(pos++, 0, ch); render(); };

  const feed = (bytes) => {
    if (finished) return;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u8.length && !finished; i++) {
      const b = u8[i];

      // Inside an escape sequence: accumulate until a final byte, then dispatch.
      if (escBuf !== null) {
        const ch = String.fromCharCode(b);
        if (escBuf.length === 0) {
          if (ch === "[" || ch === "O") escBuf.push(ch);
          else escBuf = null; // lone ESC + key (Alt-x): ignore
          continue;
        }
        escBuf.push(ch);
        if (/[A-Za-z~]/.test(ch)) { const seq = escBuf.join(""); escBuf = null; handleEsc(seq); }
        else if (escBuf.length > 12) escBuf = null; // runaway; give up
        continue;
      }

      if (b === 0x1b) { escBuf = []; continue; } // ESC: begin a sequence
      if (b === 0x0d || b === 0x0a) { write("\r\n"); finish({ line: buf.join("") }); continue; } // Enter
      if (b === 0x03) { write("^C\r\n"); finish({ aborted: true }); continue; } // Ctrl-C
      if (b === 0x04) { // Ctrl-D: EOF on empty line, else forward-delete
        if (buf.length === 0) finish({ eof: true });
        else if (pos < buf.length) { buf.splice(pos, 1); render(); }
        continue;
      }
      if (b === 0x7f || b === 0x08) { if (pos > 0) { buf.splice(--pos, 1); render(); } continue; } // Backspace
      if (b === 0x01) { pos = 0; render(); continue; } // Ctrl-A: home
      if (b === 0x05) { pos = buf.length; render(); continue; } // Ctrl-E: end
      if (b === 0x02) { if (pos > 0) { pos--; render(); } continue; } // Ctrl-B: left
      if (b === 0x06) { if (pos < buf.length) { pos++; render(); } continue; } // Ctrl-F: right
      if (b === 0x0b) { buf.splice(pos); render(); continue; } // Ctrl-K: kill to end
      if (b === 0x15) { buf.splice(0, pos); pos = 0; render(); continue; } // Ctrl-U: kill to start
      if (b === 0x17) { // Ctrl-W: kill the word before the cursor
        let j = pos;
        while (j > 0 && buf[j - 1] === " ") j--;
        while (j > 0 && buf[j - 1] !== " ") j--;
        buf.splice(j, pos - j);
        pos = j;
        render();
        continue;
      }
      if (b === 0x0c) { write("\x1b[2J\x1b[H"); render(); continue; } // Ctrl-L: clear screen

      if (b >= 0x20 && b !== 0x7f) {
        if (b < 0x80) { insertStr(String.fromCharCode(b)); }
        else {
          // A UTF-8 multi-byte character: gather the lead byte + continuations.
          const seq = [b];
          while (i + 1 < u8.length && u8[i + 1] >= 0x80 && u8[i + 1] < 0xc0) seq.push(u8[++i]);
          insertStr(dec.decode(new Uint8Array(seq)));
        }
      }
      // Any other control byte: ignored.
    }
  };

  return { start: () => write(prompt), feed };
}
