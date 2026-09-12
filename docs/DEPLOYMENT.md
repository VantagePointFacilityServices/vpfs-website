# Deploying vantagepointfacilityservices.com.au

One-time setup to take this repo from "code exists" to "the site is live at
`https://vantagepointfacilityservices.com.au`, with
`vantagepointfacilityservices.com` 301-redirecting to it." Covers GoDaddy
(registrar for both domains), Cloudflare (DNS + redirect), and GitHub
Pages/Actions (hosting + deploy).

Do the parts in order — later parts depend on earlier ones (e.g. you can't
issue a GitHub Pages TLS cert before DNS actually points at GitHub).

## Architecture

See `docs/ARCHITECTURE.md` for diagrams of the domain/DNS setup, the three
CI/CD workflows, and a visitor request lifecycle. Summary:

- **GoDaddy** — domain *registrar* only, for both domains. DNS management
  is delegated to Cloudflare via nameservers; you won't touch DNS records
  in GoDaddy again after Part 1.
- **Cloudflare** — authoritative DNS for both zones, plus the redirect
  rule on the `.com` zone. Managed declaratively by this repo:
  `dns/zones/*.yaml` (desired state) + `dns/sync-dns.mjs` (applies it via
  the Cloudflare API) — see `dns/README.md`.
- **GitHub Pages** — hosts the actual site (`site/`), deployed by
  `.github/workflows/deploy-website.yml` on every push to `main`.
- **`vantagepointfacilityservices.com`** carries no content of its own —
  it exists only to redirect to the `.com.au` site (`dns/zones/vantagepointfacilityservices.com.yaml`).
  It already has a live mailbox; **read that file's warning banner before
  touching its DNS.**

## Part 1 — Add both domains to Cloudflare

Do this before touching GoDaddy — Cloudflare only gives you the
nameservers to switch to *after* you add the site.

For **each** domain (`vantagepointfacilityservices.com.au` and
`vantagepointfacilityservices.com`):

1. Cloudflare dashboard → **Add a Site** → enter the domain.
2. Choose the **Free** plan.
3. Cloudflare scans existing DNS records and shows you what it found —
   review, but don't worry about getting this perfect; `sync-dns.mjs`
   will reconcile it against `dns/zones/<domain>.yaml` in Part 5.
4. Continue. Cloudflare shows you **two nameservers** (e.g.
   `xxx.ns.cloudflare.com`, `yyy.ns.cloudflare.com`) — copy both, you need
   them in Part 2. They're different per domain.

## Part 2 — Point GoDaddy at Cloudflare

For **each** domain:

1. [GoDaddy](https://www.godaddy.com) → **My Products** → find the domain
   → **DNS** (or **Manage DNS**).
2. Find **Nameservers** → **Change** → **Enter my own nameservers
   (custom)**.
3. Paste in the two Cloudflare nameservers from Part 1. Remove any
   existing GoDaddy nameservers.
4. Save.
5. Back in Cloudflare, click **Done, check nameservers** on that domain.

Propagation is usually a few hours, GoDaddy warns up to 48h. Cloudflare
emails you once each domain shows **Active**. Don't proceed to Part 5
for a domain until it's Active.

## Part 3 — Cloudflare zone settings

For **each** domain, once Active:

- **SSL/TLS → Overview**: leave the encryption mode on the default
  (**Flexible**). It doesn't meaningfully matter for either zone here —
  the `.com.au` records are DNS-only (not proxied), so Cloudflare isn't
  terminating TLS for them at all; the `.com` zone's redirect rule fires
  before Cloudflare would ever contact an origin, so origin encryption
  mode is moot there too.
- Universal SSL (Cloudflare's own edge certificate) activates
  automatically — can take up to 24h on a newly added domain.

## Part 4 — Create a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token**.

- Template: **Edit zone DNS**.
- Permissions: add both `Zone:DNS:Edit` and `Zone:Zone:Read` (the
  template includes DNS:Edit; add Zone:Read too — `sync-dns.mjs` looks up
  each zone by name).
- Zone Resources: **Specific zone** → select both
  `vantagepointfacilityservices.com.au` and
  `vantagepointfacilityservices.com` (or "All zones" if you'd rather not
  maintain the list as more domains are added later).
- Create Token → copy it now, Cloudflare won't show it again.

Keep this separate from any token used to deploy the Cloudflare Worker
(`worker/wrangler.toml`) — least privilege; the DNS token doesn't need
Workers permissions and vice versa.

## Part 5 — Wire the token in

**Locally** (for running `sync-dns.mjs` from your machine):

```bash
cd dns
npm install
cp .env.example .env
# paste the token into .env as CLOUDFLARE_API_TOKEN=...
```

**In CI** (for `.github/workflows/sync-dns.yml`):

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo VantagePointFacilityServices/vpfs-website
# paste the token when prompted
```

or via the UI: repo → **Settings → Secrets and variables → Actions → New
repository secret**, name `CLOUDFLARE_API_TOKEN`.

## Part 6 — Apply DNS and the redirect

Always dry-run first:

```bash
cd dns
node --env-file=.env sync-dns.mjs
```

Read the plan for **both** zones carefully:

- `vantagepointfacilityservices.com.au` — should show CREATE for the 4
  GitHub Pages apex A records and the `www` CNAME (assuming a fresh zone
  with nothing there yet).
- `vantagepointfacilityservices.com` — check specifically for any
  existing apex A/CNAME record showing as **UPDATE** rather than
  **CREATE**. If you see UPDATE there, stop and find out what it
  currently points to before proceeding — it may be an existing website
  you don't want to silently replace. This zone already has live email
  (MX/SPF/DKIM) that isn't in `records.yaml` by design; that's expected
  and fine as long as you never pass `--prune`.

Once the plan looks right:

```bash
node --env-file=.env sync-dns.mjs --apply
```

Never add `--prune` on `vantagepointfacilityservices.com` — it would
delete the live email records this file doesn't list. See
`dns/zones/vantagepointfacilityservices.com.yaml`'s header comment.

This single command creates the `.com.au` website DNS records **and**
the `.com` → `.com.au` redirect rule (via Cloudflare's Redirect Rules
API) in one pass — see `dns/README.md` for exactly what each zone file
declares.

## Part 7 — GitHub Pages

1. **Enable Pages with Actions as the source** (one-time). Via CLI:

   ```bash
   gh api -X POST repos/VantagePointFacilityServices/vpfs-website/pages \
     -f build_type=workflow
   ```

   Or via UI: repo → **Settings → Pages → Build and deployment → Source
   → GitHub Actions**.

2. **Run the deploy workflow** so Pages has something published:

   ```bash
   gh workflow run deploy-website.yml --repo VantagePointFacilityServices/vpfs-website
   ```

   (It also runs automatically on every push to `main` touching `site/**`.)

3. **Set the custom domain.** Repo → **Settings → Pages → Custom domain**
   → enter `www.vantagepointfacilityservices.com.au` (the canonical host
   — matches every page's `<link rel="canonical">`/`og:url` and
   `sitemap.xml`; the bare apex is what redirects *to* this, not the
   other way round) → Save. (`site/CNAME` is already committed with this
   value, but the Settings field is what actually triggers GitHub's DNS
   ownership check and cert issuance — entering it here is required even
   though the file already matches.)

4. Wait for the domain check to go green (DNS must already be applied
   from Part 6 for this to succeed — GitHub checks the live A/CNAME
   records). Can take anywhere from a few minutes to ~24h depending on
   propagation.

5. Once green, tick **Enforce HTTPS** (only appears after the cert is
   issued).

## Part 8 — Verify

```bash
# Canonical host serves over HTTPS
curl -I https://www.vantagepointfacilityservices.com.au

# Bare apex redirects to www (GitHub Pages side, not Cloudflare)
curl -I https://vantagepointfacilityservices.com.au
# expect: 301 Location: https://www.vantagepointfacilityservices.com.au/

# .com redirects to .com.au apex, path preserved (Cloudflare Redirect Rule)
curl -I https://vantagepointfacilityservices.com/services.html
# expect: HTTP/2 301, location: https://vantagepointfacilityservices.com.au/services.html
# — which itself then redirects to https://www.vantagepointfacilityservices.com.au/services.html

# Existing email on the .com domain still works — send yourself a test
# message to confirm the DNS apply in Part 6 didn't disturb MX/SPF/DKIM.
```

## Troubleshooting

- **GitHub Pages says "domain's DNS record could not be retrieved"** —
  DNS hasn't propagated yet, or Part 6 wasn't applied for that zone. Run
  `dig vantagepointfacilityservices.com.au` and confirm it returns the
  four `185.199.10x.153` addresses.
- **Redirect loop on the `.com` domain** — only relevant if you ever
  switch its records to `proxied: false` or change the SSL/TLS mode away
  from what Part 3 sets; the default config here shouldn't hit this.
- **Certificate/HTTPS check stuck on the `.com.au` domain** — check for
  an existing **CAA record** on the zone restricting which certificate
  authorities can issue for it. GitHub Pages uses Let's Encrypt; if a CAA
  record exists and doesn't authorize `letsencrypt.org`, remove or fix
  it (not something `sync-dns.mjs` manages today — check the Cloudflare
  DNS tab directly).
- **`sync-dns.mjs` fails with "No Cloudflare zone found"** — the domain
  hasn't finished the Part 1/2 nameserver handoff yet (still shows
  "Pending Nameserver Update" in Cloudflare), or the API token in Part 4
  isn't scoped to that zone.
