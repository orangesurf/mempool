/***************************************************************************************************
 * Load `$localize` onto the global scope - used if i18n tags appear in Angular templates.
 */
import '@angular/localize/init';

/***************************************************************************************************
 * `process` shim.
 *
 * The /watch wallet's PSBT animated-QR codecs (@ngraveio/bc-ur, bbqr) transitively pull in a
 * browserified Node `util`, which reads the Node `process` global at load time. In a browser
 * `process` is undefined, so the lazy /watch chunk would throw "process is not defined" during
 * module init and fail to boot (surfacing confusingly as "Cannot access 'Dh' before
 * initialization" — Dh being WatchModule). Provide a minimal browser shim. `browser: true`
 * tells browser-aware libraries they are NOT running under Node.
 */
if (typeof (globalThis as { process?: unknown }).process === 'undefined') {
  (globalThis as { process?: unknown }).process = {
    browser: true,
    env: {},
    argv: [],
    version: '',
    versions: {},
    platform: 'browser',
    pid: 0,
    nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]): void => {
      Promise.resolve().then(() => cb(...args));
    },
    emitWarning: (): void => { /* no-op */ },
    noDeprecation: false,
    throwDeprecation: false,
    stderr: { isTTY: false, columns: 80, getColorDepth: (): number => 1 },
    stdout: { isTTY: false, columns: 80, getColorDepth: (): number => 1 },
  };
}
/**
 * This file includes polyfills needed by Angular and is loaded before the app.
 * You can add your own extra polyfills to this file.
 *
 * This file is divided into 2 sections:
 *   1. Browser polyfills. These are applied before loading ZoneJS and are sorted by browsers.
 *   2. Application imports. Files imported after ZoneJS that should be loaded before your main
 *      file.
 *
 * The current setup is for so-called "evergreen" browsers; the last versions of browsers that
 * automatically update themselves. This includes Safari >= 10, Chrome >= 55 (including Opera),
 * Edge >= 13 on the desktop, and iOS 10 and Chrome on mobile.
 *
 * Learn more in https://angular.io/guide/browser-support
 */

/***************************************************************************************************
 * BROWSER POLYFILLS
 */

/**
 * By default, zone.js will patch all possible macroTask and DomEvents
 * user can disable parts of macroTask/DomEvents patch by setting following flags
 * because those flags need to be set before `zone.js` being loaded, and webpack
 * will put import in the top of bundle, so user need to create a separate file
 * in this directory (for example: zone-flags.ts), and put the following flags
 * into that file, and then add the following code before importing zone.js.
 * import './zone-flags.ts';
 *
 * The flags allowed in zone-flags.ts are listed here.
 *
 * The following flags will work for all browsers.
 *
 * (window as any).__Zone_disable_requestAnimationFrame = true; // disable patch requestAnimationFrame
 * (window as any).__Zone_disable_on_property = true; // disable patch onProperty such as onclick
 * (window as any).__zone_symbol__UNPATCHED_EVENTS = ['scroll', 'mousemove']; // disable patch specified eventNames
 *
 *  in IE/Edge developer tools, the addEventListener will also be wrapped by zone.js
 *  with the following flag, it will bypass `zone.js` patch for IE/Edge
 *
 *  (window as any).__Zone_enable_cross_context_check = true;
 *
 */

/***************************************************************************************************
 * Zone JS is required by default for Angular itself.
 */
import 'zone.js';  // Included with Angular CLI.


/***************************************************************************************************
 * APPLICATION IMPORTS
 */

(window as any).global = window;
