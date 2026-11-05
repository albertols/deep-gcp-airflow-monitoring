/**
 * `@dcam/config-file`: loads and validates `dcam.config.yaml` (spec §17) into the `WorkspaceConfig` port.
 *
 * @implements FR-SETUP-02, FR-SETUP-05
 */
export {
  CONFIG_FILE_NAME,
  defaultProfile,
  loadWorkspaceConfig,
  type LoadWorkspaceConfigInput,
  type LoadWorkspaceConfigResult,
} from './load';
export {
  DEFAULT_BUDGETS,
  DEFAULT_PROFILES,
  HARD_MAXIMA,
  configFileSchema,
  configJsonSchema,
  renderConfigJsonSchema,
  type ConfigFile,
} from './schema';
export { expandHome, resolvePath } from './paths';
