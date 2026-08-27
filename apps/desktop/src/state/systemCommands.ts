/**
 * `needsConfirm` is a T14 addition — a `root-provider`-contributed row's
 * own dynamic confirm flag (`SearchCommand.needsConfirm`, computed
 * server-side from `RootCommandProvider`'s side-table). As of T17 this is
 * the only mechanism: system commands' destructive ids (shut down,
 * restart, log out, empty trash) are contributed with `needsConfirm: true`
 * by `extensions/system-commands`, rather than checked against a static
 * id set here.
 */
export function needsConfirmation(needsConfirm?: boolean): boolean {
  return needsConfirm === true
}
