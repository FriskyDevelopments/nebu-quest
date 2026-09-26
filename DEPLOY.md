# NEBU.QUEST — Deploy

Pages project: `nebu-quest` (custom domains `nebu.quest`, `www.nebu.quest`,
production branch `main`). Rooms signaling: Worker `nebu-rooms` at
`https://nebu-rooms.hrgrrtks2p.workers.dev`.

Everything below uses a Cloudflare API token in the environment
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). No `wrangler login`.

## Preview (safe, never touches nebu.quest)

```bash
./scripts/stage.sh
npx wrangler pages deploy dist --project-name nebu-quest --branch fix-working-studio
# -> https://fix-working-studio.nebu-quest.pages.dev
```

## Promote to production

Production is whatever is deployed to the `main` branch of the Pages project.

1. Merge the PR into `main`.
2. Deploy `main`:
   ```bash
   git checkout main && git pull
   ./scripts/stage.sh
   npx wrangler pages deploy dist --project-name nebu-quest --branch main
   ```
   (Or add the two Actions secrets and let `.github/workflows/deploy.yml` do it on push.)
3. Check: `curl -s https://nebu.quest/ | grep -c '/studio/'` is non-zero, and
   `https://nebu.quest/studio/` loads and asks for camera and mic.

The `nebu-rooms` Worker is already live on workers.dev and allows the
`nebu.quest`, `www.nebu.quest` and `*.nebu-quest.pages.dev` origins, so rooms
work on production without another Worker deploy. No DNS changes in either
direction.

## Rollback

```bash
npx wrangler pages deployment list --project-name nebu-quest
```

Then roll back to the previous production deployment in the Pages dashboard
(Deployments → ⋯ → Rollback), or redeploy the previous commit's tree with the
promote commands above.

## Do NOT

- Do NOT deploy to `--branch main` without the owner's OK.
- Do NOT touch `vc.friskydev.com` or the vc-node repo.
