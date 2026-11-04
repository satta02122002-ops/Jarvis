// Placeholder uploaded once, on the very first deploy, so the "jarvis" Worker exists.
// The real Worker (src/index.ts) replaces it moments later in the same workflow run.
export default {
  fetch: () => new Response("JARVIS is being set up. Refresh in a minute.", { status: 503 }),
};
