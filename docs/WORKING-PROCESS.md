# WORKING PROCESS — the standing rule (user-issued 2026-09-29, kept verbatim in spirit)

> Before you build: your initial plan/hypothesis → web search (all relevant
> documentation + websites for insight) → the REAL plan (all phases in detail)
> → build → revise/test/red-team the implemented phase with REAL tests —
> imitate a real user, act as a human being testing the full capabilities and
> trying out use cases. Save this prompt so you can always remember it.

## The loop

1. **Hypothesis first.** Write the initial plan/assumptions down.
2. **Web-search every relevant topic** (~6 topics: the tech, the security
   reality, how popular products do it, the languages, the best-practice
   diagnosis). Read the docs/sites before anything is done.
3. **Real plan.** All phases in detail, file-level, with gates. NOTHING gets
   built before this exists.
4. **Build in phases** — push each as x.x.1 / x.x.2 … so progress is visible.
   When the whole prompt is done, push the wave tag (x.1x / x.2.x) and move
   to the next dot left.
5. **Red-team every phase** — real tests, act as a human user, exercise the
   full capabilities + use cases (the rig, the tunnel when it's up, real
   keys). Fix, re-test, then push.

## Standing collaboration rules

- Parallel agents work the same repo. Before ANY push: fetch, diff, check
  merge errors, merge amicably, then publish. Never force over their work.
- Full user access for testing: the credentials in
  /home/z/my-project/.credentials (PAT, HF token, provider keys, tunnel).
  If something more is needed to test like a real user, ASK — the user will
  get or do it.
- UI discipline: every front-facing feature rides ONE of the two overlay
  surfaces (the slide-up panel or the rounded overlay box) unless it belongs
  on the canvas/grid itself.
- Theme discipline: absolutely everything uses the theme system. NO hardcoded
  colors, ever.
- Do NOT pad work with generic "review the codebase / improve engineering
  details" passes — work the specific asked-for improvements until more
  would be spaghettification.
