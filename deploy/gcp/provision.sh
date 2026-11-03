#!/bin/bash
# One-time (idempotent) Google Cloud setup for the Aurevon Discord bot.
#
#   PROJECT=<project-id> deploy/gcp/provision.sh
#
# Creates, inside the always-free tier:
#   - service account aurevon-discord-bot   (runtime: reads the bundle + secret)
#   - bucket gs://<project>-aurevon-bot     (the bot bundle, us-east1)
#   - secret aurevon-bot-env                (the bot's dotenv file; you add the value)
#   - VM aurevon-discord-bot                (e2-micro, us-east1-b, 30 GB pd-standard)
#   - service account aurevon-bot-deployer + GitHub OIDC pool, so pushes to
#     main can upload a new bundle without any stored key
# Re-running is safe: existing resources are left alone, bindings are re-applied.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT=<gcp project id>}"
REGION=us-east1
ZONE=us-east1-b
VM=aurevon-discord-bot
BUCKET="gs://${PROJECT}-aurevon-bot"
SECRET=aurevon-bot-env
RUNTIME_SA="aurevon-discord-bot@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA="aurevon-bot-deployer@${PROJECT}.iam.gserviceaccount.com"
GITHUB_REPO_ID=1228617503   # mikerivera33/Aurevon-site
HERE="$(cd "$(dirname "$0")" && pwd)"

g() { gcloud --project "$PROJECT" --quiet "$@"; }
exists() { "$@" >/dev/null 2>&1; }

g services enable compute.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

exists g iam service-accounts describe "$RUNTIME_SA" ||
  g iam service-accounts create aurevon-discord-bot --display-name="Aurevon Discord bot (VM)"
exists g iam service-accounts describe "$DEPLOY_SA" ||
  g iam service-accounts create aurevon-bot-deployer --display-name="Aurevon Discord bot deployer (GitHub Actions)"

exists g storage buckets describe "$BUCKET" ||
  g storage buckets create "$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
g storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$RUNTIME_SA" --role=roles/storage.objectViewer >/dev/null
g storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$DEPLOY_SA" --role=roles/storage.objectUser >/dev/null

exists g secrets describe "$SECRET" ||
  g secrets create "$SECRET" --replication-policy=user-managed --locations="$REGION"
g secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor >/dev/null

if ! exists g compute instances describe "$VM" --zone="$ZONE"; then
  g compute instances create "$VM" --zone="$ZONE" --machine-type=e2-micro \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --service-account="$RUNTIME_SA" --scopes=cloud-platform \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata="bot-bucket=${BUCKET#gs://},bot-secret=$SECRET,enable-oslogin=TRUE" \
    --metadata-from-file=startup-script="$HERE/startup.sh"
else
  # Keep the VM's startup script in step with the repo (applies on next boot).
  g compute instances add-metadata "$VM" --zone="$ZONE" --metadata-from-file=startup-script="$HERE/startup.sh"
fi

# GitHub Actions → Google, keyless: only pushes to main of this repo may act as the deployer.
NUMBER="$(g projects describe "$PROJECT" --format='value(projectNumber)')"
exists g iam workload-identity-pools describe github --location=global ||
  g iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
exists g iam workload-identity-pools providers describe aurevon-site --location=global --workload-identity-pool=github ||
  g iam workload-identity-pools providers create-oidc aurevon-site --location=global --workload-identity-pool=github \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref \
    --attribute-condition="assertion.repository_id=='${GITHUB_REPO_ID}' && assertion.ref=='refs/heads/main'"
g iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository_id/${GITHUB_REPO_ID}" >/dev/null

echo
echo "Provisioned. Workload identity provider for .github/workflows/deploy-discord-bot.yml:"
echo "  projects/${NUMBER}/locations/global/workloadIdentityPools/github/providers/aurevon-site"
echo "Next: add the bot's env as a version of secret '$SECRET', then run deploy/gcp/deploy.sh."
