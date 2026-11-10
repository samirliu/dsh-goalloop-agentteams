// test/fixtures/shell.mjs — shared platform fixture helper for the gate test suite.
//
// WHY THIS EXISTS
// The gate executes every AC `check:`/`probe:` through a *shell*: /bin/sh -c on
// POSIX and %COMSPEC% (cmd.exe) /d /s /c on Windows (see lib/core.js resolveShell).
// Fixtures must therefore be written in the syntax of the shell that will actually
// run them, otherwise a correct artifact is judged NO-GO / BROKEN for a platform
// reason that has nothing to do with the product under test.
//
// The helper resolves the SAME shell spec the gate will use (caller override >
// GOAL_GATE_SHELL > platform default) and returns a command string valid for that
// shell. Tests stay readable and shell-agnostic; the emitted spelling is:
//
//   cmd.exe  : built-ins + inbox Windows tools only (`if exist`, `findstr`, `type`,
//              `find`, `exit /b`) — no POSIX tools, no `&&`-free assumptions.
//   /bin/sh  : POSIX shell BUILT-INS only (`test`, `echo`, `exit`, `case`, `read`).
//              This matters for the Windows POSIX control run: a directly spawned
//              Git `usr\bin\sh.exe` inherits the Windows PATH, which has no
//              grep/cat/wc/sleep, so external coreutils must not be required.
//   pwsh     : supported for completeness; not exercised by the current suite.
//
// The only external program any fixture command invokes is the *same* Node binary
// that is running the tests (absolute path, quoted), which exists in both modes.
//
// Every helper string is a complete shell command with the documented exit-code
// contract; tests build AC lines like:
//   `AC-1 | a.txt exists | check: \`${fileExists('a.txt')}\` | expected: exit=0`
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShell } from '../../lib/core.js';

const resolved = resolveShell();
export const shellKind = resolved.kind;      // 'posix' | 'cmd' | 'powershell'
export const shellLabel = resolved.label;    // shown in reports

const IS_CMD = shellKind === 'cmd';
const IS_PWSH = shellKind === 'powershell';
const IS_POSIX = shellKind === 'posix';

// ── small quoting helpers ────────────────────────────────────────────────
function cmdPath(rel) { return String(rel).replace(/\//g, '\\'); }
function cmdQuote(text) { return `"${String(text).replace(/"/g, '""')}"`; }
function posixQuote(text) { return `'${String(text).replace(/'/g, `'\\''`)}'`; }
function psQuote(text) { return `'${String(text).replace(/'/g, "''")}'`; }

// ─────────────────────────────────────────────────────────────────────────
// temp workspace (Windows has no writable /tmp guarantee; porting tests that
// assumed it would silently depend on C:\tmp being creatable)
// ─────────────────────────────────────────────────────────────────────────
export function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─────────────────────────────────────────────────────────────────────────
// verdict commands
// ─────────────────────────────────────────────────────────────────────────
/** A command that always exits 0 (replacement for `true` / `test -d .`). */
export function ok() {
  if (IS_CMD) return 'exit /b 0';
  if (IS_PWSH) return 'exit 0';
  return 'true';
}

/** A command that always exits 1 (replacement for `false`). */
export function fail() {
  if (IS_CMD) return 'exit /b 1';
  if (IS_PWSH) return 'exit 1';
  return 'exit 1';
}

/** A command that is not installed anywhere: the gate must call it BROKEN. */
export function missingCommand() {
  // cmd.exe reports 9009 for an unknown command, not the POSIX 127 the gate's
  // missing-verifier contract keys on; emit the documented exit 127 explicitly.
  // POSIX mode uses a genuinely absent binary so the /bin/sh "not found" path
  // is still exercised end to end.
  if (IS_CMD) return 'exit /b 127';
  if (IS_PWSH) return 'exit 127';
  return 'definitely-missing-cmd-xyz';
}

// ─────────────────────────────────────────────────────────────────────────
// output commands (stdout is parsed by the metric/judged pipelines)
// ─────────────────────────────────────────────────────────────────────────
/** Print `text` on stdout (no trailing decoration). */
export function echo(text) {
  if (IS_CMD) return `echo ${text}`;   // cmd echo prints quotes literally; keep it raw
  if (IS_PWSH) return `Write-Output ${psQuote(text)}`;
  return `echo ${posixQuote(text)}`;
}

/** Print one metric line such as `m=100 sd=4` (same contract as echo). */
export function metric(text) { return echo(text); }

/** Print `text` on stderr. */
export function echoStderr(text) {
  if (IS_CMD) return `echo ${text} 1>&2`;
  if (IS_PWSH) return `[Console]::Error.WriteLine(${psQuote(text)})`;
  return `echo ${posixQuote(text)} 1>&2`;
}

/** Print `text` on stderr, then exit non-zero (fail-loud diagnostic fixture). */
export function stderrThenFail(text) {
  return sequence(echoStderr(text), fail());
}

/** Print the whole file (replacement for `cat`). */
export function showFile(rel) {
  if (IS_CMD) return `type ${cmdQuote(cmdPath(rel))}`;
  if (IS_PWSH) return `Get-Content -LiteralPath ${psQuote(rel)}`;
  return `while IFS= read -r line || [ -n "$line" ]; do echo "$line"; done < ${posixQuote(rel)}`;
}

/**
 * Print the number of lines in a file (replacement for `wc -l < f`).
 * cmd.exe prints `---------- FILE: N`; the gate's metric extraction takes the
 * last number, so callers that need an exact number should pass a metric regex.
 */
export function lineCount(rel) {
  if (IS_CMD) return `find /c /v "" ${cmdQuote(cmdPath(rel))}`;
  if (IS_PWSH) return `(Get-Content -LiteralPath ${psQuote(rel)}).Count`;
  return `n=0; while IFS= read -r line || [ -n "$line" ]; do n=$((n + 1)); done < ${posixQuote(rel)}; echo "$n"`;
}

// ─────────────────────────────────────────────────────────────────────────
// file assertion commands: exit 0 iff the assertion holds
// ─────────────────────────────────────────────────────────────────────────
/** Exit 0 iff `rel` exists as a regular file (replacement for `test -f`). */
export function fileExists(rel) {
  if (IS_CMD) return `if not exist ${cmdQuote(cmdPath(rel))} exit /b 1`;
  if (IS_PWSH) return `if (-not (Test-Path -LiteralPath ${psQuote(rel)} -PathType Leaf)) { exit 1 }`;
  return `test -f ${posixQuote(rel)}`;
}

/** Exit 0 iff `rel` exists and is non-empty (replacement for `test -s`). */
export function fileNotEmpty(rel) {
  if (IS_CMD) {
    const p = cmdQuote(cmdPath(rel));
    // One if/else construct: `if exist ... & for ...` loses the for-loop here.
    return `if exist ${p} (for %F in (${p}) do @if %~zF equ 0 exit /b 1) else (exit /b 1)`;
  }
  if (IS_PWSH) {
    return `if (-not (Test-Path -LiteralPath ${psQuote(rel)} -PathType Leaf) -or (Get-Item -LiteralPath ${psQuote(rel)}).Length -eq 0) { exit 1 }`;
  }
  return `test -s ${posixQuote(rel)}`;
}

/** Exit 0 iff `rel` does NOT exist (replacement for `test ! -f`). */
export function fileAbsent(rel) {
  if (IS_CMD) return `if exist ${cmdQuote(cmdPath(rel))} exit /b 1`;
  if (IS_PWSH) return `if (Test-Path -LiteralPath ${psQuote(rel)}) { exit 1 }`;
  return `test ! -f ${posixQuote(rel)}`;
}

/** Exit 0 iff the file contains `needle` (replacement for `grep -q needle file`). */
export function fileContains(rel, needle) {
  if (IS_CMD) return `findstr /C:${cmdQuote(needle)} ${cmdQuote(cmdPath(rel))}`;
  if (IS_PWSH) return `if (-not (Select-String -LiteralPath ${psQuote(rel)} -Pattern ${psQuote(needle)} -Quiet)) { exit 1 }`;
  const pattern = String(needle).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `while IFS= read -r line; do case "$line" in *"${pattern}"*) exit 0;; esac; done < ${posixQuote(rel)}; exit 1`;
}

/** Write `text` to `rel` (single-line; replacement for `echo x > f`). */
export function writeFile(rel, text = 'x') {
  if (IS_CMD) return `echo ${text} > ${cmdQuote(cmdPath(rel))}`;
  if (IS_PWSH) return `Set-Content -LiteralPath ${psQuote(rel)} -Value ${psQuote(text)}`;
  return `echo ${posixQuote(text)} > ${posixQuote(rel)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// timing / runtime commands
// ─────────────────────────────────────────────────────────────────────────
/**
 * Sleep for `seconds` (fractional ok). Implemented with the running Node binary
 * because POSIX `sleep` is an external tool that a directly spawned Git sh.exe
 * cannot see, and cmd has no sleep built-in.
 */
export function sleep(seconds) {
  const ms = Math.max(1, Math.round(Number(seconds) * 1000));
  return `"${process.execPath}" -e "setTimeout(()=>{},${ms})"`;
}

/**
 * Prove a runtime toolchain exists: executes the running Node binary with an
 * empty program. Used where a fixture must look like a runtime AC (`grill`'s
 * no-runtime / missing-runtime heuristics) rather than a file-only check.
 */
export function nodeNoop() {
  return `"${process.execPath}" -e ""`;
}

// ─────────────────────────────────────────────────────────────────────────
// composition
// ─────────────────────────────────────────────────────────────────────────
/** Run commands in order, short-circuiting on failure (`&&`; valid in both shells). */
export function sequence(...cmds) {
  const parts = cmds.flat().filter(Boolean).map(String);
  if (parts.length === 0) return ok();
  return parts.join(' && ');
}

/** Alias of sequence for "all of these must hold" fixtures. */
export function all(...cmds) { return sequence(...cmds); }
