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
 * @param {() => number} [o.columns]  current terminal width (re-read every render,
 *   so a mid-edit resize re-wraps correctly). Defaults to 80.
 * @param {(line: string, pos: number) => ({ start: number, items: string[] } | null)} [o.complete]
 *   Tab-completion source. Given the full line and cursor index, returns the buffer
 *   index where the completed token begins and the candidate replacements for it
 *   (directory candidates end in "/"); null/empty means "nothing to complete".
 * @param {(r: {line?: string, aborted?: boolean, eof?: boolean}) => void} o.done
 * @returns {{ start: () => void, feed: (bytes: Uint8Array) => void, resize: () => void }}
 */
export function createLineEditor({ prompt, history = [], write, done, columns = () => 80, complete = null }) {
  let buf = []; // the line as an array of characters (one JS char each)
  let pos = 0; // cursor index within buf
  let hist = history.length; // history cursor; === length means "editing a new line"
  let stash = ""; // the new line saved while browsing history
  let escBuf = null; // chars of an in-progress ESC sequence, or null
  let finished = false;
  let prevWasTab = false; // was the last processed byte a Tab? (for bash's two-Tab list)

  // The prompt is written already-styled; its *display* width ignores ANSI SGR.
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const promptCells = () => [...stripAnsi(prompt)].length;

  // Multi-line aware redraw (à la GNU readline / linenoise). The prompt + line
  // can wrap across several terminal rows, so we can't just CR to column 0: we
  // move from the previous cursor row up to the line's first row clearing each,
  // repaint the whole wrapped line, then place the cursor on its row/column.
  // `maxrows` remembers the tallest the line has been so shrinking it still
  // clears the now-stale rows below.
  let oldpos = 0; // cursor index at the previous render
  let maxrows = 0; // most rows the line has occupied so far this session
  const render = () => {
    const cols = Math.max(1, columns() | 0);
    const plen = promptCells();
    const len = buf.length;

    let rows = Math.floor((plen + len + cols - 1) / cols); // rows the line spans
    if (rows < 1) rows = 1;
    const rpos = Math.floor((plen + oldpos + cols) / cols); // old cursor row (1-based)
    const oldRows = maxrows;

    let out = "";
    // 1. Drop to the last previously-drawn row, then clear rows up to the first.
    if (oldRows - rpos > 0) out += "\x1b[" + (oldRows - rpos) + "B";
    for (let j = 0; j < oldRows - 1; j++) out += "\r\x1b[K\x1b[1A";
    out += "\r\x1b[K";

    // 2. Paint prompt + buffer.
    out += prompt + buf.join("");

    // 3. Cursor at end and the line exactly fills the last row → the terminal
    //    parks it with a pending wrap; force a real fresh row to land on.
    if (len > 0 && pos === len && (plen + len) % cols === 0) {
      out += "\r\n";
      rows++;
    }
    if (rows > maxrows) maxrows = rows;

    // 4. Move the cursor to its row, then set its column.
    const rpos2 = Math.floor((plen + pos + cols) / cols); // current cursor row (1-based)
    if (rows - rpos2 > 0) out += "\x1b[" + (rows - rpos2) + "A";
    const col = (plen + pos) % cols;
    out += col ? "\r\x1b[" + col + "C" : "\r";

    oldpos = pos;
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

  // Longest common prefix of the candidate strings (used for partial completion).
  const commonPrefix = (items) => {
    let p = items[0];
    for (let k = 1; k < items.length && p; k++) {
      const s = items[k];
      let i = 0;
      while (i < p.length && i < s.length && p[i] === s[i]) i++;
      p = p.slice(0, i);
    }
    return p;
  };

  // A candidate's display form for the listing: its basename (bash shows the last
  // path segment, not the whole "dir/name" replacement), with a directory's
  // trailing "/" preserved.
  const displayName = (s) => {
    const bare = s.endsWith("/") ? s.slice(0, -1) : s;
    const base = bare.slice(bare.lastIndexOf("/") + 1);
    return s.endsWith("/") ? base + "/" : base;
  };

  // Print the candidates (as basenames) in aligned columns below the line, then
  // repaint the prompt fresh underneath — bash's listing of an ambiguous Tab.
  const listItems = (items) => {
    const names = items.map(displayName);
    const cols = Math.max(1, columns() | 0);
    const colw = names.reduce((m, s) => Math.max(m, s.length), 0) + 2;
    const ncols = Math.max(1, Math.floor(cols / colw));
    let out = "\r\n";
    for (let i = 0; i < names.length; i++) {
      out += names[i].padEnd(colw);
      if ((i + 1) % ncols === 0 || i === names.length - 1) out += "\r\n";
    }
    write(out);
    maxrows = 0; // the listing sits above; repaint the prompt on a fresh row
    render();
  };

  // Tab: ask the completer for candidates for the token under the cursor. A
  // unique match is inserted (with a trailing space, unless it's a directory);
  // an ambiguous one extends to the longest common prefix. When no prefix can be
  // added, bash beeps on the first Tab and lists on the next — `repeat` is true
  // when the immediately-preceding keystroke was also a completion.
  const doComplete = (repeat) => {
    if (!complete) { write("\x07"); return; }
    const r = complete(buf.join(""), pos);
    if (!r || !r.items || r.items.length === 0) { write("\x07"); return; }
    const { start, items } = r;
    const tokenLen = pos - start;
    if (items.length === 1) {
      const rep = [...items[0]];
      buf.splice(start, tokenLen, ...rep);
      pos = start + rep.length;
      if (!items[0].endsWith("/")) { buf.splice(pos++, 0, " "); }
      render();
      return;
    }
    const lcp = [...commonPrefix(items)];
    if (lcp.length > tokenLen) { buf.splice(start, tokenLen, ...lcp); pos = start + lcp.length; render(); }
    else if (repeat) listItems(items); // second consecutive Tab → list matches
    else write("\x07"); // first ambiguous Tab → ring the bell
  };

  const feed = (bytes) => {
    if (finished) return;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u8.length && !finished; i++) {
      const b = u8[i];
      // Track Tab-repeats for completion: was the *previous* byte a Tab, and is
      // this one? (Set for every byte, incl. escape/continuation, so any other
      // key between two Tabs disarms the "list on the second Tab" behavior.)
      const wasTab = prevWasTab;
      prevWasTab = b === 0x09;

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

      if (b === 0x09) { doComplete(wasTab); continue; } // Tab: complete files/commands
      if (b === 0x1b) { escBuf = []; continue; } // ESC: begin a sequence
      // Enter / Ctrl-C: park the cursor at the end of the (possibly wrapped) line
      // first, so the newline breaks below the whole command, not mid-row.
      if (b === 0x0d || b === 0x0a) { pos = buf.length; render(); write("\r\n"); finish({ line: buf.join("") }); continue; } // Enter
      if (b === 0x03) { pos = buf.length; render(); write("^C\r\n"); finish({ aborted: true }); continue; } // Ctrl-C
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
      if (b === 0x0c) { write("\x1b[2J\x1b[H"); maxrows = 0; render(); continue; } // Ctrl-L: clear screen

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

  return {
    // Paint the initial (empty) prompt through render() so wrap state is primed.
    start: () => render(),
    feed,
    // Re-wrap after a terminal resize (SIGWINCH) while the line is being edited.
    resize: () => { if (!finished) render(); },
  };
}
