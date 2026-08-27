import { getHostBridge } from '../bridge'

export interface Application {
  name: string
  path: string
  bundleId?: string
}

export enum PopToRootType {
  Default = 'default',
  Immediate = 'immediate',
  Suspended = 'suspended',
}

export interface ShowHUDOptions {
  clearRootSearch?: boolean
  popToRootType?: PopToRootType
}

export async function open(target: string, application?: string | Application): Promise<void> {
  await getHostBridge().call('host.system.open', { target, application })
}

export async function closeMainWindow(options?: { clearRootSearch?: boolean; popToRootType?: PopToRootType }): Promise<void> {
  await getHostBridge().call('host.system.closeMainWindow', options)
}

export async function popToRoot(options?: { clearSearchBar?: boolean }): Promise<void> {
  await getHostBridge().call('host.system.popToRoot', options)
}

export async function showHUD(title: string, options?: ShowHUDOptions): Promise<void> {
  await getHostBridge().call('host.system.showHUD', { title, options })
}

export async function showInFinder(path: string): Promise<void> {
  await getHostBridge().call('host.system.showInFinder', { path })
}

export async function trash(path: string | string[]): Promise<void> {
  await getHostBridge().call('host.system.trash', { path })
}

/** Best-effort — implemented via a synthetic copy keystroke on the Rust side, not a real accessibility API. */
export async function getSelectedText(): Promise<string> {
  return (await getHostBridge().call('host.system.getSelectedText')) as string
}

export async function getSelectedFinderItems(): Promise<{ path: string }[]> {
  return ((await getHostBridge().call('host.system.getSelectedFinderItems')) ?? []) as { path: string }[]
}

export async function getApplications(path?: string): Promise<Application[]> {
  return ((await getHostBridge().call('host.system.getApplications', { path })) ?? []) as Application[]
}

export async function getFrontmostApplication(): Promise<Application> {
  return (await getHostBridge().call('host.system.getFrontmostApplication')) as Application
}

export async function getDefaultApplication(path: string): Promise<Application> {
  return (await getHostBridge().call('host.system.getDefaultApplication', { path })) as Application
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Alert {
  export enum ActionStyle {
    Default = 'default',
    Cancel = 'cancel',
    Destructive = 'destructive',
  }

  export interface Options {
    title: string
    message?: string
    icon?: string
    primaryAction?: { title: string; style?: ActionStyle }
    dismissAction?: { title: string }
  }
}

export async function confirmAlert(options: Alert.Options): Promise<boolean> {
  return (await getHostBridge().call('host.system.confirmAlert', options)) === true
}

export async function updateCommandMetadata(metadata: { subtitle?: string | null }): Promise<void> {
  await getHostBridge().call('host.system.updateCommandMetadata', metadata)
}
