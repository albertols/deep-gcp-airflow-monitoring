/**
 * Architectural boundaries (spec §11.4, ADR-0004). CI fails on any violation (NFR-MAINT-01).
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'domain-is-pure',
      comment: 'Rule 1: domain imports no other workspace package and no I/O library.',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { pathNot: '^packages/domain/src' },
    },
    {
      name: 'application-depends-on-domain-ports-contracts',
      comment: 'Rule 2: application imports only domain, ports and contracts.',
      severity: 'error',
      from: { path: '^packages/application/src' },
      to: { pathNot: ['^packages/(application|domain|ports|contracts)/', 'node_modules/openapi-fetch'] },
    },
    {
      name: 'adapters-do-not-use-application-or-each-other',
      comment: 'Rule 3: adapters implement ports; never application or another adapter.',
      severity: 'error',
      from: { path: '^packages/adapters/([^/]+)/src' },
      to: {
        path: ['^packages/application/', '^apps/', '^packages/adapters/'],
        pathNot: '^packages/adapters/$1/',
      },
    },
    {
      name: 'only-the-composition-root-wires-adapters',
      comment: 'Rule 4: only apps/server (and the CLI that starts it) import adapters.',
      severity: 'error',
      from: { path: '^packages/(domain|application|ports|contracts|ui-kit)/' },
      to: { path: '^packages/adapters/' },
    },
    {
      name: 'web-imports-contracts-and-ui-kit-only',
      comment: 'Rule 5: apps/web never imports server packages.',
      severity: 'error',
      from: { path: '^apps/web/src' },
      to: { path: ['^packages/(?!contracts|ui-kit)', '^apps/(?!web)'] },
    },
    {
      name: 'network-only-in-http-guard',
      comment:
        'Rule 7: outbound network modules only in the guarded client (tests may run loopback servers).',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: ['^packages/adapters/http-guard/src', '/test/'] },
      to: { path: '^(node:)?(http|https)$|node_modules/(undici|google-gax|@google-cloud)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(/dist/|/src/generated/)' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
