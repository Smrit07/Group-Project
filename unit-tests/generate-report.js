'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const unitTestsDir = __dirname;
const projectRoot = path.resolve(unitTestsDir, '..');
const outputPath = path.join(projectRoot, 'test-report.html');

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const runCommand = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: unitTestsDir,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
};

const parseNodeReport = () => {
  const { stdout, status } = runCommand('node', ['--test', '--test-reporter=spec']);
  const lines = (stdout || '').split(/\r?\n/);

  const cases = [];
  for (const line of lines) {
    if (!/^[✔✖]/.test(line)) continue;

    const failed = line.startsWith('✖');
    const trimmed = line.replace(/^[✔✖]\s+/, '').trim();
    const match = trimmed.match(/^(.*?)(?:\s+\((\d+(?:\.\d+)?)ms\))?$/);
    const name = match ? match[1].trim() : trimmed;
    const time = match && match[2] ? Number(match[2]) : 0;

    cases.push({
      name,
      failed,
      time,
      fileName: 'node-test',
    });
  }

  const passedMatch = /ℹ pass (\d+)/.exec(stdout || '');
  const totalMatch = /ℹ tests (\d+)/.exec(stdout || '');
  const durationMatch = /ℹ duration_ms (\d+)/.exec(stdout || '');

  const durationMs = durationMatch ? Number(durationMatch[1]) : 0;
  const total = totalMatch ? Number(totalMatch[1]) : cases.length;
  const passed = passedMatch ? Number(passedMatch[1]) : cases.filter((c) => !c.failed).length;
  const failed = total - passed;

  const groups = new Map();
  for (const testCase of cases) {
    const groupName = /^UT-\d+/.test(testCase.name)
      ? testCase.name.match(/^UT-\d+/)[0]
      : 'DES client';

    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName).push(testCase);
  }

  const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
    const orderIndex = (label) => {
      const match = /^UT-(\d+)/.exec(label);
      if (match) return Number(match[1]);
      if (label === 'DES client') return 0;
      return 1000;
    };
    return orderIndex(left) - orderIndex(right);
  });

  return {
    status,
    total,
    passed,
    failed,
    durationMs,
    groups: orderedGroups,
  };
};

const parsePythonReport = () => {
  const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
  const { stdout, stderr, status } = runCommand(pythonCommand, ['-m', 'unittest', 'discover', '-s', 'python', '-v']);
  const output = `${stdout || ''}\n${stderr || ''}`;

  const entries = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^test_[^\s]+\s+\(([^)]+)\)\s+\.\.\.\s+(ok|FAIL|ERROR)$/);
    if (!match) continue;

    const fullName = match[1];
    const outcome = match[2];
    const group = /UT\d+[A-Za-z0-9]*/.exec(fullName)?.[0] || 'Python tests';
    entries.push({ group, name: fullName, outcome });
  }

  const runMatch = /Ran\s+(\d+)\s+tests?\s+in\s+([0-9.]+)s/i.exec(output);
  const total = runMatch ? Number(runMatch[1]) : entries.length;
  const passed = entries.filter((entry) => entry.outcome === 'ok').length;
  const failed = entries.filter((entry) => entry.outcome === 'FAIL' || entry.outcome === 'ERROR').length;

  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }

  return {
    status,
    total,
    passed,
    failed,
    duration: runMatch ? Number(runMatch[2]) : 0,
    groups: [...groups.entries()],
  };
};

const buildGroupHtml = (groupName, tests, kind = 'node') => {
  const passed = tests.filter((test) => {
    if (kind === 'node') return !test.failed;
    return test.outcome === 'ok';
  }).length;
  const total = tests.length;
  const bad = passed !== total;

  const rows = tests.map((test) => {
    const description = kind === 'node' ? test.name : test.name.replace(/^.*\./, '');
    const ok = kind === 'node' ? !test.failed : test.outcome === 'ok';
    const icon = ok ? '&#10003;' : '&#10007;';
    const cssClass = ok ? 'ok' : 'no';
    const timeLabel = kind === 'node' ? `${(test.time * 1000).toFixed(2)} ms` : '';

    return `
      <div class="row"><span class="${cssClass}">${icon}</span><span>${escapeHtml(description)}</span><span class="ms">${escapeHtml(timeLabel)}</span></div>`;
  }).join('');

  return `
    <div class="grp">
      <div class="gh"><span class="id">${escapeHtml(groupName)}</span>${escapeHtml(groupName === 'DES client' ? 'Circuit breaker and timeout (desClient.js)' : (kind === 'node' ? 'Test group' : 'Python DES engine'))}<span class="cnt ${bad ? 'bad' : ''}">${passed}/${total} ${bad ? 'failed' : 'passed'}</span></div>
      ${rows}
    </div>`;
};

const renderHtml = (nodeReport, pythonReport) => {
  const generated = new Date();
  const formattedDate = generated.toLocaleString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  const nodeSectionHtml = nodeReport.groups
    .map(([groupName, tests]) => buildGroupHtml(groupName, tests, 'node'))
    .join('\n');

  const pythonSectionHtml = pythonReport.groups
    .map(([groupName, tests]) => buildGroupHtml(groupName, tests, 'python'))
    .join('\n');

  const nodePassed = nodeReport.passed;
  const pythonPassed = pythonReport.passed;
  const totalTests = nodeReport.total + pythonReport.total;
  const failed = nodeReport.failed + pythonReport.failed;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Unit test results</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #1f2933; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 28px 24px 40px; }
    h1 { font-size: 22px; margin: 0 0 2px; }
    .sub { color: #5f6b76; margin: 0 0 18px; }
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
    .card { border: 1px solid #d9dee3; border-radius: 8px; padding: 12px 14px; }
    .card b { display: block; font-size: 26px; line-height: 1.1; color: #0f6e3a; }
    .card.bad b { color: #b42318; }
    .card span { color: #5f6b76; font-size: 12px; }
    h2 { font-size: 16px; margin: 26px 0 4px; padding-bottom: 6px; border-bottom: 2px solid #1f2933; display: flex; justify-content: space-between; align-items: baseline; }
    h2 small { font-weight: 400; color: #5f6b76; font-size: 12px; }
    .grp { margin: 14px 0 0; break-inside: avoid; }
    .gh { display: flex; gap: 8px; align-items: center; background: #f3f5f7; border: 1px solid #d9dee3; border-radius: 6px 6px 0 0; padding: 6px 10px; font-weight: 600; font-size: 13px; }
    .id { background: #1f2933; color: #fff; border-radius: 4px; padding: 0 6px; font-size: 11px; }
    .cnt { margin-left: auto; color: #0f6e3a; font-weight: 600; font-size: 12px; }
    .cnt.bad { color: #b42318; }
    .row { display: flex; gap: 8px; padding: 5px 10px; border: 1px solid #d9dee3; border-top: 0; font-size: 13px; }
    .row:last-child { border-radius: 0 0 6px 6px; }
    .ok { color: #0f6e3a; font-weight: 700; }
    .no { color: #b42318; font-weight: 700; }
    .err { color: #b42318; }
    .ms { margin-left: auto; color: #8a949e; font-size: 12px; white-space: nowrap; }
    .btn { margin-top: 20px; padding: 8px 14px; border: 1px solid #1f2933; background: #fff; border-radius: 6px; cursor: pointer; font: inherit; }
    @media (max-width: 640px) { .cards { grid-template-columns: repeat(2, 1fr); } }
    @media print { .btn { display: none; } .wrap { padding: 0; } body { font-size: 12px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Unit test results</h1>
    <p class="sub">Smart Cafeteria &amp; Resource Queue Optimizer &middot; generated ${escapeHtml(formattedDate)}</p>

    <div class="cards">
      <div class="card ${nodeReport.failed ? 'bad' : ''}"><b>${nodeReport.passed} / ${nodeReport.total}</b><span>Node tests passed</span></div>
      <div class="card ${pythonReport.failed ? 'bad' : ''}"><b>${pythonReport.passed} / ${pythonReport.total}</b><span>Python tests passed</span></div>
      <div class="card"><b>${totalTests}</b><span>Total tests</span></div>
      <div class="card ${failed ? 'bad' : ''}"><b>${failed}</b><span>Failed</span></div>
    </div>

    <h2>Node tests (UT-01 to UT-12) <small>duration ${nodeReport.durationMs} ms</small></h2>
    ${nodeSectionHtml}

    <h2>Python tests (SimPy DES engine) <small>Ran ${pythonReport.total} tests in ${pythonReport.duration} s</small></h2>
    ${pythonSectionHtml}

    <button class="btn" onclick="window.print()">Print / save as PDF</button>
  </div>
</body>
</html>`;
};

try {
  const nodeReport = parseNodeReport();
  const pythonReport = parsePythonReport();
  const html = renderHtml(nodeReport, pythonReport);
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Generated report: ${outputPath}`);
  console.log(`Node tests: ${nodeReport.passed}/${nodeReport.total} passed, ${nodeReport.failed} failed`);
  console.log(`Python tests: ${pythonReport.passed}/${pythonReport.total} passed, ${pythonReport.failed} failed`);
} catch (error) {
  console.error('Failed to generate test report');
  console.error(error.stack || String(error));
  process.exit(1);
}
