# dockerpeek

Browse the filesystem of any public container image in your browser, without pulling it.

**Live:** https://dockerpeek.nivekithan.com

https://github.com/user-attachments/assets/24264a4a-c042-4d5b-a59d-51b57da991c0

## Development

```sh
pnpm install
pnpm dev
```

Web runs on http://localhost:5173 and the API on http://localhost:5174.

```sh
pnpm exec vp run check   # format, lint, and type check
pnpm build
```

## Deployment

Pushes to `main` deploy the API and web Workers to Cloudflare through GitHub Actions.
