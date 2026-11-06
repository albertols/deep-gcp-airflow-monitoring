import { describe, expect, it } from 'vitest';
import type { PlatformHealth } from '@dcam/domain';
import { afInventoryCollector, monCoreCollector } from '../../src/index';
import { fakeContext, FakeAirflow, FakeMonitoring, MemoryStore } from './collectors-harness';

/**
 * Collectors run concurrently, so a read of the health record may be older than another collector's write:
 * this store answers every read with the record as it was before any collector wrote.
 */
class ConcurrentReads extends MemoryStore {
  private stale: PlatformHealth | null = null;
  override async platformHealth(envId: string): Promise<PlatformHealth> {
    this.stale ??= await super.platformHealth(envId);
    return this.stale;
  }
}

describe('HM-028 platform-health inputs from several collectors', () => {
  it('HM-028: af.inventory and mon.core never undo each other’s health inputs', async () => {
    const store = new ConcurrentReads();
    await store.platformHealth('acme-prod');
    const shared = { airflowBaseUrl: 'https://acme-composer-prod.example.test' };
    const airflow = new FakeAirflow({ importErrors: 3 });
    const monitoring = new FakeMonitoring((q) =>
      q.metricType.endsWith('environment/healthy')
        ? [{ metricLabels: {}, resourceLabels: {}, points: [{ at: q.to, value: 1 }] }]
        : [],
    );
    await afInventoryCollector().collect(fakeContext({ airflow, store, shared }));
    await monCoreCollector().collect(fakeContext({ monitoring, store }));
    expect(store.health.get('acme-prod')).toMatchObject({ importErrors: 3, envHealthyRatio: 1 });
  });
});
