/**
 * Runtime Kernel (ADR-012).
 *
 * Framework-free runtime modules. Nothing in this directory may import a UI framework, the DOM, or a
 * rendering API — that is invariant I-36, and it is what makes the same kernel usable from React, a
 * headless export, a worker, and a future native host without behaviour change.
 *
 * Built slice by slice per `plans/adr-012-implementation-programme.md`. Today: diagnostics (S0.1).
 */
export * from "./diagnostics";
export * from "./frame-scheduler";
export * from "./settle-window";
export * from "./state-registry";
export * from "./session";
export * from "./media-manager";
export * from "./decoder-manager";
export * from "./resource-manager";
export * from "./inspect";
export * from "./degradation-sink";
export * from "./present-ledger";
