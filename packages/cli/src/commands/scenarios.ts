import { FAULT_TYPES, SCENARIOS } from '@tokenfault/core';
import { parse } from '../args.js';
import { EXIT } from '../errors.js';
import { json, out, style } from '../output.js';

export const SCENARIOS_HELP = `Usage: tokenfault scenarios [--json]

List the built-in fault scenarios (A–I) and every configurable fault type.

Options:
  --json        Machine-readable output
  -h, --help    Show this help
`;

export function runScenarios(argv: readonly string[]): number {
  const { values } = parse(argv, {
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(SCENARIOS_HELP);
    return EXIT.ok;
  }
  if (values.json) {
    json({ scenarios: SCENARIOS.map((s) => s.descriptor), faultTypes: FAULT_TYPES });
    return EXIT.ok;
  }
  out(style.bold('Scenarios'));
  for (const { descriptor: s } of SCENARIOS) {
    out(
      `  ${style.cyan(s.letter)}  ${style.bold(s.id.padEnd(24))} ${s.title}  ${style.dim(`[${s.appliesTo.join(', ')}]`)}`,
    );
    out(`     ${s.description}`);
    out(`     ${style.dim('expect:')} ${s.expectedBehavior}`);
    out(
      `     ${style.dim('faults:')} ${JSON.stringify(s.faults)}${s.seed !== 1 ? ` seed=${s.seed}` : ''}`,
    );
  }
  out();
  out(
    style.bold('Fault types') +
      style.dim('  (combine in x-tokenfault-faults: {"faults":[...],"seed":N})'),
  );
  for (const f of FAULT_TYPES) {
    const params = f.params
      .map(
        (p) =>
          `${p.name}${p.optional ? '?' : ''}${p.kind === 'enum' ? `=${(p.options ?? []).join('|')}` : p.unit ? ` (${p.unit})` : ''}`,
      )
      .join(', ');
    out(`  ${style.bold(f.type.padEnd(22))} ${style.dim(f.phase.padEnd(13))} ${params}`);
  }
  return EXIT.ok;
}
