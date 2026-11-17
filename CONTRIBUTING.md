# Contributing

Thanks for helping. Bug reports with a failing test are the most useful thing
you can send.

## Ground rules

- **npm only.** Use `npm ci` and commit the updated `package-lock.json` when you
  change dependencies. Do not add a `yarn.lock`, `pnpm-lock.yaml` or `bun.lock`.
- **Tests are required.** Every change to an adapter or the HTTP layer comes with
  a Vitest test that runs against a mocked `fetch`. No test may call a real CRM.
  Coverage of `src` stays at 90% of lines or more.
- **Document every export.** `npm run check:docs` fails if a public symbol or
  member has no TSDoc comment.
- **Synthetic data only.** Fixtures use invented names, `example.com` emails and
  `555` phone numbers. Never paste a real API key, account ID, customer record
  or response captured from a real account into an issue, test or commit.
- **Documented endpoints only.** A new endpoint or field needs a link to the
  vendor's public API documentation in the PR description.
- **No runtime dependencies** without discussing it in an issue first.

## Workflow

```bash
npm ci
npm run check        # lint, typecheck, tests with 90% line coverage, build, TSDoc and licence checks
npm run smoke:pack   # install the packed tarball into a temp project and import it from JS and TypeScript
```

## Developer Certificate of Origin

Every commit must be signed off, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):

```bash
git commit -s -m "Add AccuLynx contact lookup"
```

That adds a line like `Signed-off-by: Your Name <you@example.com>` using your git
identity. CI checks every commit in a pull request for that line and fails
if one is missing.

## Code of conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
