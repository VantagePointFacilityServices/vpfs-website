# Architecture

How the pieces in this repo — the static site, the Cloudflare Worker, and
the DNS config — fit together with the outside systems (GoDaddy,
Cloudflare, GitHub) that host and route them. See `docs/DEPLOYMENT.md` for
the step-by-step setup runbook and `docs/DEVELOPMENT.md` for day-to-day
install/run/test.

## Domains and hosting

Two domains, one registrar (GoDaddy), one DNS provider (Cloudflare), one
hosting target (GitHub Pages) — `vantagepointfacilityservices.com` carries
no content of its own; it exists only to redirect to the real site.

```mermaid
flowchart TD
    subgraph GD["GoDaddy — registrar only"]
        D1["vantagepointfacilityservices.com.au"]
        D2["vantagepointfacilityservices.com"]
    end

    D1 -- "nameservers point to" --> CF
    D2 -- "nameservers point to" --> CF

    subgraph CF["Cloudflare — authoritative DNS"]
        Z1["Zone: .com.au\ndns/zones/vantagepointfacilityservices.com.au.yaml\nA x4 -> GitHub Pages IPs (DNS-only)\nCNAME www -> vantagepointfacilityservices.github.io"]
        Z2["Zone: .com\ndns/zones/vantagepointfacilityservices.com.yaml\nA/CNAME apex (proxied, placeholder IP)\nRedirect Rule: 301 -> .com.au, path+query preserved"]
    end

    Visitor(("Visitor")) -- "https://...com.au/*" --> Z1
    Visitor -- "https://...com/*" --> Z2
    Z2 -. "edge fires Redirect Rule\nbefore any origin contact" .-> Z1
    Z1 -- "resolves to (DNS only,\napex and www both)" --> GHP["GitHub Pages\nsite/ — served via\n.github/workflows/deploy-website.yml\nsite/CNAME = www (canonical);\nGitHub 301s bare apex -> www"]

    GHP -- "Stage 1 gate form\n(embedded GHL JS widget)" --> GHL["GoHighLevel"]
    GHL -- "webhook on submit/booking/outcome" --> W["Cloudflare Worker\nworker/worker.js\n/gate /enrich /confirm /outcome"]
    W -- "writes lead_tier / dq_flag / score" --> GHL
```

`dns/sync-dns.mjs` is what actually creates/updates the records and the
redirect rule shown above — see `dns/README.md` for the zone-file format.

## CI/CD

Three independent GitHub Actions workflows, each scoped to the part of the
repo it deploys — a change to `worker/` never touches the site, and vice
versa.

```mermaid
flowchart LR
    subgraph Repo["This repo"]
        S["site/**"]
        W["worker/**"]
        DZ["dns/zones/**, dns/sync-dns.mjs"]
    end

    S -- "push to main" --> WF1["deploy-website.yml"]
    WF1 --> Pages["GitHub Pages"]

    W -- "push to main / PR" --> WF2T["deploy-worker.yml\ntest job (95% coverage gate)"]
    WF2T -- "tests pass, push to main only" --> WF2D["deploy job\nwrangler deploy"]
    WF2D --> CFW["Cloudflare Worker"]

    DZ -- "PR" --> WF3T["sync-dns.yml\ntest job (95% coverage gate)"]
    WF3T -- "tests pass" --> WF3S["sync job\n(dry run on PR)"]
    DZ -- "workflow_dispatch" --> WF3T
    WF3S -- "--apply, manual only" --> CFD["Cloudflare\nDNS records + Redirect Rules"]
```

Key asymmetry, deliberate: the worker's `deploy` job runs automatically on
every push to `main` once tests pass. The DNS `sync` job never auto-applies
— even a passing test run only dry-runs on a PR; an actual `--apply`
requires a manual `workflow_dispatch`. A bad DNS record or redirect can
break email or take the live site down with no test suite able to catch
that in advance; a bad Worker deploy is caught by the request/response
shape tests before it ships.

## Request lifecycle: a visitor hitting the `.com` domain

Three redirect hops from the `.com` domain to the final page — worth
knowing if this ever shows up as a Lighthouse/PageSpeed warning, or if a
paid-ad landing URL should just use the canonical `www.…com.au` host
directly to avoid the extra round trips.

```mermaid
sequenceDiagram
    participant V as Visitor
    participant CF2 as Cloudflare (.com zone)
    participant CF1 as Cloudflare (.com.au zone)
    participant GH as GitHub Pages

    V->>CF2: GET https://vantagepointfacilityservices.com/services.html
    Note over CF2: Redirect Rule matches (http.host eq this domain)<br/>origin (192.0.2.1 placeholder) never contacted
    CF2-->>V: 301 Location: https://vantagepointfacilityservices.com.au/services.html
    V->>CF1: GET https://vantagepointfacilityservices.com.au/services.html
    Note over CF1: DNS-only (grey cloud) — Cloudflare<br/>doesn't proxy this request, just resolves it
    CF1-->>V: (resolves to GitHub Pages IP)
    V->>GH: GET /services.html (bare apex host)
    Note over GH: site/CNAME is the www host, not apex —<br/>GitHub redirects apex requests to canonical
    GH-->>V: 301 Location: https://www.vantagepointfacilityservices.com.au/services.html
    V->>GH: GET /services.html (www host, GitHub's own TLS cert)
    GH-->>V: 200 OK, page content
```

## Components at a glance

| Component | Role | Configured in |
|---|---|---|
| GoDaddy | Domain registrar for both domains | Nameservers only — no DNS records managed here after initial handoff |
| Cloudflare DNS | Authoritative DNS for both zones | `dns/zones/*.yaml`, applied by `dns/sync-dns.mjs` |
| Cloudflare Redirect Rules | `.com` → `.com.au` 301 | `dns/zones/vantagepointfacilityservices.com.yaml`'s `redirects:` block |
| GitHub Pages | Hosts the static site; redirects bare apex → `www` | `site/`, `site/CNAME` (= `www.vantagepointfacilityservices.com.au`), `.github/workflows/deploy-website.yml` |
| Cloudflare Workers | Lead-scoring webhook receiver | `worker/worker.js`, `worker/wrangler.toml`, `.github/workflows/deploy-worker.yml` |
| GoHighLevel | CRM — sends webhooks to the Worker, receives writes back | External; field structure documented in the `vpos` repo |
