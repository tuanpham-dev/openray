/**
 * The build/pack pipeline as a directly requireable module, for tooling
 * that runs *without* the app: the `openray` CLI's `pack`/`publish`, and a
 * registry repository's CI.
 *
 * Deliberately the same code the running host uses. A registry that packed
 * through a second implementation would eventually publish archives the app
 * builds differently, which is the exact drift the one-pipeline rule exists
 * to prevent.
 */
export { packExtension, installArchive } from './pack'
export { buildExtensionInPlace, readManifest, readRawManifest } from './builder'
export { missingApis, providedApis } from './capabilities'
