# Alberta Constituent Briefing Tool

Two static pages plus one serverless function:

- `index.html` — Step 1: paste a campaign letter, pick a tone, add a personal
  note, get it rewritten. Calls `/api/paraphrase`.
- `contacts.html` — Step 2: find your MLA (Represent API) and the relevant
  minister (with verified role-based emails), build a list, copy addresses.
- `api/paraphrase.js` — Vercel serverless function that holds the Anthropic
  API key and proxies the rewrite request. This is the only piece that needs
  configuration before it works.

## Deploying to Vercel

1. Push this folder to a GitHub repo (or connect the existing one).
2. Import it in Vercel — no build step needed, it'll auto-detect the static
   files and the `api/` function.
3. **Set the environment variable** in Vercel: Project → Settings →
   Environment Variables:
   - `ANTHROPIC_API_KEY` — your Anthropic API key. Required — without it,
     `/api/paraphrase` returns a 500 with "Server isn't configured with an
     API key yet."
   - `ALLOWED_ORIGIN` — optional. Only needed if you ever host the frontend
     on a different domain than the API function. Leave unset for a normal
     same-domain Vercel deployment.
4. Redeploy after adding the env var (Vercel doesn't hot-reload them into
   already-running functions).

## About the rate limit

`api/paraphrase.js` caps requests to 8 per IP per hour, tracked in an
in-memory `Map`. This resets whenever the serverless function cold-starts,
so it's a soft guard against a runaway script or someone hammering the
endpoint — not a hard guarantee. If this tool gets real traffic and you want
a durable limit, swap the `Map` for Vercel KV or Upstash Redis (a few line
change — the `isRateLimited` function is the only thing that needs to
change).

## Updating ministry data

See the comment block above `const MINISTRIES` in `contacts.html` for how
to re-sync portfolio titles, minister names, and verified emails against
the Government of Alberta's cabinet page and staff directory.
