// Test stub for the `server-only` package.
//
// The real `server-only` module throws unless it is evaluated under the
// react-server condition (it exists to make `next build` fail when server
// code leaks into a client bundle). Vitest runs plain Node, so importing the
// real module from a unit test would throw. The vitest config aliases
// `server-only` to this no-op so `src/server/**` modules can be unit tested.
export {};
