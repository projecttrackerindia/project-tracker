// Barrel: every API call the app makes, grouped by domain into its own file so a change in one area
// doesn't touch files owned by another. Nothing outside this folder needs to change - every existing
// `import { xApi } from '../../api/endpoints'` keeps working exactly as before.
export * from './endpoints.auth';
export * from './endpoints.projects';
export * from './endpoints.work';
export * from './endpoints.planning';
export * from './endpoints.platform';
export * from './endpoints.documents';
