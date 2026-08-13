# SOC and bulk-density uncertainty mapping

Each worker reads one existing 250 m multiband covariate tile and writes one
nine-band Cloud-Optimized GeoTIFF for every requested depth. Both targets are
calculated in the same windowed pass.

Output bands:

1. `soc_pct_prediction`
2. `soc_pct_lower_90`
3. `soc_pct_upper_90`
4. `soc_pct_interval_width`
5. `bulk_density_prediction`
6. `bulk_density_lower_90`
7. `bulk_density_upper_90`
8. `bulk_density_interval_width`
9. `valid_data_mask`

SOC intervals are calibrated on RaCA grouped out-of-fold errors. The bulk-density
mapping interval is widened with the stored DSP4SH calibration multiplier to
target 90% transfer coverage. This makes DSP4SH calibration data rather than an
independent interval-validation set; bulk-density point transfer remains poor
and must be reported as a limitation.

## Local pilot after authenticating

```bash
gcloud auth login
gcloud config set project xia-soil-lab-b386
gcloud auth application-default login

mkdir -p /tmp/soil-map-pilot
gsutil cp \
  gs://conus_grid_covariates/RaCA_grid/ONE_TILE.tif \
  /tmp/soil-map-pilot/covariates.tif

python3 code/07_make_target_depth_uncertainty_maps.py \
  --input /tmp/soil-map-pilot/covariates.tif \
  --output-dir /tmp/soil-map-pilot/results \
  --depths 5 15 30 60 100
```

Do not start the full CONUS run until this pilot passes the feature-contract
check and its outputs have been visually inspected.

## Build the worker image

```bash
gcloud builds submit . \
  --config cloud/cloudbuild.yaml \
  --substitutions _IMAGE=us-central1-docker.pkg.dev/xia-soil-lab-b386/soil-mapping/uncertainty-worker:latest
```

The Batch service account should have only Artifact Registry read access and
object read/write access on `conus_grid_covariates`. Do not use the default
Compute Engine service account or project-wide Editor.

The project organization policy prohibits external VM IP addresses. Every job
therefore sets `noExternalIpAddress: true` and explicitly uses a VPC subnet.
Before submission, verify that the selected subnet has Private Google Access
enabled so the worker can reach Cloud Storage, Artifact Registry, Batch, and
Cloud Logging. The defaults are network `default`, subnet `default`; override
them with the `NETWORK` and `SUBNETWORK` environment variables when necessary.

## Worker command

```bash
python3 code/06_make_target_depth_prediction_maps.py \
  --input-uri gs://conus_grid_covariates/RaCA_grid/ONE_TILE.tif \
  --output-prefix gs://conus_grid_covariates/uncertainty_maps/2010_07_01 \
  --depths 5 15 30 60 100
```

Create one Cloud Batch task for each input tile. A task processes all depths so
the multi-gigabyte input tile is downloaded only once.

## Submit one pilot, then the full array

Run these commands from the `Final_Paper_Analysis` directory in Cloud Shell.
The script builds a sorted tile manifest and uses the zero-based
`BATCH_TASK_INDEX` to assign exactly one tile to each task.

```bash
# Safe pilot: submits only manifest tile 0.
bash cloud/submit_uncertainty_batch.sh pilot

# After inspecting all five pilot GeoTIFFs and its QC JSON:
PARALLELISM=8 bash cloud/submit_uncertainty_batch.sh full
```

By default, existing output objects are skipped. Use a new output prefix for a
new model version rather than overwriting a prior run.
