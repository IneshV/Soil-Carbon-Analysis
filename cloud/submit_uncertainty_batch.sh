#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-xia-soil-lab-b386}"
REGION="${REGION:-us-central1}"
BUCKET="${BUCKET:-conus_grid_covariates}"
DATE_TAG="${DATE_TAG:-2010_07_01}"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/soil-mapping/uncertainty-worker:latest}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-soc-map-batch@${PROJECT_ID}.iam.gserviceaccount.com}"
NETWORK="${NETWORK:-default}"
SUBNETWORK="${SUBNETWORK:-default}"
INPUT_GLOB="${INPUT_GLOB:-gs://${BUCKET}/RaCA_grid/MASTER_CONUS_covariates_250m_${DATE_TAG}*.tif}"
MANIFEST_URI="${MANIFEST_URI:-gs://${BUCKET}/batch_manifests/uncertainty_${DATE_TAG}.txt}"
OUTPUT_PREFIX="${OUTPUT_PREFIX:-gs://${BUCKET}/uncertainty_maps/${DATE_TAG}}"
MODE="${1:-pilot}"

command -v gcloud >/dev/null || { echo "gcloud is required (Cloud Shell already includes it)."; exit 1; }
command -v gsutil >/dev/null || { echo "gsutil is required."; exit 1; }

manifest_file="$(mktemp)"
job_file=""
trap 'rm -f "$manifest_file"; [[ -z "$job_file" ]] || rm -f "$job_file"' EXIT
gsutil ls "$INPUT_GLOB" | LC_ALL=C sort > "$manifest_file"
tile_count="$(wc -l < "$manifest_file" | tr -d ' ')"
if [[ "$tile_count" -eq 0 ]]; then
  echo "No input tiles matched $INPUT_GLOB"
  exit 1
fi
gsutil cp "$manifest_file" "$MANIFEST_URI"

if [[ "$MODE" == "pilot" ]]; then
  task_count=1
  parallelism=1
elif [[ "$MODE" == "full" ]]; then
  task_count="$tile_count"
  parallelism="${PARALLELISM:-8}"
else
  echo "Usage: $0 [pilot|full]"
  exit 2
fi

job_id="uncertainty-${DATE_TAG//_/-}-${MODE}-$(date -u +%Y%m%d-%H%M%S)"
job_file="$(mktemp)"
python3 cloud/write_batch_job.py \
  --output "$job_file" \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT" \
  --project-id "$PROJECT_ID" \
  --region "$REGION" \
  --network "$NETWORK" \
  --subnetwork "$SUBNETWORK" \
  --manifest-uri "$MANIFEST_URI" \
  --output-prefix "$OUTPUT_PREFIX" \
  --task-count "$task_count" \
  --parallelism "$parallelism"

echo "Submitting $job_id with $task_count of $tile_count tile(s); parallelism=$parallelism"
gcloud batch jobs submit "$job_id" --project "$PROJECT_ID" --location "$REGION" --config "$job_file"
echo "Monitor: gcloud batch jobs describe $job_id --project $PROJECT_ID --location $REGION"
