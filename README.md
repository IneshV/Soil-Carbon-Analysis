# Final Paper Analysis

Reproducible cleaning and Google Earth Engine pointwise covariate extraction code for the final soil-carbon analysis.

## Contents

- `code/01_clean_raw_data_for_gee.ipynb`: EDA and cleaning workflow for RaCA and DSP4SH source data.
- `code/02_all_covariates_unique_points.js`: Google Earth Engine script that extracts the full covariate stack once per unique coordinate and exports one CSV to Google Drive.
- `raw_data/dsp4sh6.db`: DSP4SH source database.
- `GEE_ready_datasets/dsp4sh_clean.csv`: cleaned DSP4SH observation table.
- `GEE_ready_datasets/dsp4sh_gee_points.csv`: unique DSP4SH coordinates for Earth Engine.

RaCA source and derived datasets are intentionally excluded from version control. Place the RaCA workbook at `raw_data/RaCA_2025.xlsx` locally before running the cleaning notebook.

