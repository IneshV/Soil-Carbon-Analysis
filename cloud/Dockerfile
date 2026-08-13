FROM google/cloud-sdk:slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY cloud/requirements.txt /workspace/cloud/requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /workspace/cloud/requirements.txt
COPY code/06_make_target_depth_prediction_maps.py code/07_make_target_depth_uncertainty_maps.py /workspace/code/
COPY model_artifacts/soc_pct/soc_pct_preprocessor.joblib model_artifacts/soc_pct/soc_pct_xgboost.json model_artifacts/soc_pct/run_manifest.json /workspace/model_artifacts/soc_pct/
COPY model_artifacts/soc_pct_uncertainty/uncertainty_preprocessor.joblib model_artifacts/soc_pct_uncertainty/uncertainty_xgboost.json model_artifacts/soc_pct_uncertainty/run_manifest.json /workspace/model_artifacts/soc_pct_uncertainty/
COPY model_artifacts/bulk_density/point_preprocessor.joblib model_artifacts/bulk_density/point_xgboost.json model_artifacts/bulk_density/run_manifest.json /workspace/model_artifacts/bulk_density/
COPY model_artifacts/bulk_density_uncertainty/uncertainty_preprocessor.joblib model_artifacts/bulk_density_uncertainty/uncertainty_xgboost.json model_artifacts/bulk_density_uncertainty/run_manifest.json /workspace/model_artifacts/bulk_density_uncertainty/
ENTRYPOINT ["python3", "/workspace/code/06_make_target_depth_prediction_maps.py", "--project-dir", "/workspace"]
