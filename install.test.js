import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'truemeet-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function started(t, file, args, env, pattern) {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  let output = '';
  child.stderr.on('data', (data) => { output += data; });
  const ready = new Promise((resolve) => child.stdout.on('data', (data) => {
    output += data;
    const match = output.match(pattern);
    if (match) resolve({ child, exited, output, port: Number(match[1]) });
  }));
  return Promise.race([ready, exited.then(([code]) => { throw new Error(`launcher exited ${code}: ${output}`); })]);
}

test('POSIX installer: generated launcher preserves unrelated servers and restarts its own TrueMeet', { skip: process.platform === 'win32', timeout: 20_000 }, async (t) => {
  const dir = await temp(t), bin = join(dir, 'bin'), home = join(dir, 'install with spaces');
  await mkdir(bin);
  const archive = join(dir, 'app.tar.gz');
  const root = basename(import.meta.dirname);
  await exec('tar', ['-czf', archive, '-C', join(import.meta.dirname, '..'), `${root}/server.js`, `${root}/package.json`, `${root}/public`]);
  // Keep this an offline installer test while executing its real extraction and launcher generation.
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp "$TRUEMEET_TEST_ARCHIVE" "$2"; exit; fi; shift; done\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRUEMEET_HOME: home, TRUEMEET_NO_START: '1', TRUEMEET_TEST_ARCHIVE: archive, HOST: '127.0.0.1' };
  delete env.TLS_CERT; delete env.TLS_KEY;
  await exec('sh', [join(import.meta.dirname, 'install.sh')], { env });
  const launcher = join(home, 'bin', 'truemeet'), server = join(home, 'app', 'server.js');
  await exec('sh', ['-n', launcher]);

  await t.test('an unrelated Node server.js, even with the TrueMeet path as a later argument, stays alive', async (t) => {
    const other = join(dir, 'server.js');
    await writeFile(other, 'require("node:http").createServer((req,res)=>res.end("unrelated")).listen(0,"127.0.0.1",function(){console.log(this.address().port)})');
    const { child, port } = await started(t, process.execPath, [other, server], env, /^(\d+)\s*$/m);
    await assert.rejects(exec(launcher, [], { env: { ...env, PORT: String(port) } }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /already in use.*Nothing was stopped.*PORT/);
      assert.ok(error.stderr.includes(String(child.pid)));
      return true;
    });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
    assert.equal(child.exitCode, null);
  });

  await t.test('an exact TrueMeet command is stopped gracefully and replaced', async (t) => {
    const first = await started(t, launcher, [], { ...env, PORT: '0' }, /TrueMeet ready on http:\/\/127\.0\.0\.1:(\d+)/);
    const second = await started(t, launcher, [], { ...env, PORT: String(first.port) }, /TrueMeet ready on http:\/\/127\.0\.0\.1:(\d+)/);
    assert.match(second.output, /stopping TrueMeet/);
    const [, signal] = await first.exited;
    assert.equal(signal, 'SIGTERM', 'no forced kill');
    assert.equal((await fetch(`http://127.0.0.1:${second.port}/config`)).status, 200);
  });
});

const powershell = process.env.POWERSHELL ?? (process.platform === 'win32' ? 'powershell' : 'pwsh');
const hasPowerShell = spawnSync(powershell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
test('PowerShell launcher: parses and verifies both executable and script before stopping any listener', { skip: !hasPowerShell && 'PowerShell is not installed (set POWERSHELL to its executable)', timeout: 30_000 }, async (t) => {
  const dir = await temp(t), server = join(dir, "TrueMeet's server.js"), launcher = join(dir, 'truemeet.ps1');
  await writeFile(server, 'console.log("TrueMeet test started")');
  const installer = await readFile(join(import.meta.dirname, 'install.ps1'), 'utf8');
  const template = installer.match(/\$launch = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  await writeFile(launcher, template.replace('__NODE__', process.execPath.replaceAll("'", "''")).replace('__SERVER__', server.replaceAll("'", "''")));
  const harness = join(dir, 'check.ps1');
  await writeFile(harness, `
$ErrorActionPreference = 'Stop'
foreach ($file in @($env:TRUEMEET_TEST_INSTALLER, $env:TRUEMEET_TEST_LAUNCHER)) {
  $tokens = $null; $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors) { throw ($parseErrors | Out-String) }
}
$global:mock = ConvertFrom-Json $env:TRUEMEET_TEST_PROCESSES
$global:reads = 0
function Get-NetTCPConnection { $global:mock.processes | ForEach-Object { [pscustomobject]@{ OwningProcess = $_.ProcessId } } }
function Get-CimInstance {
  param($ClassName, $Filter)
  $global:reads++
  if ($global:mock.changed -and $global:reads -gt $global:mock.processes.Count) { return $global:mock.changed }
  $owner = [int]([regex]::Match($Filter, '\\d+').Value)
  $global:mock.processes | Where-Object { $_.ProcessId -eq $owner }
}
function Stop-Process { param($Id, [switch]$Force); Add-Content $env:TRUEMEET_TEST_STOPPED $Id }
& $env:TRUEMEET_TEST_LAUNCHER
`);
  const valid = { ProcessId: 8123, Name: 'node', ExecutablePath: process.execPath, CommandLine: `"${process.execPath}" "${server}"` };
  const unrelated = { ...valid, CommandLine: `"${process.execPath}" "other/server.js" "${server}"` };
  for (const [name, processes, changed, allowed] of [
    ['exact TrueMeet paths', [valid], null, true],
    ['unrelated server.js with the TrueMeet path in a later argument', [unrelated], null, false],
    ['wrong executable with a spoofed command line', [{ ...valid, ExecutablePath: `${process.execPath}.other` }], null, false],
    ['unreadable command line', [{ ...valid, CommandLine: null }], null, false],
    ['mixed listeners must all pass before stopping any', [valid, { ...unrelated, ProcessId: 8124 }], null, false],
    ['port changes owners between inspection and stopping', [valid], unrelated, false],
  ]) {
    await t.test(name, async () => {
      const stopped = join(dir, 'stopped');
      await rm(stopped, { force: true });
      const env = { ...process.env, PORT: '3000', TRUEMEET_TEST_INSTALLER: join(import.meta.dirname, 'install.ps1'), TRUEMEET_TEST_LAUNCHER: launcher, TRUEMEET_TEST_STOPPED: stopped, TRUEMEET_TEST_PROCESSES: JSON.stringify({ processes, changed }) };
      const result = await exec(powershell, ['-NoProfile', '-File', harness], { env }).then((r) => ({ ...r, code: 0 }), (e) => e);
      assert.equal(result.code, allowed ? 0 : 1, result.stderr);
      if (allowed) {
        assert.match(result.stdout, /TrueMeet test started/);
        assert.equal((await readFile(stopped, 'utf8')).trim(), '8123');
      } else {
        assert.match(result.stderr, /Port 3000.*(?:already in use|changed owners)/);
        await assert.rejects(readFile(stopped), { code: 'ENOENT' }, 'no process was stopped');
        assert.ok(!result.stdout.includes('TrueMeet test started'));
      }
    });
  }
});
