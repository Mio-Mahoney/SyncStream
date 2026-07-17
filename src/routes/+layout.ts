// PLAN.md 4.7: no server exists, so nothing renders anywhere but the browser.
// This is a pure SPA: adapter-static emits an index.html shell and the client
// router takes every route from there, including the client-generated /room/[id]
// codes that could never be enumerated at build time.
export const ssr = false;
export const prerender = false;
