import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderConfigJsonSchema } from '../src/index';

const committed = fileURLToPath(new URL('../dcam.config.schema.json', import.meta.url));

describe('FR-SETUP-02 published JSON Schema (§17.1)', () => {
  it('FR-SETUP-02: the committed dcam.config.schema.json matches the Zod schema (run pnpm gen when this fails)', () => {
    expect(readFileSync(committed, 'utf8')).toBe(renderConfigJsonSchema());
  });

  it('FR-SETUP-02: the JSON Schema rejects unknown keys and spells out the hard maxima for editors', () => {
    const schema = JSON.parse(renderConfigJsonSchema());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['version', 'environments']);
    expect(schema.properties.budgets.properties.airflowApi.properties.live.maximum).toBe(120);
    expect(schema.properties.budgets.properties.airflowApi.properties.maxConcurrent.maximum).toBe(4);
    // FR-COLL-04: the backfill of §17.2, with its defaults and maxima.
    const backfill = schema.properties.environments.items.properties.backfill.properties;
    expect([backfill.taskInstancesDays.default, backfill.taskInstancesDays.maximum]).toEqual([7, 90]);
    expect([backfill.metricsDays.default, backfill.metricsDays.maximum]).toEqual([14, 42]);
    expect(schema.properties.retention.properties.rawMetricPointsDays).toMatchObject({
      minimum: 1,
      maximum: 90,
      default: 14,
    });
    expect(schema.properties.retention.properties.diskBudgetGb.default).toBe(5);
    expect(schema.properties.environments.items.oneOf).toEqual([
      { required: ['projectId', 'location', 'environment'] },
      { required: ['airflow'] },
    ]);
  });
});
