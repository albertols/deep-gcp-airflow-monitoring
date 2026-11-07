/**
 * The hard maxima of §7.11 are declared twice: in the config schema (which rejects larger values) and in the
 * engine (which clamps to them). Only the composition root may import both packages (dependency rule 4), so
 * the check that they agree lives here.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_MAXIMA as ENGINE_BACKFILL_MAXIMA,
  DEFAULT_BACKFILL as ENGINE_BACKFILL,
  HARD_MAXIMA as ENGINE,
} from '@dcam/application';
import {
  BACKFILL_MAXIMA as SCHEMA_BACKFILL_MAXIMA,
  DEFAULT_BACKFILL as SCHEMA_BACKFILL,
  HARD_MAXIMA as SCHEMA,
} from '@dcam/config-file';

describe('FR-COLL-06 hard maxima (§7.11)', () => {
  it('FR-COLL-06: the config schema and the engine declare the same hard maxima', () => {
    expect({
      airflowPerMinute: SCHEMA.airflowApiPerMinute,
      airflowConcurrent: SCHEMA.airflowApiConcurrent,
      monitoringPerMinute: SCHEMA.monitoringPerProjectPerMinute,
      composerPerMinute: SCHEMA.composerApiPerMinute,
    }).toEqual(ENGINE);
    // §7.11 "Default budgets and hard maxima".
    expect(ENGINE).toEqual({
      airflowPerMinute: 120,
      airflowConcurrent: 4,
      monitoringPerMinute: 120,
      composerPerMinute: 30,
    });
  });

  it('FR-COLL-04: the config schema and the collectors declare the same backfill defaults and maxima', () => {
    expect({ ...SCHEMA_BACKFILL }).toEqual(ENGINE_BACKFILL);
    expect({ ...SCHEMA_BACKFILL_MAXIMA }).toEqual(ENGINE_BACKFILL_MAXIMA);
    // §17.2 `environments[].backfill: { taskInstancesDays: 7, metricsDays: 14 }`.
    expect(ENGINE_BACKFILL).toEqual({ taskInstancesDays: 7, metricsDays: 14 });
  });
});
