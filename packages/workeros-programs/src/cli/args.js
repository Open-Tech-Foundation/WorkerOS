// GUEST library (INV-1), installed at /lib/workeros-cli/args.js. Pure argv
// tokenization and small collectors for POSIX/GNU-style CLIs. Shell parsing and
// quoting already happened in `wsh`; this only interprets the resulting argv.

export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgError";
    this.exitCode = 2;
  }
}

function needValue(raw) {
  throw new ArgError(`${raw} requires an argument`);
}

export function tokenizeArgv(argv, {
  shortAlias = {},
  shortValue = new Set(),
  longValue = new Set(),
  stopAtFirstOperand = false,
  firstTokenGroupedShort = false,
} = {}) {
  const tokens = [];
  let afterTerminator = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (afterTerminator) {
      tokens.push({ kind: "operand", value: arg, raw: arg });
      continue;
    }
    if (arg === "--") {
      tokens.push({ kind: "terminator", raw: arg });
      afterTerminator = true;
      continue;
    }

    const bareCluster = i === 0 && firstTokenGroupedShort && /^[A-Za-z0-9]+$/.test(arg);
    if (arg === "-" || (!arg.startsWith("-") && !bareCluster)) {
      tokens.push({ kind: "operand", value: arg, raw: arg });
      if (stopAtFirstOperand) {
        for (let j = i + 1; j < argv.length; j++) {
          tokens.push({ kind: "operand", value: argv[j], raw: argv[j] });
        }
        break;
      }
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      let value;
      if (longValue.has(name)) {
        if (eq >= 0) value = arg.slice(eq + 1);
        else if (i + 1 < argv.length) value = argv[++i];
        else needValue(`option --${name}`);
      } else if (eq >= 0) {
        value = arg.slice(eq + 1);
      }
      tokens.push({ kind: "option", raw: arg, name, value, long: true });
      continue;
    }

    const raw = bareCluster ? `-${arg}` : arg;
    const cluster = bareCluster ? arg : arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const short = cluster[j];
      const name = shortAlias[short] || short;
      if (shortValue.has(short) || shortValue.has(name)) {
        const inline = cluster.slice(j + 1);
        let value;
        if (inline !== "") value = inline;
        else if (i + 1 < argv.length) value = argv[++i];
        else needValue(`option -${short}`);
        tokens.push({ kind: "option", raw, name, short, value, long: false });
        break;
      }
      tokens.push({ kind: "option", raw: `-${short}`, name, short, long: false });
    }
  }

  return tokens;
}

export function collectSimpleFlags(argv, opts = {}) {
  const flags = new Set();
  const longFlags = new Set();
  const operands = [];
  for (const tok of tokenizeArgv(argv, opts)) {
    if (tok.kind === "operand") operands.push(tok.value);
    else if (tok.kind === "option") {
      if (tok.long) longFlags.add(tok.name);
      else flags.add(tok.short);
    }
  }
  return { flags, longFlags, operands };
}

export function hasFlag(collected, flag) {
  return flag.startsWith("--")
    ? collected.longFlags.has(flag.slice(2))
    : collected.flags.has(flag.replace(/^-/, ""));
}
