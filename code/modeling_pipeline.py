"""Reproducible RaCA SOC modeling and independent DSP4SH evaluation."""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder


SEED = 42
N_FOLDS = 5
SOC_MAX = 12.5


def project_dir() -> Path:
    here = Path.cwd().resolve()
    for candidate in [here, here.parent, Path(__file__).resolve().parents[1]]:
        if (candidate / "code").exists() and (candidate / "GEE_ready_datasets").exists():
            return candidate
    raise FileNotFoundError("Could not locate Final_Paper_Analysis")


def legacy_dir(project: Path) -> Path:
    candidate = project.parent / "RaCA" / "final stuff" / "best_model"
    if not candidate.exists():
        raise FileNotFoundError(
            "Prepared covariate tables were not found. Export and join the observation-aligned "
            "GEE covariates, or restore the legacy RaCA/final stuff/best_model directory."
        )
    return candidate


def load_manifest(base: Path) -> dict:
    path = base / "soc_pct_final_model" / "soc_pct_final_model_manifest.json"
    return json.loads(path.read_text())


def load_model_tables(project: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict, dict]:
    """Load the previous fully joined feature tables, with explicit provenance."""
    base = legacy_dir(project)
    raca_path = base / "dataset2_feature_outputs" / "raca_use_dataset2_features.csv"
    dsp_path = base / "dataset2_feature_outputs" / "dsp_use_dataset2_features.csv"
    manifest = load_manifest(base)
    use = list(dict.fromkeys(
        manifest["feature_selection"]["features"]
        + ["SOC_pct", "rcasiteid", "final_lat", "final_lon", "TOP", "BOT"]
    ))
    dsp_use = list(dict.fromkeys(
        manifest["feature_selection"]["features"]
        + ["SOC_pct", "DSP_Pedon", "DSP_Pedon_ID", "final_lat", "final_lon", "TOP", "BOT"]
    ))
    raca = pd.read_csv(raca_path, usecols=lambda c: c in use, low_memory=False)
    dsp = pd.read_csv(dsp_path, usecols=lambda c: c in dsp_use, low_memory=False)
    provenance = {
        "raca": str(raca_path.resolve()),
        "dsp4sh": str(dsp_path.resolve()),
        "manifest": str((base / "soc_pct_final_model" / "soc_pct_final_model_manifest.json").resolve()),
    }
    return raca, dsp, manifest, provenance


def prepare_tables(raca: pd.DataFrame, dsp: pd.DataFrame, features: list[str]):
    raca = raca.copy()
    dsp = dsp.copy()
    for frame in [raca, dsp]:
        if "z_mid" not in frame and {"TOP", "BOT"}.issubset(frame):
            frame["z_mid"] = (pd.to_numeric(frame["TOP"], errors="coerce") + pd.to_numeric(frame["BOT"], errors="coerce")) / 2
        frame["SOC_pct"] = pd.to_numeric(frame["SOC_pct"], errors="coerce")
        frame["final_lat"] = pd.to_numeric(frame["final_lat"], errors="coerce")
        frame["final_lon"] = pd.to_numeric(frame["final_lon"], errors="coerce")
    raca = raca.loc[
        raca["SOC_pct"].notna()
        & raca["SOC_pct"].ge(0)
        & raca["SOC_pct"].lt(SOC_MAX)
        & raca["rcasiteid"].notna()
    ].reset_index(drop=True)
    dsp = dsp.loc[
        dsp["SOC_pct"].notna()
        & dsp["SOC_pct"].ge(0)
        & dsp["final_lat"].between(-90, 90)
        & dsp["final_lon"].between(-180, 180)
    ].reset_index(drop=True)
    missing_raca = sorted(set(features) - set(raca.columns))
    missing_dsp = sorted(set(features) - set(dsp.columns))
    if missing_raca or missing_dsp:
        raise ValueError(f"Missing features — RaCA: {missing_raca}; DSP4SH: {missing_dsp}")
    return raca, dsp


def build_preprocessor(numeric: list[str], categorical: list[str]) -> ColumnTransformer:
    numeric_pipe = Pipeline([
        ("impute", SimpleImputer(strategy="median", add_indicator=True)),
    ])
    categorical_pipe = Pipeline([
        ("impute", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=True)),
    ])
    return ColumnTransformer([
        ("numeric", numeric_pipe, numeric),
        ("categorical", categorical_pipe, categorical),
    ])


def build_model(params: dict, n_estimators: int) -> xgb.XGBRegressor:
    translated = {
        "objective": params.get("objective", "reg:squarederror"),
        "eval_metric": params.get("eval_metric", "rmse"),
        "tree_method": params.get("tree_method", "hist"),
        "learning_rate": params["learning_rate"],
        "max_depth": params["max_depth"],
        "min_child_weight": params["min_child_weight"],
        "subsample": params["subsample"],
        "colsample_bytree": params["colsample_bytree"],
        "reg_lambda": params.get("lambda", 1.0),
        "reg_alpha": params.get("alpha", 0.0),
        "n_estimators": n_estimators,
        "random_state": SEED,
        "n_jobs": -1,
    }
    return xgb.XGBRegressor(**translated)


def metric_row(observed, predicted, label: str) -> dict:
    y = np.asarray(observed, dtype=float)
    p = np.asarray(predicted, dtype=float)
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    return {
        "dataset": label,
        "n": len(y),
        "R2": r2_score(y, p) if len(y) > 1 else np.nan,
        "RMSE": mean_squared_error(y, p) ** 0.5,
        "MAE": mean_absolute_error(y, p),
        "Bias": float(np.mean(p - y)),
        "Mean_observed": float(np.mean(y)),
        "Mean_predicted": float(np.mean(p)),
    }


def pixel_depth_aggregate(df: pd.DataFrame) -> pd.DataFrame:
    """Approximate EPSG:3857 250 m cells and paper-defined 10 cm depth bins."""
    radius = 6378137.0
    lon = np.deg2rad(df["final_lon"].to_numpy(float))
    lat = np.deg2rad(np.clip(df["final_lat"].to_numpy(float), -85.05112878, 85.05112878))
    x = radius * lon
    y = radius * np.log(np.tan(np.pi / 4 + lat / 2))
    work = df.copy()
    work["pixel_x_250m"] = np.floor(x / 250).astype("int64")
    work["pixel_y_250m"] = np.floor(y / 250).astype("int64")
    work["depth_bin_10cm"] = np.floor(pd.to_numeric(work["z_mid"], errors="coerce") / 10).astype("Int64")
    keys = ["pixel_x_250m", "pixel_y_250m", "depth_bin_10cm"]
    return work.groupby(keys, dropna=False, as_index=False).agg(
        observed_SOC_pct=("observed_SOC_pct", "mean"),
        predicted_SOC_pct=("predicted_SOC_pct", "mean"),
        n_horizons=("observed_SOC_pct", "size"),
    )


def train_soc(project: Path | None = None) -> dict:
    project = project or project_dir()
    out = project / "model_artifacts" / "soc_pct"
    out.mkdir(parents=True, exist_ok=True)
    raca, dsp, manifest, provenance = load_model_tables(project)
    features = manifest["feature_selection"]["features"]
    categorical = manifest["categorical_features"]
    numeric = [f for f in features if f not in categorical]
    raca, dsp = prepare_tables(raca, dsp, features)

    X = raca[features]
    y = raca["SOC_pct"].to_numpy(float)
    groups = raca["rcasiteid"].astype(str).to_numpy()
    oof = np.full(len(raca), np.nan)
    fold = np.zeros(len(raca), dtype=int)
    fold_metrics = []
    splitter = GroupKFold(n_splits=N_FOLDS)
    params = manifest["xgboost_params"]
    rounds = int(manifest["num_boost_round"])

    for fold_id, (train_idx, test_idx) in enumerate(splitter.split(X, y, groups), start=1):
        prep = build_preprocessor(numeric, categorical)
        X_train = prep.fit_transform(X.iloc[train_idx])
        X_test = prep.transform(X.iloc[test_idx])
        model = build_model(params, rounds)
        model.fit(X_train, np.log1p(y[train_idx]), verbose=False)
        pred = np.clip(np.expm1(model.predict(X_test)), 0, None)
        oof[test_idx] = pred
        fold[test_idx] = fold_id
        fold_metrics.append(metric_row(y[test_idx], pred, f"RaCA fold {fold_id}"))

    oof_table = raca[["rcasiteid", "final_lat", "final_lon", "z_mid", "SOC_pct"]].copy()
    oof_table = oof_table.rename(columns={"SOC_pct": "observed_SOC_pct"})
    oof_table["predicted_SOC_pct"] = oof
    oof_table["fold"] = fold
    oof_table.to_csv(out / "raca_soc_pct_oof_predictions.csv", index=False)
    pd.DataFrame(fold_metrics).to_csv(out / "raca_fold_metrics.csv", index=False)

    final_prep = build_preprocessor(numeric, categorical)
    X_all = final_prep.fit_transform(X)
    final_model = build_model(params, rounds)
    final_model.fit(X_all, np.log1p(y), verbose=False)
    joblib.dump(final_prep, out / "soc_pct_preprocessor.joblib")
    final_model.save_model(out / "soc_pct_xgboost.json")

    dsp_pred = np.clip(np.expm1(final_model.predict(final_prep.transform(dsp[features]))), 0, None)
    dsp_predictions = dsp[["DSP_Pedon", "DSP_Pedon_ID", "final_lat", "final_lon", "z_mid", "SOC_pct"]].copy()
    dsp_predictions = dsp_predictions.rename(columns={"SOC_pct": "observed_SOC_pct"})
    dsp_predictions["predicted_SOC_pct"] = dsp_pred
    dsp_predictions.to_csv(out / "dsp4sh_soc_pct_external_predictions.csv", index=False)

    raca_pixel = pixel_depth_aggregate(oof_table)
    dsp_pixel = pixel_depth_aggregate(dsp_predictions)
    raca_pixel.to_csv(out / "raca_pixel_depth_predictions.csv", index=False)
    dsp_pixel.to_csv(out / "dsp4sh_pixel_depth_predictions.csv", index=False)
    metrics = pd.DataFrame([
        metric_row(y, oof, "RaCA grouped OOF — rows"),
        metric_row(raca_pixel.observed_SOC_pct, raca_pixel.predicted_SOC_pct, "RaCA grouped OOF — 250m pixel × 10cm depth"),
        metric_row(dsp_predictions.observed_SOC_pct, dsp_predictions.predicted_SOC_pct, "DSP4SH external — rows"),
        metric_row(dsp_pixel.observed_SOC_pct, dsp_pixel.predicted_SOC_pct, "DSP4SH external — 250m pixel × 10cm depth"),
    ])
    metrics.to_csv(out / "soc_pct_performance.csv", index=False)

    run_manifest = {
        "target": "SOC_pct",
        "training_rows": len(raca),
        "training_sites": int(raca.rcasiteid.nunique()),
        "external_rows": len(dsp),
        "external_pedons": int(dsp.DSP_Pedon_ID.nunique()),
        "features": features,
        "categorical_features": categorical,
        "soc_filter": f"0 <= SOC_pct < {SOC_MAX}",
        "cv": "5-fold GroupKFold by rcasiteid",
        "provenance": provenance,
        "metrics": metrics.to_dict(orient="records"),
        "xgboost_version": xgb.__version__,
    }
    (out / "run_manifest.json").write_text(json.dumps(run_manifest, indent=2))
    return {"metrics": metrics, "fold_metrics": pd.DataFrame(fold_metrics), "manifest": run_manifest}


def subgroup_metrics(df: pd.DataFrame, group_col: str, minimum_n: int = 30) -> pd.DataFrame:
    rows = []
    for value, group in df.groupby(group_col, dropna=False):
        if len(group) < minimum_n:
            continue
        result = metric_row(group.observed_SOC_pct, group.predicted_SOC_pct, str(value))
        result[group_col] = value
        rows.append(result)
    return pd.DataFrame(rows)


def evaluate_saved_run(project: Path | None = None) -> dict:
    project = project or project_dir()
    out = project / "model_artifacts" / "soc_pct"
    metrics = pd.read_csv(out / "soc_pct_performance.csv")
    raca_oof = pd.read_csv(out / "raca_soc_pct_oof_predictions.csv")
    dsp = pd.read_csv(out / "dsp4sh_soc_pct_external_predictions.csv")
    raca_oof["depth_group"] = np.where(raca_oof.z_mid < 30, "0–30 cm", ">30 cm")
    dsp["depth_group"] = np.where(dsp.z_mid < 30, "0–30 cm", ">30 cm")
    depth = pd.concat([
        subgroup_metrics(raca_oof, "depth_group").assign(evaluation="RaCA grouped OOF"),
        subgroup_metrics(dsp, "depth_group").assign(evaluation="DSP4SH external"),
    ], ignore_index=True)
    depth.to_csv(out / "depth_group_performance.csv", index=False)
    return {"metrics": metrics, "depth_metrics": depth, "raca_oof": raca_oof, "dsp": dsp}


def interval_metric_row(df: pd.DataFrame, label: str) -> dict:
    ok = df[["observed_SOC_pct", "predicted_SOC_pct", "lower_90", "upper_90"]].notna().all(axis=1)
    work = df.loc[ok]
    covered = work.observed_SOC_pct.between(work.lower_90, work.upper_90, inclusive="both")
    return {
        "dataset": label,
        "n": len(work),
        "coverage_90": float(covered.mean()),
        "mean_interval_width": float((work.upper_90 - work.lower_90).mean()),
        "median_interval_width": float((work.upper_90 - work.lower_90).median()),
        "mean_lower": float(work.lower_90.mean()),
        "mean_upper": float(work.upper_90.mean()),
    }


def uncertainty_pixel_depth_aggregate(df: pd.DataFrame) -> pd.DataFrame:
    radius = 6378137.0
    lon = np.deg2rad(df["final_lon"].to_numpy(float))
    lat = np.deg2rad(np.clip(df["final_lat"].to_numpy(float), -85.05112878, 85.05112878))
    work = df.copy()
    work["pixel_x_250m"] = np.floor(radius * lon / 250).astype("int64")
    work["pixel_y_250m"] = np.floor(radius * np.log(np.tan(np.pi / 4 + lat / 2)) / 250).astype("int64")
    work["depth_bin_10cm"] = np.floor(pd.to_numeric(work.z_mid, errors="coerce") / 10).astype("Int64")
    return work.groupby(
        ["pixel_x_250m", "pixel_y_250m", "depth_bin_10cm"], as_index=False, dropna=False
    ).agg(
        observed_SOC_pct=("observed_SOC_pct", "mean"),
        predicted_SOC_pct=("predicted_SOC_pct", "mean"),
        lower_90=("lower_90", "mean"),
        upper_90=("upper_90", "mean"),
        n_horizons=("observed_SOC_pct", "size"),
    )


def train_uncertainty(project: Path | None = None, nominal_coverage: float = 0.90) -> dict:
    """Train a RaCA-only heteroscedastic error model and conformal scale factor.

    The response is absolute error from the already grouped OOF point predictions.
    A second grouped cross-fit produces honest error-scale predictions. The conformal
    multiplier is the finite-sample quantile of absolute-error / predicted-scale.
    DSP4SH is loaded only after fitting and calibration are complete.
    """
    project = project or project_dir()
    point_out = project / "model_artifacts" / "soc_pct"
    out = project / "model_artifacts" / "soc_pct_uncertainty"
    out.mkdir(parents=True, exist_ok=True)
    required = [
        point_out / "raca_soc_pct_oof_predictions.csv",
        point_out / "dsp4sh_soc_pct_external_predictions.csv",
        point_out / "run_manifest.json",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Run 03_train_raca_models.ipynb first. Missing: {missing}")

    raca, dsp, point_manifest, provenance = load_model_tables(project)
    features = point_manifest["feature_selection"]["features"]
    categorical = point_manifest["categorical_features"]
    raca, dsp = prepare_tables(raca, dsp, features)
    point_oof = pd.read_csv(required[0])
    dsp_point = pd.read_csv(required[1])
    if len(raca) != len(point_oof) or not np.allclose(raca.SOC_pct, point_oof.observed_SOC_pct):
        raise ValueError("RaCA feature rows no longer align with the saved point-model OOF predictions")
    if len(dsp) != len(dsp_point) or not np.allclose(dsp.SOC_pct, dsp_point.observed_SOC_pct):
        raise ValueError("DSP feature rows no longer align with saved external predictions")

    uncertainty_features = features + ["point_prediction"]
    uncertainty_numeric = [f for f in uncertainty_features if f not in categorical]
    raca_x = raca[features].copy()
    raca_x["point_prediction"] = point_oof.predicted_SOC_pct.to_numpy(float)
    absolute_error = np.abs(
        point_oof.observed_SOC_pct.to_numpy(float) - point_oof.predicted_SOC_pct.to_numpy(float)
    )
    groups = raca.rcasiteid.astype(str).to_numpy()
    scale_oof = np.full(len(raca), np.nan)
    fold = np.zeros(len(raca), dtype=int)
    uncertainty_params = {
        "objective": "reg:squarederror", "eval_metric": "rmse", "tree_method": "hist",
        "learning_rate": 0.03, "max_depth": 4, "min_child_weight": 5,
        "subsample": 0.75, "colsample_bytree": 0.8, "lambda": 8.0, "alpha": 0.1,
    }
    uncertainty_rounds = 350
    for fold_id, (train_idx, test_idx) in enumerate(
        GroupKFold(n_splits=N_FOLDS).split(raca_x, absolute_error, groups), start=1
    ):
        prep = build_preprocessor(uncertainty_numeric, categorical)
        train_matrix = prep.fit_transform(raca_x.iloc[train_idx])
        test_matrix = prep.transform(raca_x.iloc[test_idx])
        model = build_model(uncertainty_params, uncertainty_rounds)
        model.fit(train_matrix, np.log1p(absolute_error[train_idx]), verbose=False)
        scale_oof[test_idx] = np.maximum(np.expm1(model.predict(test_matrix)), 0.01)
        fold[test_idx] = fold_id

    conformity = absolute_error / scale_oof
    n = len(conformity)
    quantile_level = min(1.0, np.ceil((n + 1) * nominal_coverage) / n)
    calibration_multiplier = float(np.quantile(conformity, quantile_level, method="higher"))
    half_width = calibration_multiplier * scale_oof
    raca_interval = point_oof.copy()
    raca_interval["predicted_absolute_error"] = scale_oof
    raca_interval["calibrated_half_width_90"] = half_width
    raca_interval["lower_90"] = np.maximum(0, raca_interval.predicted_SOC_pct - half_width)
    raca_interval["upper_90"] = raca_interval.predicted_SOC_pct + half_width
    raca_interval["uncertainty_fold"] = fold
    raca_interval.to_csv(out / "raca_uncertainty_oof_predictions.csv", index=False)

    final_prep = build_preprocessor(uncertainty_numeric, categorical)
    raca_matrix = final_prep.fit_transform(raca_x)
    final_model = build_model(uncertainty_params, uncertainty_rounds)
    final_model.fit(raca_matrix, np.log1p(absolute_error), verbose=False)
    joblib.dump(final_prep, out / "uncertainty_preprocessor.joblib")
    final_model.save_model(out / "uncertainty_xgboost.json")

    dsp_x = dsp[features].copy()
    dsp_x["point_prediction"] = dsp_point.predicted_SOC_pct.to_numpy(float)
    dsp_scale = np.maximum(np.expm1(final_model.predict(final_prep.transform(dsp_x))), 0.01)
    dsp_half_width = calibration_multiplier * dsp_scale
    dsp_interval = dsp_point.copy()
    dsp_interval["predicted_absolute_error"] = dsp_scale
    dsp_interval["calibrated_half_width_90"] = dsp_half_width
    dsp_interval["lower_90"] = np.maximum(0, dsp_interval.predicted_SOC_pct - dsp_half_width)
    dsp_interval["upper_90"] = dsp_interval.predicted_SOC_pct + dsp_half_width
    dsp_interval.to_csv(out / "dsp4sh_uncertainty_external_predictions.csv", index=False)

    raca_pixel = uncertainty_pixel_depth_aggregate(raca_interval)
    dsp_pixel = uncertainty_pixel_depth_aggregate(dsp_interval)
    raca_pixel.to_csv(out / "raca_uncertainty_pixel_depth.csv", index=False)
    dsp_pixel.to_csv(out / "dsp4sh_uncertainty_pixel_depth.csv", index=False)
    metrics = pd.DataFrame([
        interval_metric_row(raca_interval, "RaCA grouped cross-fit — rows"),
        interval_metric_row(raca_pixel, "RaCA grouped cross-fit — 250m pixel × 10cm depth"),
        interval_metric_row(dsp_interval, "DSP4SH external — rows"),
        interval_metric_row(dsp_pixel, "DSP4SH external — 250m pixel × 10cm depth"),
    ])
    metrics.to_csv(out / "uncertainty_performance.csv", index=False)
    depth_metrics = []
    for label, frame in [("RaCA grouped cross-fit", raca_interval), ("DSP4SH external", dsp_interval)]:
        frame = frame.assign(depth_group=np.where(frame.z_mid < 30, "0–30 cm", ">30 cm"))
        for depth_group, group in frame.groupby("depth_group"):
            row = interval_metric_row(group, label)
            row["depth_group"] = depth_group
            depth_metrics.append(row)
    depth_metrics = pd.DataFrame(depth_metrics)
    depth_metrics.to_csv(out / "uncertainty_depth_performance.csv", index=False)

    run_manifest = {
        "target": "absolute SOC percent error from grouped OOF point predictions",
        "training_dataset": "RaCA only",
        "external_evaluation_dataset": "DSP4SH; never used for fitting or calibration",
        "nominal_coverage": nominal_coverage,
        "method": "grouped cross-fit heteroscedastic absolute-error XGBoost plus conformal multiplier",
        "calibration_multiplier": calibration_multiplier,
        "finite_sample_quantile_level": quantile_level,
        "training_rows": len(raca),
        "training_sites": int(raca.rcasiteid.nunique()),
        "features": uncertainty_features,
        "categorical_features": categorical,
        "xgboost_params": uncertainty_params,
        "num_boost_round": uncertainty_rounds,
        "metrics": metrics.to_dict(orient="records"),
        "provenance": provenance,
        "point_model_manifest": str(required[2].resolve()),
        "xgboost_version": xgb.__version__,
    }
    (out / "run_manifest.json").write_text(json.dumps(run_manifest, indent=2))
    return {
        "metrics": metrics,
        "depth_metrics": depth_metrics,
        "manifest": run_manifest,
        "raca": raca_interval,
        "dsp4sh": dsp_interval,
    }


def train_bulk_density_uncertainty(project: Path | None = None, nominal_coverage: float = 0.90) -> dict:
    """Calibrate RaCA-only bulk-density intervals from saved grouped OOF errors."""
    project = project or project_dir()
    base = legacy_dir(project) / "bd_model_evaluation"
    out = project / "model_artifacts" / "bulk_density_uncertainty"
    point_out = project / "model_artifacts" / "bulk_density"
    out.mkdir(parents=True, exist_ok=True)
    point_out.mkdir(parents=True, exist_ok=True)
    manifest_path = base / "bulk_density_final_model_manifest.json"
    raca_path = base / "raca_bulk_density_oof_predictions.csv"
    dsp_path = base / "dsp_bulk_density_external_predictions.csv"
    model_path = base / "bulk_density_final_model.json"
    manifest = json.loads(manifest_path.read_text())
    features = manifest["features"]
    categorical = manifest["categorical_features"]
    numeric = [f for f in features if f not in categorical]
    required = list(dict.fromkeys(features + [
        "Measure_BD", "predicted_Measure_BD", "rcasiteid", "final_lat", "final_lon", "z_mid"
    ]))
    dsp_required = list(dict.fromkeys(features + [
        "Measure_BD", "predicted_Measure_BD", "DSP_Pedon", "DSP_Pedon_ID",
        "final_lat", "final_lon", "z_mid"
    ]))
    raca = pd.read_csv(raca_path, usecols=lambda c: c in required, low_memory=False)
    dsp = pd.read_csv(dsp_path, usecols=lambda c: c in dsp_required, low_memory=False)
    raca = raca.loc[raca.Measure_BD.notna() & raca.rcasiteid.notna()].reset_index(drop=True)
    dsp = dsp.loc[dsp.Measure_BD.notna()].reset_index(drop=True)

    x = raca[features].copy()
    x["point_prediction"] = raca.predicted_Measure_BD.to_numpy(float)
    uncertainty_features = features + ["point_prediction"]
    uncertainty_numeric = numeric + ["point_prediction"]
    error = np.abs(raca.Measure_BD.to_numpy(float) - raca.predicted_Measure_BD.to_numpy(float))
    groups = raca.rcasiteid.astype(str).to_numpy()
    scale_oof = np.full(len(raca), np.nan)
    params = {
        "objective": "reg:squarederror", "eval_metric": "rmse", "tree_method": "hist",
        "learning_rate": 0.03, "max_depth": 4, "min_child_weight": 8,
        "subsample": 0.75, "colsample_bytree": 0.8, "lambda": 8.0, "alpha": 0.1,
    }
    rounds = 350
    for train_idx, test_idx in GroupKFold(n_splits=N_FOLDS).split(x, error, groups):
        prep = build_preprocessor(uncertainty_numeric, categorical)
        model = build_model(params, rounds)
        model.fit(prep.fit_transform(x.iloc[train_idx]), np.log1p(error[train_idx]), verbose=False)
        scale_oof[test_idx] = np.maximum(np.expm1(model.predict(prep.transform(x.iloc[test_idx]))), 0.005)
    conformity = error / scale_oof
    n = len(conformity)
    q_level = min(1.0, np.ceil((n + 1) * nominal_coverage) / n)
    multiplier = float(np.quantile(conformity, q_level, method="higher"))

    final_prep = build_preprocessor(uncertainty_numeric, categorical)
    final_model = build_model(params, rounds)
    final_model.fit(final_prep.fit_transform(x), np.log1p(error), verbose=False)
    joblib.dump(final_prep, out / "uncertainty_preprocessor.joblib")
    final_model.save_model(out / "uncertainty_xgboost.json")
    # Copy the independently verified point model and its contract into this project.
    (point_out / "bulk_density_xgboost.json").write_bytes(model_path.read_bytes())
    (point_out / "run_manifest.json").write_text(json.dumps(manifest, indent=2))

    def add_intervals(frame, scale):
        result = frame.copy()
        half = multiplier * scale
        result["observed_SOC_pct"] = result.Measure_BD
        result["predicted_SOC_pct"] = result.predicted_Measure_BD
        result["predicted_absolute_error"] = scale
        result["lower_90"] = np.maximum(0, result.predicted_Measure_BD - half)
        result["upper_90"] = result.predicted_Measure_BD + half
        return result

    raca_interval = add_intervals(raca, scale_oof)
    dsp_x = dsp[features].copy()
    dsp_x["point_prediction"] = dsp.predicted_Measure_BD.to_numpy(float)
    dsp_scale = np.maximum(np.expm1(final_model.predict(final_prep.transform(dsp_x))), 0.005)
    dsp_interval = add_intervals(dsp, dsp_scale)
    raca_interval[["rcasiteid", "final_lat", "final_lon", "z_mid", "Measure_BD",
                   "predicted_Measure_BD", "predicted_absolute_error", "lower_90", "upper_90"]].to_csv(
        out / "raca_uncertainty_oof_predictions.csv", index=False)
    dsp_interval[["DSP_Pedon", "DSP_Pedon_ID", "final_lat", "final_lon", "z_mid", "Measure_BD",
                  "predicted_Measure_BD", "predicted_absolute_error", "lower_90", "upper_90"]].to_csv(
        out / "dsp4sh_uncertainty_external_predictions.csv", index=False)
    metrics = pd.DataFrame([
        interval_metric_row(raca_interval, "RaCA grouped cross-fit — rows"),
        interval_metric_row(dsp_interval, "DSP4SH external — rows"),
    ])
    metrics.to_csv(out / "uncertainty_performance.csv", index=False)
    run = {
        "target": "absolute bulk-density error from grouped OOF predictions",
        "target_units": "g cm-3", "training_dataset": "RaCA only",
        "nominal_coverage": nominal_coverage, "calibration_multiplier": multiplier,
        "finite_sample_quantile_level": q_level, "features": uncertainty_features,
        "categorical_features": categorical, "xgboost_params": params,
        "num_boost_round": rounds, "metrics": metrics.to_dict(orient="records"),
        "point_model_manifest": str((point_out / "run_manifest.json").resolve()),
        "point_model": str((point_out / "bulk_density_xgboost.json").resolve()),
    }
    (out / "run_manifest.json").write_text(json.dumps(run, indent=2))
    return {"metrics": metrics, "manifest": run}


def train_additional_target_uncertainty(
    target: str, project: Path | None = None, nominal_coverage: float = 0.90
) -> dict:
    """Train point and uncertainty models for bulk density or SOC density."""
    project = project or project_dir()
    base = legacy_dir(project)
    configs = {
        "bulk_density": {
            "column": "Measure_BD", "units": "g cm-3", "valid": "BD_valid_basic",
            "features_file": base / "Measure_BD_num_requested_feature_set.csv",
            "dsp_filter_max": 2.0, "rounds": 550,
        },
        "soc_density": {
            "column": "SOC_density", "units": "g cm-3", "valid": "SOC_density_valid",
            "features_file": base / "SOC_density_requested_feature_set.csv",
            "dsp_filter_max": None, "rounds": 500,
        },
    }
    if target not in configs:
        raise ValueError(f"target must be one of {sorted(configs)}")
    cfg = configs[target]
    features = pd.read_csv(cfg["features_file"])["feature"].tolist()
    categorical = [f for f in ["LRR_group", "LU_scraped", "NLCD_name"] if f in features]
    numeric = [f for f in features if f not in categorical]
    source_dir = base / "dataset2_feature_outputs"
    common = features + [cfg["column"], cfg["valid"], "final_lat", "final_lon", "z_mid"]
    raca_cols = list(dict.fromkeys(common + ["rcasiteid"]))
    dsp_cols = list(dict.fromkeys(common + ["DSP_Pedon", "DSP_Pedon_ID"]))
    raca = pd.read_csv(
        source_dir / "raca_use_dataset2_features.csv",
        usecols=lambda c: c in raca_cols, low_memory=False,
    )
    dsp = pd.read_csv(
        source_dir / "dsp_use_dataset2_features.csv",
        usecols=lambda c: c in dsp_cols, low_memory=False,
    )
    for frame in [raca, dsp]:
        frame[cfg["column"]] = pd.to_numeric(frame[cfg["column"]], errors="coerce")
    raca = raca.loc[
        raca[cfg["valid"]].fillna(False).astype(bool)
        & raca[cfg["column"]].notna() & raca.rcasiteid.notna()
    ].reset_index(drop=True)
    dsp_mask = dsp[cfg["valid"]].fillna(False).astype(bool) & dsp[cfg["column"]].notna()
    if cfg["dsp_filter_max"] is not None:
        dsp_mask &= dsp[cfg["column"]].le(cfg["dsp_filter_max"])
    dsp = dsp.loc[dsp_mask].reset_index(drop=True)
    missing = sorted((set(features) - set(raca.columns)) | (set(features) - set(dsp.columns)))
    if missing:
        raise ValueError(f"Missing {target} features: {missing}")

    out = project / "model_artifacts" / target
    unc_out = project / "model_artifacts" / f"{target}_uncertainty"
    out.mkdir(parents=True, exist_ok=True)
    unc_out.mkdir(parents=True, exist_ok=True)
    point_params = {
        "objective": "reg:squarederror", "eval_metric": "rmse", "tree_method": "hist",
        "learning_rate": 0.03, "max_depth": 5, "min_child_weight": 3,
        "subsample": 0.75, "colsample_bytree": 0.8, "lambda": 5.0, "alpha": 0.1,
    }
    X, y = raca[features], raca[cfg["column"]].to_numpy(float)
    groups = raca.rcasiteid.astype(str).to_numpy()
    point_oof = np.full(len(raca), np.nan)
    point_fold = np.zeros(len(raca), int)
    splits = list(GroupKFold(n_splits=N_FOLDS).split(X, y, groups))
    for fold_id, (train_idx, test_idx) in enumerate(splits, 1):
        prep = build_preprocessor(numeric, categorical)
        model = build_model(point_params, cfg["rounds"])
        model.fit(prep.fit_transform(X.iloc[train_idx]), np.log1p(y[train_idx]), verbose=False)
        point_oof[test_idx] = np.maximum(np.expm1(model.predict(prep.transform(X.iloc[test_idx]))), 0)
        point_fold[test_idx] = fold_id

    point_prep = build_preprocessor(numeric, categorical)
    point_model = build_model(point_params, cfg["rounds"])
    point_model.fit(point_prep.fit_transform(X), np.log1p(y), verbose=False)
    joblib.dump(point_prep, out / "point_preprocessor.joblib")
    point_model.save_model(out / "point_xgboost.json")
    dsp_pred = np.maximum(np.expm1(point_model.predict(point_prep.transform(dsp[features]))), 0)

    raca_point = raca[["rcasiteid", "final_lat", "final_lon", "z_mid"]].copy()
    raca_point["observed"] = y
    raca_point["predicted"] = point_oof
    raca_point["fold"] = point_fold
    dsp_point = dsp[["DSP_Pedon", "DSP_Pedon_ID", "final_lat", "final_lon", "z_mid"]].copy()
    dsp_point["observed"] = dsp[cfg["column"]].to_numpy(float)
    dsp_point["predicted"] = dsp_pred
    raca_point.to_csv(out / "raca_oof_predictions.csv", index=False)
    dsp_point.to_csv(out / "dsp4sh_external_predictions.csv", index=False)
    point_metrics = pd.DataFrame([
        metric_row(y, point_oof, "RaCA grouped OOF"),
        metric_row(dsp_point.observed, dsp_point.predicted, "DSP4SH external"),
    ])
    point_metrics.to_csv(out / "performance.csv", index=False)

    unc_features = features + ["point_prediction"]
    unc_numeric = numeric + ["point_prediction"]
    unc_x = X.copy()
    unc_x["point_prediction"] = point_oof
    absolute_error = np.abs(y - point_oof)
    scale_oof = np.full(len(raca), np.nan)
    unc_params = dict(point_params, max_depth=4, min_child_weight=5, **{"lambda": 8.0})
    for train_idx, test_idx in splits:
        prep = build_preprocessor(unc_numeric, categorical)
        model = build_model(unc_params, 350)
        model.fit(prep.fit_transform(unc_x.iloc[train_idx]), np.log1p(absolute_error[train_idx]), verbose=False)
        scale_oof[test_idx] = np.maximum(np.expm1(model.predict(prep.transform(unc_x.iloc[test_idx]))), 1e-4)
    conformity = absolute_error / scale_oof
    q_level = min(1.0, np.ceil((len(conformity) + 1) * nominal_coverage) / len(conformity))
    multiplier = float(np.quantile(conformity, q_level, method="higher"))

    unc_prep = build_preprocessor(unc_numeric, categorical)
    unc_model = build_model(unc_params, 350)
    unc_model.fit(unc_prep.fit_transform(unc_x), np.log1p(absolute_error), verbose=False)
    joblib.dump(unc_prep, unc_out / "uncertainty_preprocessor.joblib")
    unc_model.save_model(unc_out / "uncertainty_xgboost.json")
    dsp_unc_x = dsp[features].copy()
    dsp_unc_x["point_prediction"] = dsp_pred
    dsp_scale = np.maximum(np.expm1(unc_model.predict(unc_prep.transform(dsp_unc_x))), 1e-4)

    # Optional external scaling for the operational BD map. This does not alter
    # point predictions or the RaCA calibration; it widens only mapped bands.
    mapping_multiplier = multiplier
    if target == "bulk_density":
        dsp_errors = np.abs(dsp_point.observed.to_numpy(float) - dsp_point.predicted.to_numpy(float))
        dsp_scores = dsp_errors / dsp_scale
        dsp_q = min(1.0, np.ceil((len(dsp_scores) + 1) * nominal_coverage) / len(dsp_scores))
        mapping_multiplier = float(np.quantile(dsp_scores, dsp_q, method="higher"))

    def add_intervals(frame, scale, interval_multiplier):
        result = frame.copy()
        result["predicted_absolute_error"] = scale
        result["half_width_90"] = interval_multiplier * scale
        result["lower_90"] = np.maximum(0, result.predicted - result.half_width_90)
        result["upper_90"] = result.predicted + result.half_width_90
        return result

    raca_interval = add_intervals(raca_point, scale_oof, multiplier).rename(
        columns={"observed": "observed_SOC_pct", "predicted": "predicted_SOC_pct"}
    )
    dsp_interval = add_intervals(dsp_point, dsp_scale, multiplier).rename(
        columns={"observed": "observed_SOC_pct", "predicted": "predicted_SOC_pct"}
    )
    raca_interval.to_csv(unc_out / "raca_uncertainty_oof_predictions.csv", index=False)
    dsp_interval.to_csv(unc_out / "dsp4sh_uncertainty_external_predictions.csv", index=False)
    unc_metrics = pd.DataFrame([
        interval_metric_row(raca_interval, "RaCA grouped cross-fit"),
        interval_metric_row(dsp_interval, "DSP4SH external"),
    ])
    unc_metrics.to_csv(unc_out / "uncertainty_performance.csv", index=False)
    mapping_raca = add_intervals(raca_point, scale_oof, mapping_multiplier).rename(
        columns={"observed": "observed_SOC_pct", "predicted": "predicted_SOC_pct"}
    )
    mapping_dsp = add_intervals(dsp_point, dsp_scale, mapping_multiplier).rename(
        columns={"observed": "observed_SOC_pct", "predicted": "predicted_SOC_pct"}
    )
    mapping_metrics = pd.DataFrame([
        interval_metric_row(mapping_raca, "RaCA with operational mapping multiplier"),
        interval_metric_row(mapping_dsp, "DSP4SH used for operational interval scaling"),
    ])
    mapping_metrics.to_csv(unc_out / "mapping_interval_performance.csv", index=False)
    manifest = {
        "target": target, "target_column": cfg["column"], "units": cfg["units"],
        "training_dataset": "RaCA only", "external_dataset": "DSP4SH evaluation only",
        "features": features, "uncertainty_features": unc_features,
        "categorical_features": categorical, "training_rows": len(raca),
        "training_sites": int(raca.rcasiteid.nunique()), "external_rows": len(dsp),
        "nominal_coverage": nominal_coverage,
        "calibration_multiplier": multiplier,
        "mapping_calibration_multiplier": mapping_multiplier,
        "mapping_scale_factor_over_raca": mapping_multiplier / multiplier,
        "point_metrics": point_metrics.to_dict(orient="records"),
        "uncertainty_metrics": unc_metrics.to_dict(orient="records"),
        "mapping_interval_metrics": mapping_metrics.to_dict(orient="records"),
        "warning": "Bulk-density map intervals are widened using DSP4SH to obtain approximately 90% empirical DSP coverage. DSP4SH is therefore not independent validation for these mapped intervals, and the point model still has poor DSP transfer."
        if target == "bulk_density" else None,
    }
    (unc_out / "run_manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / "run_manifest.json").write_text(json.dumps(manifest, indent=2))
    return {"point_metrics": point_metrics, "uncertainty_metrics": unc_metrics, "manifest": manifest}
