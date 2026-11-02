import { BARE_KEY_SCRIPT_TYPES, describeScriptType, scriptKind } from '@app/watch/watch-key.utils';

/** The everyday name of a wallet's script type, e.g. "Native SegWit" for P2WPKH. */
export function scriptTypeName(scriptType: string): string {
  switch (scriptKind(scriptType)) {
    case 'wpkh':   return $localize`:@@watch.script-type.wpkh:Native SegWit`;
    case 'shwpkh': return $localize`:@@watch.script-type.sh-wpkh:Nested SegWit`;
    case 'pkh':    return $localize`:@@watch.script-type.pkh:Legacy`;
    case 'tr':     return $localize`:@@watch.script-type.tr:Taproot`;
    case 'wsh':    return $localize`:@@watch.script-type.wsh:Native SegWit script`;
    case 'shwsh':  return $localize`:@@watch.script-type.sh-wsh:Nested SegWit script`;
    case 'sh':     return $localize`:@@watch.script-type.sh:Legacy script`;
    case 'bare':   return $localize`:@@watch.script-type.bare:Bare script`;
    default:       return scriptType;
  }
}

/** The address types a bare xpub/tpub can be imported as, for the pickers on the import form and in Settings. */
export const BARE_KEY_SCRIPT_OPTIONS = BARE_KEY_SCRIPT_TYPES.map((value) => ({ value, label: scriptTypeName(value), path: describeScriptType(value).path }));
