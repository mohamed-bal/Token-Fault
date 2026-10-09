/**
 * Per-request fault selection from request headers.
 *
 * Precedence: `x-tokenfault-scenario` > `x-tokenfault-faults` > server default.
 * The scenario value `none` explicitly disables faults for one request even
 * when the server has a default profile.
 */
import { findScenario } from './catalog.js';
import { parseFaultProfile } from './schema.js';
import type { FaultProfile, FaultTargetKind, ParseResult } from './schema.js';

export interface FaultSelection {
  readonly scenarioId: string | null;
  readonly profile: FaultProfile;
}

export interface FaultHeaderInput {
  readonly scenario?: string | readonly string[] | undefined;
  readonly faults?: string | readonly string[] | undefined;
}

function single(
  value: string | readonly string[] | undefined,
  name: string,
): ParseResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'string') return { ok: true, value };
  if (value.length === 1) return { ok: true, value: value[0] };
  return { ok: false, error: `header ${name} must be sent once` };
}

export function selectFaults(
  headers: FaultHeaderInput,
  target: FaultTargetKind,
  fallback: FaultSelection | null,
  maxHeaderBytes: number,
): ParseResult<FaultSelection | null> {
  const scenario = single(headers.scenario, 'x-tokenfault-scenario');
  if (!scenario.ok) return scenario;
  const faults = single(headers.faults, 'x-tokenfault-faults');
  if (!faults.ok) return faults;

  if (scenario.value !== undefined) {
    const id = scenario.value.trim();
    if (id === 'none') return { ok: true, value: null };
    const found = findScenario(id);
    if (!found) return { ok: false, error: `unknown scenario "${id.slice(0, 64)}"` };
    if (!found.descriptor.appliesTo.includes(target)) {
      return {
        ok: false,
        error: `scenario "${id}" can only be applied by: ${found.descriptor.appliesTo.join(', ')}`,
      };
    }
    return { ok: true, value: { scenarioId: id, profile: found.profile } };
  }

  if (faults.value !== undefined) {
    if (faults.value.length > maxHeaderBytes) {
      return { ok: false, error: `header x-tokenfault-faults exceeds ${maxHeaderBytes} bytes` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(faults.value);
    } catch {
      return { ok: false, error: 'header x-tokenfault-faults is not valid JSON' };
    }
    const parsed = parseFaultProfile(raw, target);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { scenarioId: null, profile: parsed.value } };
  }

  return { ok: true, value: fallback };
}
