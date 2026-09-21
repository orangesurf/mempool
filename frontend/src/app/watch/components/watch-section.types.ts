/**
 * Shared contract between the /watch section components and the WatchComponent shell, kept in
 * its own file so neither the shell nor the section base class has to import the other — that
 * import cycle (shell template → sections → base → shell) surfaced at runtime as an Angular
 * "Cannot access X before initialization" (TDZ) error.
 */
export interface WatchSectionAction {
  name: string;
  args?: unknown[];
}
